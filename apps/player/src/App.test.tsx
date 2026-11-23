import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { EMPTY_LIBRARY } from './media/library';
import { PlaybackProvider } from './media/playback';
import { StreamingPage } from './media/StreamingPage';
import { reloadSettings } from './settings';
import { strings } from './strings';

const root = document.documentElement;

const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const nav = () => screen.getByRole('navigation', { name: strings.nav.label });

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: strings.account.defaultName }));
  await user.click(screen.getByRole('menuitem', { name: strings.account.settings }));
  return screen.getByRole('dialog', { name: strings.account.settings });
}

// The setup clears localStorage before each test; the settings module must read it again.
beforeEach(() => reloadSettings());

describe('App', () => {
  it('opens on the player, with the five pages in the drawer', () => {
    render(<App />);
    const labels: string[] = Object.values(strings.pages).map((p) => p.label);
    expect(within(nav()).getAllByRole('button').map((b) => b.textContent).filter((t) => labels.includes(t ?? ''))).toEqual(labels);
    expect(heading()).toBe(strings.pages.player.label);
    expect(screen.getByText(strings.pages.player.empty)).toBeTruthy();
    // A browser can't open files from the computer: it says so instead of offering the button.
    expect(screen.queryByRole('button', { name: strings.player.open })).toBeNull();
    expect(screen.getByText(strings.player.browserHint)).toBeTruthy();
  });

  it('changes page from the drawer: the title and the page follow', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(nav()).getByRole('button', { name: strings.pages.music.label }));
    expect(heading()).toBe(strings.pages.music.label);
    expect(within(nav()).getByRole('button', { name: strings.pages.music.label }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('section.is-active')?.textContent).toContain(strings.library.noFolders);
  });

  it('asks for a folder on Music and Streaming while the library has none', async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const page of [strings.pages.music.label, strings.pages.streaming.label]) {
      await user.click(within(nav()).getByRole('button', { name: page }));
      const active = document.querySelector('section.is-active') as HTMLElement;
      expect(within(active).getByText(strings.library.noFolders)).toBeTruthy();
      // A browser can't reach the computer's folders: it says so instead of offering the button.
      expect(within(active).getByText(strings.library.browserOnly)).toBeTruthy();
    }
  });

  it('shows Streaming as views: Home first, then Movies, Series and Clips', async () => {
    const user = userEvent.setup();
    render(
      <PlaybackProvider>
        <StreamingPage library={{ ...EMPTY_LIBRARY, roots: ['D:\\Films'] }} />
      </PlaybackProvider>,
    );
    const views = screen.getByRole('radiogroup', { name: strings.streaming.viewsLabel });
    expect(within(views).getAllByRole('radio').map((r) => r.textContent)).toEqual(Object.values(strings.streaming.views).map((v) => v.label));
    expect(screen.getByText(strings.streaming.views.home.empty)).toBeTruthy();
    await user.click(within(views).getByRole('radio', { name: strings.streaming.views.clips.label }));
    expect(screen.getByText(strings.streaming.views.clips.empty)).toBeTruthy();
  });

  it('starts on the page set in Settings → General', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    const dialog = await openSettings(user);
    expect(within(dialog).getByRole('tab', { selected: true }).textContent).toBe(strings.settings.tabs.general.label);
    await user.click(within(dialog).getByRole('combobox', { name: strings.general.startOn }));
    await user.click(screen.getByRole('option', { name: strings.general.startPages.streaming }));
    first.unmount();
    render(<App />);
    expect(heading()).toBe(strings.pages.streaming.label);
  });

  it('starts on the player when it was opened with files, whatever the setting says', () => {
    localStorage.setItem('pastelmedia_settings', JSON.stringify({ startOn: 'music' }));
    reloadSettings();
    render(<App launchedWithFiles />);
    expect(heading()).toBe(strings.pages.player.label);
  });

  it('starts on the last page when asked to, and on the player before there is one', async () => {
    localStorage.setItem('pastelmedia_settings', JSON.stringify({ startOn: 'last' }));
    reloadSettings();
    const user = userEvent.setup();
    const first = render(<App />);
    expect(heading()).toBe(strings.pages.player.label);
    await user.click(within(nav()).getByRole('button', { name: strings.pages.playlists.label }));
    first.unmount();
    render(<App />);
    expect(heading()).toBe(strings.pages.playlists.label);
  });

  it('hides Streaming when it is switched off, and leaves it for the player if it was open', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(within(nav()).getByRole('button', { name: strings.pages.streaming.label }));
    const dialog = await openSettings(user);
    await user.click(within(dialog).getByRole('switch', { name: new RegExp(`^${strings.general.showStreaming}`) }));
    expect(within(nav()).queryByRole('button', { name: strings.pages.streaming.label })).toBeNull();
    expect(heading()).toBe(strings.pages.player.label);
  });

  it('never starts on a hidden Streaming tab', () => {
    localStorage.setItem('pastelmedia_settings', JSON.stringify({ startOn: 'streaming', showStreaming: false }));
    reloadSettings();
    render(<App />);
    expect(heading()).toBe(strings.pages.player.label);
  });

  it('follows a settings change made in another window', () => {
    render(<App />);
    act(() => {
      localStorage.setItem('pastelmedia_settings', JSON.stringify({ showStreaming: false }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'pastelmedia_settings' }));
    });
    expect(within(nav()).queryByRole('button', { name: strings.pages.streaming.label })).toBeNull();
  });

  it('changes the look from Appearance at once, and remembers it on the device', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: strings.account.defaultName }));
    await user.click(screen.getByRole('menuitem', { name: strings.account.appearance }));
    const dialog = screen.getByRole('dialog', { name: strings.account.appearance });
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Moonlight blue' }));
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.getPropertyValue('--ps-accent')).toBe('#6095FA');
    expect(localStorage.getItem('pastelmedia_theme_cache')).toBe('dark');
    expect(localStorage.getItem('pastelmedia_accent_cache')).toBe('moonlight-blue');
  });

  it('starts in Solar Lime, following the system, on a first run', () => {
    render(<App />);
    expect(localStorage.getItem('pastelmedia_accent_cache')).toBe('solar-lime');
    expect(localStorage.getItem('pastelmedia_theme_cache')).toBe('system');
  });

  it('shows Settings as tabs; the ones still to come say what they will hold', async () => {
    const user = userEvent.setup();
    render(<App />);
    const dialog = await openSettings(user);
    const tabs = Object.values(strings.settings.tabs);
    expect(within(dialog).getAllByRole('tab').map((t) => t.textContent)).toEqual(tabs.map((t) => t.label));
    await user.click(within(dialog).getByRole('tab', { name: strings.settings.tabs.library.label }));
    expect(within(dialog).getByRole('tabpanel').textContent).toBe(strings.library.browserOnly);
    await user.click(within(dialog).getByRole('tab', { name: strings.settings.tabs.playback.label }));
    expect(within(dialog).getByRole('tabpanel').textContent).toBe(strings.settings.tabs.playback.empty);
  });

  it('says that more profiles come later when Switch profile is picked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: strings.account.defaultName }));
    await user.click(screen.getByRole('menuitem', { name: strings.account.switchProfile }));
    expect(screen.getByRole('status').textContent).toContain(strings.account.switchProfileLater);
  });

  it('has no window controls or mini player button in a browser', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: strings.topBar.openMini })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Minimize' })).toBeNull();
    expect(screen.getByRole('button', { name: strings.topBar.help })).toBeTruthy();
  });
});
