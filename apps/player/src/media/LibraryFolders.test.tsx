import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { LibraryFoldersSettings } from './LibraryFolders';

type Win = typeof window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

/** Pretends to be the desktop app: Tauri's invoke answers `library_folders` with `folders`. */
function desktop(folders: { path: string; found: boolean }[]) {
  (window as Win).__TAURI_INTERNALS__ = {
    invoke: (cmd) => (cmd === 'library_folders' ? Promise.resolve(folders) : Promise.reject(new Error(cmd))),
  };
}

afterEach(() => {
  delete (window as Win).__TAURI_INTERNALS__;
});

describe('Settings → Library', () => {
  // The tab crashed the whole window while its list loaded (reported 2026-11-23).
  it('opens while the folders load, then lists them with a way to stop reading each', async () => {
    desktop([
      { path: 'E:\\Música', found: true },
      { path: 'E:\\Videos', found: true },
    ]);
    render(<LibraryFoldersSettings />);
    expect(screen.getByRole('button', { name: strings.library.add })).toBeTruthy();
    expect(await screen.findByText('E:\\Música')).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.remove('E:\\Videos') })).toBeTruthy();
  });

  it('marks a folder that is gone, and still lets you stop reading it', async () => {
    desktop([{ path: 'F:\\Unplugged', found: false }]);
    render(<LibraryFoldersSettings />);
    expect(await screen.findByText(strings.library.gone)).toBeTruthy();
    expect(screen.getByRole('button', { name: strings.library.remove('F:\\Unplugged') })).toBeTruthy();
  });

  it('opens with no folders yet', async () => {
    desktop([]);
    render(<LibraryFoldersSettings />);
    expect(await screen.findByText(strings.library.foldersLabel)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
