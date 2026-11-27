import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { EMPTY_LIBRARY, type LibTrack, type Library } from './library';
import { MusicPage } from './MusicPage';
import { PlaybackProvider } from './playback';
import { PlaylistDialogs } from './PlaylistActions';
import { addToPlaylist, createPlaylist, loadPlaylists, resetPlaylists, setPlaylistSongs, type Playlist } from './playlists';
import { PlaylistsPage } from './PlaylistsPage';

let n = 0;
const song = (title: string, artist: string, album: string): LibTrack => ({
  id: `t${n++}`,
  title,
  artist,
  album,
  number: null,
  disc: null,
  year: null,
  duration: 200,
  path: `D:/Music/${artist}/${album}/${title}.mp3`,
  unplayable: false,
  addedAt: 10,
});
const lights = song('Northern Lights', 'Aurora Collective', 'Polar Nights');
const melt = song('Meltwater', 'Aurora Collective', 'Polar Nights');
const tide = song('Low Tide', 'Marta Vey', 'Low Tide');
const LIBRARY: Library = {
  ...EMPTY_LIBRARY,
  roots: ['D:/Music'],
  tracks: [lights, melt, tide],
  albums: [
    { id: 'a0', title: 'Polar Nights', artist: 'Aurora Collective', year: null, trackIds: [lights.id, melt.id] },
    { id: 'a1', title: 'Low Tide', artist: 'Marta Vey', year: null, trackIds: [tide.id] },
  ],
};

const stored = () => JSON.parse(window.localStorage.getItem('pastelmedia_playlists') ?? '[]') as Playlist[];
const rows = () => within(screen.getByRole('list', { name: 'Road trip' })).getAllByRole('listitem').map((li) => li.querySelector('.ps-track-info-title')?.textContent);

function open(page: 'playlists' | 'music' = 'playlists') {
  const user = userEvent.setup();
  render(
    <PlaybackProvider>
      <PlaylistDialogs>{page === 'music' ? <MusicPage library={LIBRARY} /> : <PlaylistsPage library={LIBRARY} />}</PlaylistDialogs>
    </PlaybackProvider>,
  );
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  resetPlaylists();
});

describe('The playlists', () => {
  it('keeps each song once, in the order given, on the device between visits (the web version)', async () => {
    const road = await createPlaylist(' Road trip ', '', [tide.path, lights.path]);
    expect(road).toMatchObject({ name: 'Road trip', paths: [tide.path, lights.path] });
    expect(await addToPlaylist(road.id, [lights.path, melt.path])).toBe(1);
    await setPlaylistSongs(road.id, [melt.path, tide.path]);
    expect(stored()[0].paths).toEqual([melt.path, tide.path]);
    resetPlaylists();
    await loadPlaylists();
    expect(await addToPlaylist(road.id, [melt.path])).toBe(0);
  });
});

describe('The Playlists page', () => {
  it('starts empty, and makes a playlist from its dialog', async () => {
    const user = open();
    expect(screen.getByText(strings.pages.playlists.empty)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: strings.playlists.new }));
    const dialog = screen.getByRole('dialog', { name: strings.playlists.newTitle });
    expect(within(dialog).getByRole('button', { name: strings.playlists.create })).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByRole('textbox', { name: strings.playlists.name }), 'Road trip');
    await user.click(within(dialog).getByRole('button', { name: strings.playlists.create }));
    const tile = await screen.findByRole('button', { name: /Road trip/ });
    expect(tile.textContent).toContain(strings.playlists.songs(0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a playlist; its search adds songs, and a song leaves from its menu', async () => {
    await createPlaylist('Road trip', 'For the long way', [tide.path]);
    const user = open();
    await user.click(await screen.findByRole('button', { name: /Road trip/ }));
    expect(screen.getByRole('heading', { name: 'Road trip' })).toBeTruthy();
    expect(rows()).toEqual(['Low Tide']);

    await user.type(screen.getByRole('combobox', { name: strings.playlists.addSongs }), 'nor');
    await user.click(screen.getByRole('option', { name: /Northern Lights/ }));
    await waitFor(() => expect(rows()).toEqual(['Low Tide', 'Northern Lights']));
    // A song already in it is not offered again
    await user.type(screen.getByRole('combobox', { name: strings.playlists.addSongs }), 'low');
    expect(screen.queryByRole('option', { name: /Low Tide/ })).toBeNull();

    await user.click(screen.getAllByRole('button', { name: /Low Tide/ }).find((b) => b.getAttribute('aria-haspopup') === 'menu')!);
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.remove }));
    await waitFor(() => expect(rows()).toEqual(['Northern Lights']));
    expect(stored()[0].paths).toEqual([lights.path]);
  });

  it('renames and deletes a playlist from its own menu', async () => {
    await createPlaylist('Road trip', '', [tide.path]);
    const user = open();
    await user.click(await screen.findByRole('button', { name: /Road trip/ }));
    const more = () => within(document.querySelector('.ps-album-header') as HTMLElement).getAllByRole('button').find((b) => b.getAttribute('aria-haspopup') === 'menu')!;
    await user.click(more());
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.rename }));
    const name = within(screen.getByRole('dialog', { name: strings.playlists.editTitle })).getByRole('textbox', { name: strings.playlists.name });
    await user.clear(name);
    await user.type(name, 'Long way home');
    await user.click(screen.getByRole('button', { name: strings.playlists.save }));
    expect(await screen.findByRole('heading', { name: 'Long way home' })).toBeTruthy();

    await user.click(more());
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.delete }));
    await user.click(within(screen.getByRole('dialog', { name: strings.playlists.deleteTitle })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(strings.pages.playlists.empty)).toBeTruthy();
    expect(stored()).toEqual([]);
  });
});

describe('Add to playlist, from Music', () => {
  it('adds a song from its menu to a playlist, or to a new one', async () => {
    const road = await createPlaylist('Road trip');
    const user = open('music');
    await user.click(screen.getByRole('radio', { name: strings.music.views.songs }));
    const menuOf = (title: RegExp) => screen.getAllByRole('button', { name: title }).find((b) => b.getAttribute('aria-haspopup') === 'menu')!;
    await user.click(menuOf(/Meltwater/));
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.addTo }));
    await user.click(screen.getByRole('menuitem', { name: 'Road trip' }));
    await waitFor(() => expect(stored().find((p) => p.id === road.id)?.paths).toEqual([melt.path]));

    await user.click(menuOf(/Low Tide/));
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.addTo }));
    await user.click(screen.getByRole('menuitem', { name: strings.playlists.newMenu }));
    await user.type(screen.getByRole('textbox', { name: strings.playlists.name }), 'Evenings');
    await user.click(screen.getByRole('button', { name: strings.playlists.create }));
    await waitFor(() => expect(stored().find((p) => p.name === 'Evenings')?.paths).toEqual([tide.path]));
  });
});
