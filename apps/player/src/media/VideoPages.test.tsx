import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { EMPTY_LIBRARY, type LibVideo, type Library } from './library';
import { PlaybackProvider } from './playback';
import { StreamingPage } from './StreamingPage';

let n = 0;
const video = (title: string, more: Partial<LibVideo> = {}): LibVideo => ({
  id: `v${n++}`,
  title,
  year: null,
  season: null,
  episode: null,
  episodeTitle: null,
  fileName: `${title}.mkv`,
  path: `D:\\Videos\\${title}.mkv`,
  ...more,
});

const ep = (season: number, episode: number, episodeTitle: string | null = null) =>
  video('Dark', { season, episode, episodeTitle, fileName: `Dark.S0${season}E0${episode}.mkv` });

const LIBRARY: Library = {
  ...EMPTY_LIBRARY,
  roots: ['D:\\Videos'],
  movies: [video('Heat', { year: 1995, fileName: 'Heat (1995).mkv' })],
  series: [{ id: 's0', title: 'Dark', episodes: [ep(0, 1, 'Behind the scenes'), ep(1, 1, 'Secrets'), ep(1, 2), ep(2, 1, 'Beginnings and Endings')] }],
};

function open(view: 'movies' | 'series') {
  const user = userEvent.setup();
  render(
    <PlaybackProvider>
      <StreamingPage library={LIBRARY} />
    </PlaybackProvider>,
  );
  return user.click(screen.getByRole('radio', { name: strings.streaming.views[view].label })).then(() => user);
}

describe('Streaming title pages', () => {
  it('opens a film on its title page, with Play and a way back', async () => {
    const user = await open('movies');
    await user.click(screen.getByRole('button', { name: /Heat/ }));
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(screen.getByText('1995')).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.videos.play })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: strings.videos.allMovies }));
    expect(screen.getByRole('list', { name: strings.streaming.views.movies.label })).toBeTruthy();
  });

  it('opens a series on its first season, with its episodes and the other seasons to pick', async () => {
    const user = await open('series');
    const tiles = within(screen.getByRole('list', { name: strings.streaming.views.series.label })).getAllByRole('button');
    expect(tiles).toHaveLength(1);
    await user.click(tiles[0]);
    expect(screen.getByRole('heading', { name: 'Dark' })).toBeTruthy();
    expect(screen.getByText(strings.videos.seasons(2))).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.videos.playFrom(1, 1) })).toBeTruthy();
    const episodes = () => within(screen.getByRole('region', { name: /^Season|^Specials/ })).getAllByRole('listitem').map((li) => li.textContent);
    expect(episodes()[0]).toContain(strings.videos.episodeRow(1, 'Secrets'));
    expect(episodes()[1]).toContain(strings.videos.episodeRow(2, null));

    await user.click(screen.getByRole('combobox', { name: strings.videos.seasonLabel }));
    await user.click(screen.getByRole('option', { name: strings.videos.season(2) }));
    expect(episodes()).toHaveLength(1);
    expect(episodes()[0]).toContain('Beginnings and Endings');
  });
});
