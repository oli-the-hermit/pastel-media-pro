import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettings, reloadSettings } from '../settings';
import { strings } from '../strings';
import { resetJobsForTests, type Place } from './import/api';
import { LibraryFoldersSettings } from './LibraryFolders';

type Win = typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };

const place = (id: number, path: string, more: Partial<Place> = {}): Place => ({ id, path, found: true, files: 10, missing: 0, preset: 'everything', lastScanAt: 1, ...more });

/** Pretends to be the desktop app: Tauri's invoke answers `places_list` with `list`, and records the calls. */
function desktop(list: Place[]) {
  const calls: [string, unknown][] = [];
  (window as Win).__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'places_list') return Promise.resolve(list);
      if (cmd === 'places_remove') return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    },
  };
  return calls;
}

beforeEach(() => {
  reloadSettings();
  resetJobsForTests();
});

afterEach(() => {
  delete (window as Win).__TAURI_INTERNALS__;
});

describe('Settings → Library', () => {
  // The tab crashed the whole window while its list loaded (reported 2026-11-23).
  it('opens while the folders load, then lists them with their files, Check for changes and Remove', async () => {
    desktop([place(1, 'E:\\Música', { files: 1520, preset: 'music' }), place(2, 'E:\\Videos', { files: 40, missing: 2, preset: 'movies' })]);
    render(<LibraryFoldersSettings />);
    expect(screen.getByRole('button', { name: strings.library.add })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.addFiles })).toBeTruthy();
    expect(await screen.findByText('E:\\Música')).toBeTruthy();
    expect(screen.getByText(strings.library.folderFacts(40, 2, strings.library.presets.movies))).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.rescan('Videos') })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.remove('E:\\Videos') })).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.rescanAll })).toBeTruthy();
  });

  it('marks a folder that is gone, and still lets you remove it', async () => {
    const calls = desktop([place(7, 'F:\\Unplugged', { found: false })]);
    render(<LibraryFoldersSettings />);
    expect(await screen.findByText(strings.library.gone)).toBeTruthy();
    expect((screen.getByRole('button', { name: strings.library.rescan('Unplugged') }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: strings.library.remove('F:\\Unplugged') }));
    expect(calls).toContainEqual(['places_remove', { placeId: 7 }]);
  });

  it('turns the list of files found back on', async () => {
    desktop([]);
    localStorage.setItem('pastelmedia_settings', JSON.stringify({ showReview: false }));
    reloadSettings();
    render(<LibraryFoldersSettings />);
    expect(await screen.findByText(strings.library.foldersLabel)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: new RegExp(strings.library.showReview) }));
    expect(getSettings().showReview).toBe(true);
  });
});
