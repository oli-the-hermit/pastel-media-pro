import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { recordPlay, resetHistory } from './history';
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
  path: `D:/Videos/${title}-${n}.mkv`,
  ...more,
});

const heat = video('Heat', { year: 1995, duration: 10200, addedAt: 30 });
const ronin = video('Ronin', { year: 1998, duration: 7300, addedAt: 20 });
const jamboo = video('Coco Jamboo', { year: 1996, duration: 215, addedAt: 10 });
const [e1, e2, e3] = [1, 2, 3].map((e) => video('Dark', { season: e < 3 ? 1 : 2, episode: e < 3 ? e : 1, duration: 3000, addedAt: 5 }));
const LIBRARY: Library = {
  ...EMPTY_LIBRARY,
  roots: ['D:/Videos'],
  movies: [heat, ronin, jamboo],
  series: [{ id: 's0', title: 'Dark', episodes: [e1, e2, e3] }],
};

const home = strings.streaming.home;
const row = (name: string) => screen.getByRole('region', { name });
const titles = (list: HTMLElement) => within(list).getAllByRole('button').filter((b) => b.classList.contains('ps-title-tile')).map((b) => b.querySelector('.ps-title-tile-title')?.textContent);
const section = (user: ReturnType<typeof userEvent.setup>, name: 'movies' | 'series' | 'clips') =>
  user.click(screen.getByRole('radio', { name: strings.streaming.views[name].label }));

function open() {
  const user = userEvent.setup();
  render(
    <PlaybackProvider>
      <StreamingPage library={LIBRARY} />
    </PlaybackProvider>,
  );
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  resetHistory();
});

describe('Streaming', () => {
  it('opens on Home: a banner, then what is new and what was never watched', () => {
    open();
    const banner = row(home.banner);
    expect(within(banner).getByText(home.reasons.new)).toBeTruthy();
    expect(within(banner).getByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(titles(row(home.newFilms))).toEqual(['Heat', 'Ronin']);
    expect(titles(row(home.newSeries))).toEqual(['Dark']);
    expect(titles(row(home.unwatched))).toEqual(['Dark', 'Ronin', 'Heat']);
    expect(screen.queryByRole('region', { name: home.continuing })).toBeNull();
  });

  it('puts a film left part-way first; Details opens its page, and Back returns to Home', async () => {
    recordPlay(heat.path, 900, 10200, false, true);
    const user = open();
    expect(within(row(home.continuing)).getByRole('button', { name: /Heat.*left/ })).toBeTruthy();
    const banner = row(home.banner);
    expect(within(banner).getByText(home.reasons.continue)).toBeTruthy();
    expect(within(banner).getByRole('button', { name: strings.videos.resumeShort })).toBeTruthy();

    await user.click(within(banner).getByRole('button', { name: home.details }));
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.videos.resume('15:00') })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.videos.startOver })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: strings.videos.backHome }));
    expect(document.activeElement).toBe(within(row(home.banner)).getByRole('button', { name: home.details }));
  });

  it('narrows a shelf by what was watched, and keeps clips on their own shelf', async () => {
    recordPlay(heat.path, 900, 10200, false, true);
    recordPlay(ronin.path, 7300, 7300, true, true);
    const user = open();
    await section(user, 'movies');
    const films = () => titles(screen.getByRole('list', { name: strings.streaming.views.movies.label }));
    expect(films()).toEqual(['Heat', 'Ronin']);
    await user.click(screen.getByRole('radio', { name: strings.streaming.watch.progress }));
    expect(films()).toEqual(['Heat']);
    await user.click(screen.getByRole('radio', { name: strings.streaming.watch.watched }));
    expect(films()).toEqual(['Ronin']);
    await user.click(screen.getByRole('radio', { name: strings.streaming.watch.unwatched }));
    expect(screen.getByText(strings.streaming.nothingFound(''))).toBeTruthy();

    await section(user, 'clips');
    expect(titles(screen.getByRole('list', { name: strings.streaming.views.clips.label }))).toEqual(['Coco Jamboo']);
  });

  it('sorts a shelf, by the order picked', async () => {
    const user = open();
    await section(user, 'movies');
    const films = () => titles(screen.getByRole('list', { name: strings.streaming.views.movies.label }));
    await user.click(screen.getByRole('button', { name: strings.lists.sortedBy(strings.streaming.sorts.az) }));
    await user.click(screen.getByRole('menuitemradio', { name: strings.streaming.sorts.year }));
    expect(films()).toEqual(['Ronin', 'Heat']);
  });

  it('searches every shelf from Home, and one shelf from its own section', async () => {
    const user = open();
    await user.type(screen.getByRole('combobox', { name: strings.streaming.search }), 'co');
    expect(titles(row(strings.streaming.kinds.clip))).toEqual(['Coco Jamboo']);
    expect(screen.queryByRole('region', { name: home.banner })).toBeNull();
    expect(screen.queryByRole('region', { name: strings.streaming.kinds.film })).toBeNull();

    await user.clear(screen.getByRole('combobox', { name: strings.streaming.search }));
    await user.type(screen.getByRole('combobox', { name: strings.streaming.search }), 'ron');
    expect(titles(row(strings.streaming.kinds.film))).toEqual(['Ronin']);
    await section(user, 'movies');
    expect(titles(screen.getByRole('list', { name: strings.streaming.views.movies.label }))).toEqual(['Ronin']);
  });

  it('goes on with a series at its next episode', async () => {
    recordPlay(e1.path, 3000, 3000, true, true);
    recordPlay(e2.path, 600, 3000, false, true);
    const user = open();
    await section(user, 'series');
    await user.click(screen.getByRole('button', { name: /Dark/ }));
    expect(screen.getByRole('button', { name: strings.videos.resumeFrom(1, 2) })).toBeTruthy();
    const episodes = within(screen.getByRole('region', { name: strings.videos.season(1) })).getAllByRole('listitem').map((li) => li.textContent);
    expect(episodes[0]).toContain(strings.videos.watched);
    expect(episodes[1]).toContain('left');
  });
});
