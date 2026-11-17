import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { strings } from './strings';

const root = document.documentElement;

describe('App', () => {
  it('opens on Home, with the six pages in the drawer', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: strings.nav.label });
    const pages = Object.values(strings.pages).map((p) => p.label);
    for (const label of pages) expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.pages.home.label);
    expect(screen.getByText(strings.pages.home.empty)).toBeTruthy();
  });

  it('changes page from the drawer: the title and the page follow', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: strings.pages.music.label }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.pages.music.label);
    expect(screen.getByRole('button', { name: strings.pages.music.label }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText(strings.pages.music.empty).closest('section')?.className).toContain('is-active');
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

  it('shows Settings as tabs, each with what it will hold', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: strings.account.defaultName }));
    await user.click(screen.getByRole('menuitem', { name: strings.account.settings }));
    const dialog = screen.getByRole('dialog', { name: strings.account.settings });
    const tabs = Object.values(strings.settings.tabs);
    expect(within(dialog).getAllByRole('tab').map((t) => t.textContent)).toEqual(tabs.map((t) => t.label));
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
