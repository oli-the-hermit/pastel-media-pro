import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { EMPTY_LIBRARY, type LibAlbum, type LibTrack, type Library } from './library';
import { MusicPage } from './MusicPage';
import { PlaybackProvider } from './playback';

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
  path: `D:/Music/${title}.mp3`,
  unplayable: false,
});
const album = (id: string, title: string, artist: string, tracks: LibTrack[]): LibAlbum => ({ id, title, artist, year: null, trackIds: tracks.map((t) => t.id) });

const lights = song('Northern Lights', 'Aurora Collective', 'Polar Nights');
const tide = song('Low Tide', 'Marta Vey', 'Low Tide');
const demo = song('Demo 3', 'Marta Vey', '');
const stray = song('Untitled', '', '');
const LIBRARY: Library = {
  ...EMPTY_LIBRARY,
  roots: ['D:/Music'],
  tracks: [lights, tide, demo, stray],
  albums: [album('a0', 'Polar Nights', 'Aurora Collective', [lights]), album('a1', 'Low Tide', 'Marta Vey', [tide]), album('a2', '', 'Marta Vey', [demo]), album('a3', '', '', [stray])],
};

function open() {
  const user = userEvent.setup();
  render(
    <PlaybackProvider>
      <MusicPage library={LIBRARY} />
    </PlaybackProvider>,
  );
  return user;
}
const view = (name: string) => screen.getByRole('radio', { name });
const tiles = () => [...document.querySelectorAll('.ps-title-tile-title')].map((el) => el.textContent);

describe('Music', () => {
  it('opens on the albums, with the songs that have no album as one entry', () => {
    open();
    expect(view(strings.music.views.albums).getAttribute('aria-checked')).toBe('true');
    expect(tiles()).toEqual(['Low Tide', 'Polar Nights', strings.music.noAlbum]);
  });

  it('lists the songs, and remembers the view', async () => {
    const user = open();
    await user.click(view(strings.music.views.songs));
    const list = screen.getByRole('list', { name: strings.music.views.songs });
    expect(within(list).getByText('Northern Lights')).toBeTruthy();
    expect(within(list).getByText('Demo 3')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('pastelmedia_music_view')!)).toBe('songs');
  });

  it('searches what the view lists, and says when nothing is found', async () => {
    const user = open();
    const search = screen.getByRole('combobox', { name: strings.music.search });
    await user.type(search, 'polar');
    expect(tiles()).toEqual(['Polar Nights']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText(strings.music.nothingFound('zzz'))).toBeTruthy();
  });

  it('opens an artist, then one of their albums, and comes back the same way', async () => {
    const user = open();
    await user.click(view(strings.music.views.artists));
    expect(tiles()).toEqual(['Aurora Collective', 'Marta Vey', strings.music.unknownArtist]);
    await user.click(screen.getByText('Marta Vey'));
    expect(screen.getByRole('heading', { name: 'Marta Vey' })).toBeTruthy();
    expect(screen.getByText(strings.music.artistFacts(1, 2))).toBeTruthy();
    // Their album, and their song that has none
    expect(tiles()).toEqual(['Low Tide']);
    expect(within(screen.getByRole('list', { name: strings.music.noAlbum })).getByText('Demo 3')).toBeTruthy();

    await user.click(screen.getByText('Low Tide', { selector: '.ps-title-tile-title' }));
    await user.click(screen.getByRole('button', { name: 'Marta Vey' }));
    expect(screen.getByRole('heading', { name: 'Marta Vey' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: strings.music.allArtists }));
    expect(view(strings.music.views.artists).getAttribute('aria-checked')).toBe('true');
  });
});
