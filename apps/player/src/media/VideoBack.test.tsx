import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { reloadSettings } from '../settings';
import { strings } from '../strings';
import type { LibVideo, Library } from './library';

// A library with one film and one series, in place of the one read from the desktop app.
vi.mock('./library', async (original) => {
  const real = await original<typeof import('./library')>();
  const video = (id: string, title: string, more: Partial<LibVideo> = {}): LibVideo => ({
    id,
    title,
    year: null,
    season: null,
    episode: null,
    episodeTitle: null,
    fileName: `${title}.mkv`,
    path: `D:/Videos/${title}.mkv`,
    ...more,
  });
  const library: Library = {
    ...real.EMPTY_LIBRARY,
    roots: ['D:/Videos'],
    movies: [video('m1', 'Heat', { year: 1995 })],
    series: [{ id: 's1', title: 'Dark', episodes: [video('e1', 'Dark', { season: 1, episode: 1, episodeTitle: 'Secrets' })] }],
  };
  return { ...real, useLibrary: () => library };
});

const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const nav = () => screen.getByRole('navigation', { name: strings.nav.label });
const player = () => document.querySelector<HTMLElement>('.ps-video-player');

beforeEach(() => {
  reloadSettings();
  // jsdom has neither: the video view measures its picture's box, and the browser engine plays an element.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
});

async function openStreaming(view: 'movies' | 'series') {
  const user = userEvent.setup();
  render(<App />);
  await user.click(within(nav()).getByRole('button', { name: strings.pages.streaming.label }));
  await user.click(screen.getByRole('radio', { name: strings.streaming.views[view].label }));
  return user;
}

describe('The video’s Back button', () => {
  it('returns to the film’s title page it was played from', async () => {
    const user = await openStreaming('movies');
    await user.click(screen.getByText('Heat'));
    await user.click(screen.getByRole('button', { name: strings.videos.play }));
    expect(heading()).toBe(strings.pages.player.label);
    expect(player()).toBeTruthy();

    await user.click(within(player()!).getByRole('button', { name: 'Back' }));
    expect(player()).toBeNull();
    expect(heading()).toBe(strings.pages.streaming.label);
    // The same title page, still open, with its way back to the films.
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.videos.allMovies })).toBeTruthy();
  });

  it('returns to the series’ page an episode was played from', async () => {
    const user = await openStreaming('series');
    await user.click(screen.getByText('Dark'));
    await user.click(screen.getByText(strings.videos.episodeRow(1, 'Secrets')));
    expect(heading()).toBe(strings.pages.player.label);

    await user.click(within(player()!).getByRole('button', { name: 'Back' }));
    expect(heading()).toBe(strings.pages.streaming.label);
    expect(screen.getByRole('button', { name: strings.videos.allSeries })).toBeTruthy();
    expect(screen.getByText(strings.videos.episodeRow(1, 'Secrets'))).toBeTruthy();
  });

  it('stays on the page picked in the drawer when the video is left that way', async () => {
    const user = await openStreaming('movies');
    await user.click(screen.getByText('Heat'));
    await user.click(screen.getByRole('button', { name: strings.videos.play }));
    await user.click(within(nav()).getByRole('button', { name: strings.pages.music.label }));
    expect(player()).toBeNull();
    expect(heading()).toBe(strings.pages.music.label);
  });

  it('fills the page and waits solid, with nothing see-through, until the picture is up', async () => {
    const user = await openStreaming('movies');
    await user.click(screen.getByText('Heat'));
    await user.click(screen.getByRole('button', { name: strings.videos.play }));
    expect(player()!.className).toContain('ps-video-player--fill');
    expect(document.querySelector('.mp-video')!.className).not.toContain('has-picture');
    expect(document.documentElement.classList.contains('mp-video-on')).toBe(false);
    expect(document.querySelector('.ps-app-shell')!.getAttribute('data-surface')).toBe('solid');
  });
});
