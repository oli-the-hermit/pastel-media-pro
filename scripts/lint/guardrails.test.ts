// @vitest-environment node
// The lint guardrails (eslint.config.js) fire where they should and stay quiet elsewhere.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../..', import.meta.url)) });

async function messages(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  // Import rules prefix their own sentence; keep the guardrail's message.
  return result.messages.map((m) => m.message.replace(/^.* is restricted from being used by a pattern\. /, ''));
}

const APP = 'apps/player/src/Example.tsx';

describe('lint guardrails', () => {
  it('keeps each workspace behind its package name', async () => {
    expect(await messages("import { x } from '../../../packages/media-core/src/x';\nexport const y = x;\n", APP))
      .toContain('Import another workspace by its package name, not by a path into it.');
    expect(await messages("import { x } from '../../../apps/player/src/x';\nexport const y = x;\n", 'packages/media-core/src/y.ts'))
      .toContain('Import another workspace by its package name, not by a path into it.');
  });

  it('uses the design system through its entry points only', async () => {
    expect(await messages("import { Button } from '@pastel-studio/react/src/components/Button';\nexport const B = Button;\n", APP))
      .toContain('Use the design system through its entry points (@pastel-studio/react).');
    expect(await messages("import { Button } from '@pastel-studio/react';\nexport const B = Button;\n", APP)).toEqual([]);
  });

  it('allows raw controls only in media-ui', async () => {
    const code = "export const A = () => <button type=\"button\" />;\n";
    expect((await messages(code, APP)).some((m) => m.startsWith('Use the component'))).toBe(true);
    expect(await messages(code, 'packages/media-ui/src/A.tsx')).toEqual([]);
  });

  it('keeps the library classes inside the library', async () => {
    expect(await messages('export const A = () => <div className="ps-card" />;\n', APP))
      .toContain('ps-* classes belong to the design system. Use the component, or give it a prop.');
    expect(await messages('export const A = () => <div className="player-page" />;\n', APP)).toEqual([]);
  });

  it('keeps words in strings.ts', async () => {
    expect(await messages('export const A = () => <p>Hello there</p>;\n', APP)).toContain('Move user-facing text to strings.ts.');
    expect(await messages("export const items = [{ label: 'Music' }];\n", 'apps/player/src/pages.ts'))
      .toContain('Move user-facing text to strings.ts.');
    expect(await messages("export const strings = { label: 'Music' };\n", 'apps/player/src/strings.ts')).toEqual([]);
  });
});
