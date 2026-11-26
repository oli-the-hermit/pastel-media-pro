import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from '../../package.json';
import { strings } from '../strings';
import { AboutView } from './AboutView';

afterEach(() => vi.unstubAllGlobals());

describe('AboutView', () => {
  it('shows the version and the LGPL note', () => {
    render(<AboutView />);
    expect(screen.getByText(strings.about.version(version))).toBeTruthy();
    expect(screen.getByText(strings.about.libmpv)).toBeTruthy();
  });

  it('opens and closes the shipped notices', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('libmpv and FFmpeg'));
    vi.stubGlobal('fetch', fetchMock);
    render(<AboutView />);
    const button = screen.getByRole('button', { name: strings.about.showNotices });
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledWith('licenses/third-party-notices.txt');
    expect(await screen.findByText('libmpv and FFmpeg')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(button);
    expect(screen.queryByText('libmpv and FFmpeg')).toBeNull();
  });

  it('says where the text is when it cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    render(<AboutView />);
    await userEvent.click(screen.getByRole('button', { name: strings.about.showLgpl }));
    expect(await screen.findByText(strings.about.textMissing)).toBeTruthy();
  });
});
