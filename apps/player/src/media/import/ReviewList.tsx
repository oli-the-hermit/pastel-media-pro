import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, EmptyState, ProgressBar, SegmentedControl, Select, formatBytes, formatTime } from '@pastel-studio/react';
import { strings } from '../../strings';
import type { Fact, Found } from './api';
import { change, passes, PRESETS, tier, type Filters, type MediaKind, type Preset } from './filters';

/** A row of the review list: what discovery found, and what the quick probe has said about it so far. */
export interface Row extends Found {
  duration: number | null;
  width: number | null;
  height: number | null;
}

export const toRow = (f: Found): Row => ({ ...f, duration: null, width: null, height: null });

export function withFacts(rows: Row[], facts: Fact[]): void {
  for (const f of facts) {
    const r = rows[f.i];
    if (r) Object.assign(r, { duration: f.duration, width: f.width, height: f.height });
  }
}

export interface ReviewStatus {
  /** The walk is still going. */
  listing: boolean;
  /** Rows the quick probe has done. */
  probed: number;
  /** The probe is over. */
  done: boolean;
}

export interface ReviewChoice {
  files: string[];
  skipped: string[];
  filters: Filters;
}

interface ReviewListProps {
  rows: Row[];
  /** Grows with each batch, so the list follows the discovery. */
  version: number;
  status: ReviewStatus;
  initialFilters: Filters;
  /** The folder belongs to a place already. */
  inside: string | null;
  showList: boolean;
  onShowListChange: (show: boolean) => void;
  onImport: (choice: ReviewChoice) => void;
  onCancel: () => void;
}

const ROW_HEIGHT = 40;
const OVERSCAN = 8;

const PRESET_OPTIONS = (['movies', 'music', 'everything'] as const).map((value) => ({ value, label: strings.library.presets[value] }));
const optionsOf = (words: Record<string, string>) => Object.entries(words).map(([value, label]) => ({ value, label }));
const pick = (v: string) => (v === 'any' ? null : Number(v));
const valueOf = (n: number | null) => (n == null ? 'any' : String(n));

function picture(r: Row): string {
  const t = tier(r);
  return t == null ? strings.review.unknown : strings.review.lines(t);
}

/**
 * The review list (ux.md §2b): every file found, with live filters and presets, rows to check or uncheck, and
 * "Add N". Composed from the design system's pieces (Select, SegmentedControl, Checkbox) until its DataTable,
 * range Slider and chips exist (decided 2026-11-24). Only the rows in view are drawn, so a folder of thousands of
 * files scrolls smoothly.
 */
