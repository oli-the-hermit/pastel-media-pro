import { afterEach, describe, expect, it } from 'vitest';
import { shortcutFor, type KeyLike } from './shortcuts';

afterEach(() => {
  document.body.innerHTML = '';
});

function key(k: string, target: EventTarget | null = document.body, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, target, ...mods };
}

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector('[data-t]')!;
}

describe('shortcutFor', () => {
  it('maps the player keys on the page', () => {
    expect(shortcutFor(key(' '))).toBe('toggle');
    expect(shortcutFor(key('K'))).toBe('toggle');
    expect(shortcutFor(key('ArrowLeft'))).toBe('back');
    expect(shortcutFor(key('ArrowRight'))).toBe('forward');
    expect(shortcutFor(key('ArrowUp'))).toBe('louder');
    expect(shortcutFor(key('ArrowDown'))).toBe('quieter');
    expect(shortcutFor(key('m'))).toBe('mute');
    expect(shortcutFor(key('n'))).toBe('next');
    expect(shortcutFor(key('p'))).toBe('previous');
    expect(shortcutFor(key('x'))).toBeNull();
  });

  it('leaves typing, dialogs and modified keys alone', () => {
    expect(shortcutFor(key('k', el('<input data-t />')))).toBeNull();
    expect(shortcutFor(key('m', el('<div role="dialog"><span data-t></span></div>')))).toBeNull();
    expect(shortcutFor(key('k', document.body, { ctrlKey: true }))).toBeNull();
  });

  it('lets a focused control keep Space and the arrows', () => {
    const button = el('<button data-t>Play</button>');
    expect(shortcutFor(key(' ', button))).toBeNull();
    expect(shortcutFor(key('ArrowRight', button))).toBeNull();
    expect(shortcutFor(key('k', button))).toBe('toggle');
    expect(shortcutFor(key('ArrowLeft', el('<div tabindex="0" data-t></div>')))).toBeNull();
  });
});
