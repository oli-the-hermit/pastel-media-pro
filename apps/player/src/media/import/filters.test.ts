import { describe, expect, it } from 'vitest';
import cases from './filter-cases.json';
import { change, isExtra, passes, PRESETS, type Candidate, type Filters } from './filters';

describe('import filters (the cases the rescan passes too)', () => {
  it('know extras by name and folder', () => {
    for (const c of cases.extras) expect(isExtra(c.rel), c.rel).toBe(c.extra);
  });

  it('pass the shared cases', () => {
    for (const c of cases.cases) {
      const f = ('preset' in c && c.preset ? cases.presets[c.preset as keyof typeof cases.presets] : (c as { filters: unknown }).filters) as Filters;
      expect(passes(f, c.file as Candidate), c.name).toBe(c.passes);
    }
  });

  it('are the same presets as the cases file', () => {
    for (const [key, preset] of Object.entries(PRESETS)) expect(preset).toEqual(cases.presets[key as keyof typeof cases.presets]);
  });

  it('turn custom on a change and back into a preset when they match one', () => {
    const custom = change(PRESETS.movies, { minDuration: 300 });
    expect(custom.preset).toBe('custom');
    expect(change(custom, { minDuration: 1200 })).toEqual(PRESETS.movies);
  });
});