export function ReviewList({ rows, version, status, initialFilters, inside, showList, onShowListChange, onImport, onCancel }: ReviewListProps) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [hideInLibrary, setHideInLibrary] = useState(true);
  // Rows checked or unchecked by hand, by index; the others follow the filters (and an earlier review's choice).
  const [manual, setManual] = useState<Map<number, boolean>>(() => new Map());
  const set = (patch: Partial<Filters>) => setFilters((f) => change(f, patch));

  const extensions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.ext, (counts.get(r.ext) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // `version` tells that `rows` grew in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, version]);

  const shown = useMemo(
    () => rows.filter((r) => !(hideInLibrary && r.inLibrary) && passes(filters, r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, version, filters, hideInLibrary],
  );
  const isChecked = useCallback((r: Row) => manual.get(r.i) ?? !r.skipped, [manual]);
  const toAdd = shown.filter((r) => isChecked(r) && !r.inLibrary);
  const checkedCount = shown.filter(isChecked).length;
  const allChecked = shown.length > 0 && checkedCount === shown.length;

  const toggle = (r: Row, on: boolean) => setManual((m) => new Map(m).set(r.i, on));
  const toggleAll = (on: boolean) =>
    setManual((m) => {
      const next = new Map(m);
      for (const r of shown) next.set(r.i, on);
      return next;
    });

  // Only the rows in view are drawn.
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const measure = () => {
    const el = listRef.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight });
  };
  useEffect(measure, []);
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  const kinds = filters.kinds?.length === 1 ? filters.kinds[0] : 'both';
  const percent = rows.length > 0 ? Math.round((status.probed / rows.length) * 100) : 0;
  const presetOptions = filters.preset === 'custom' ? [...PRESET_OPTIONS, { value: 'custom' as const, label: strings.library.presets.custom }] : PRESET_OPTIONS;

  return (
    <div className="mp-review">
      {inside ? <p className="mp-note">{strings.review.inside(inside)}</p> : undefined}
      <div className="mp-review-filters">
        <SegmentedControl<Preset>
          options={presetOptions}
          value={filters.preset}
          onChange={(p) => p !== 'custom' && setFilters(PRESETS[p])}
          ariaLabel={strings.review.keep}
        />
        <div className="mp-review-selects">
          <Select
            ariaLabel={strings.review.type}
            value={kinds}
            options={optionsOf(strings.review.types)}
            onChange={(k) => set({ kinds: k === 'both' ? null : [k as MediaKind] })}
          />
          <Select ariaLabel={strings.review.length} value={valueOf(filters.minDuration)} options={optionsOf(strings.review.lengths)} onChange={(v) => set({ minDuration: pick(v) })} />
          <Select ariaLabel={strings.review.size} value={valueOf(filters.minBytes)} options={optionsOf(strings.review.sizes)} onChange={(v) => set({ minBytes: pick(v) })} />
          <Select ariaLabel={strings.review.picture} value={valueOf(filters.minHeight)} options={optionsOf(strings.review.pictures)} onChange={(v) => set({ minHeight: pick(v) })} />
        </div>
        <div className="mp-review-checks">
          <label>
            <Checkbox checked={filters.skipExtras} onChange={(skipExtras) => set({ skipExtras })} />
            {strings.review.skipExtras}
          </label>
          <label>
            <Checkbox checked={hideInLibrary} onChange={setHideInLibrary} />
            {strings.review.hideInLibrary}
          </label>
        </div>
        {extensions.length > 1 ? (
          <div className="mp-review-checks" role="group" aria-label={strings.review.fileTypes}>
            {extensions.map(([ext, n]) => (
              <label key={ext}>
                <Checkbox
                  checked={!filters.extensions || filters.extensions.includes(ext)}
                  onChange={(on) => {
                    const all = extensions.map(([e]) => e);
                    const current = filters.extensions ?? all;
                    const next = on ? [...current, ext] : current.filter((e) => e !== ext);
                    set({ extensions: next.length === all.length ? null : next });
                  }}
                />
                {strings.review.fileType(ext, n)}
              </label>
            ))}
          </div>
        ) : undefined}
      </div>

      <div className="mp-review-status" aria-live="polite">
        <span>{status.listing ? strings.review.finding(rows.length) : strings.review.found(rows.length)}</span>
        {!status.listing && rows.length > 0 ? <span>{strings.review.shown(shown.length, checkedCount)}</span> : undefined}
        {!status.done && !status.listing ? <span>{strings.review.probing(percent)}</span> : undefined}
      </div>
      {!status.done ? <ProgressBar value={status.listing ? 0 : percent} status={status.listing ? 'starting' : 'processing'} label={strings.review.listLabel} /> : undefined}

      <div className="mp-review-table" role="table" aria-label={strings.review.listLabel} aria-rowcount={shown.length + 1}>
        <div className="mp-review-row mp-review-head" role="row" aria-rowindex={1}>
          <span role="columnheader" className="mp-review-check">
            <Checkbox checked={allChecked} mixed={checkedCount > 0 && !allChecked} onChange={toggleAll} aria-label={strings.review.checkAll} disabled={shown.length === 0} />
          </span>
          <span role="columnheader">{strings.review.columns.name}</span>
          <span role="columnheader">{strings.review.columns.type}</span>
          <span role="columnheader" className="mp-review-num">{strings.review.columns.length}</span>
          <span role="columnheader" className="mp-review-num">{strings.review.columns.size}</span>
          <span role="columnheader" className="mp-review-num">{strings.review.columns.picture}</span>
        </div>
        <div className="mp-review-body" ref={listRef} onScroll={measure}>
          {shown.length === 0 ? (
            <EmptyState>{status.listing ? strings.review.finding(rows.length) : rows.length === 0 ? strings.review.nothingFound : strings.review.nothingShown}</EmptyState>
          ) : (
            <div style={{ height: shown.length * ROW_HEIGHT, position: 'relative' }}>
              {shown.slice(first, last).map((r, k) => {
                const folder = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '';
                return (
                  <div
                    key={r.i}
                    role="row"
                    aria-rowindex={first + k + 2}
                    className={r.inLibrary ? 'mp-review-row is-in-library' : 'mp-review-row'}
                    style={{ position: 'absolute', top: (first + k) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
                  >
                    <span role="cell" className="mp-review-check">
                      <Checkbox checked={isChecked(r)} onChange={(on) => toggle(r, on)} aria-label={strings.review.check(r.name)} />
                    </span>
                    <span role="cell" className="mp-review-name" title={r.rel}>
                      <span className="mp-review-file">{r.name}</span>
                      <span className="mp-review-folder">{r.inLibrary ? strings.review.inLibrary : folder}</span>
                    </span>
                    <span role="cell">{strings.review.kinds[r.kind]}</span>
                    <span role="cell" className="mp-review-num">{r.duration != null ? formatTime(r.duration) : strings.review.unknown}</span>
                    <span role="cell" className="mp-review-num">{formatBytes(r.size)}</span>
                    <span role="cell" className="mp-review-num">{r.kind === 'video' ? picture(r) : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="mp-review-footer">
        <label>
          <Checkbox checked={showList} onChange={onShowListChange} />
          {strings.review.showList}
        </label>
        <div className="mp-review-actions">
          <Button onClick={onCancel}>{strings.review.cancel}</Button>
          <Button
            variant="primary"
            disabled={toAdd.length === 0 || status.listing}
            onClick={() =>
              onImport({
                files: toAdd.map((r) => r.path),
                skipped: shown.filter((r) => !isChecked(r)).map((r) => r.path),
                filters,
              })
            }
          >
            {strings.review.import(toAdd.length)}
          </Button>
        </div>
      </div>
    </div>
  );
}
