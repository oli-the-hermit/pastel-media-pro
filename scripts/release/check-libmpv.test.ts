import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLibmpv, readPin, type LibmpvPin } from './check-libmpv';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function pinFor(sha256: string): LibmpvPin {
  return { file: 'libmpv-2.dll', sha256, size: 5, archive: { name: 'a.7z', sha256: 'x', from: 'https://example.test' } };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'libmpv-'));
  dirs.push(dir);
  return dir;
}

describe('checkLibmpv', () => {
  it('passes the pinned DLL', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'libmpv-2.dll'), 'hello');
    // sha256("hello")
    expect(checkLibmpv(dir, pinFor('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'))).toBeNull();
  });

  it('refuses a missing or different DLL and says where the pinned one comes from', () => {
    const dir = tempDir();
    expect(checkLibmpv(dir, pinFor('0'))).toMatch(/is missing\. Extract libmpv-2\.dll from a\.7z/);
    writeFileSync(join(dir, 'libmpv-2.dll'), 'a GPL build');
    expect(checkLibmpv(dir, pinFor('0'))).toMatch(/is not the pinned LGPL build/);
  });

  it('reads the repository pin', () => {
    expect(readPin().sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
