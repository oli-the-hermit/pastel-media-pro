import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { strings } from '../strings';
import { paintCachedTheme } from '../theme';
import { MiniApp } from './MiniApp';

const root = document.documentElement;

describe('MiniApp', () => {
  it('paints in the look the main window remembered, before it renders', () => {
    localStorage.setItem('pastelmedia_theme_cache', 'dark');
    localStorage.setItem('pastelmedia_accent_cache', 'aurora-teal');
    paintCachedTheme();
    expect(root.dataset.theme).toBe('dark');
    const teal = root.style.getPropertyValue('--ps-accent');
    render(<MiniApp />);
    expect(screen.getByText(strings.mini.empty)).toBeTruthy();
    expect(root.style.getPropertyValue('--ps-accent')).toBe(teal);
  });

  it('follows a change made in the main window', () => {
    localStorage.setItem('pastelmedia_theme_cache', 'dark');
    render(<MiniApp />);
    expect(root.dataset.theme).toBe('dark');
    localStorage.setItem('pastelmedia_theme_cache', 'light');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'pastelmedia_theme_cache' }));
    });
    expect(root.dataset.theme).toBe('light');
  });
});
