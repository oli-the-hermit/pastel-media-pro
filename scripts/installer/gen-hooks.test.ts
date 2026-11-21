// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHooks, hooksPath, readLists, TARGETS } from './gen-hooks';

describe('installer hooks', () => {
  it('are up to date with media-extensions.json (run node scripts/installer/gen-hooks.ts)', () => {
    const lists = readLists();
    for (const t of TARGETS) expect(readFileSync(hooksPath(t), 'utf8')).toBe(buildHooks(lists, t));
  });

  it('offer the app for every type without taking any default, and remove exactly what they add', () => {
    const lists = readLists();
    const hooks = buildHooks(lists, TARGETS[0]);
    for (const e of [...lists.audio, ...lists.video]) {
      expect(hooks).toContain(`"Software\\Classes\\.${e}\\OpenWithProgids" "PastelMediaPro.`);
      expect(hooks).toContain(`DeleteRegValue SHCTX "Software\\Classes\\.${e}\\OpenWithProgids"`);
    }
    // A type's default is the unnamed value of its own key: never written.
    expect(hooks).not.toMatch(/WriteRegStr SHCTX "Software\\Classes\\\.[a-z0-9]+" ""/);
  });

  it('keep the test build apart from the real one', () => {
    const lists = readLists();
    const real = buildHooks(lists, TARGETS[0]);
    const test = buildHooks(lists, TARGETS[1]);
    expect(test).toContain('PastelMediaProTest.Video');
    expect(test).not.toContain('PastelMediaPro.Video');
    expect(real).not.toContain('Pastel Media Pro Test');
  });
});
