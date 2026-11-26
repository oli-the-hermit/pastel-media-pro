/**
 * The desktop app's import (Rust `import.rs`): the folder and file dialogs, discovery (rows streamed over a Tauri
 * `Channel`), import jobs and the places. The queue's rows are a small store fed by the `import://job` event, so
 * every view (the card, the top bar's indicator) shows the same jobs.
 */
import { useSyncExternalStore } from 'react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../../strings';
import { libraryChanged } from '../library';
import type { Filters, MediaKind } from './filters';

async function core() {
  return import('@tauri-apps/api/core');
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await core()).invoke<T>(cmd, args);
}

/** A file found by discovery: one row of the review list. */
export interface Found {
  i: number;
  path: string;
  /** Below the folder, with `/`. */
  rel: string;
  name: string;
  ext: string;
  kind: MediaKind;
  size: number;
  /** Already in the library. */
  inLibrary: boolean;
  /** Unchecked in an earlier review of this folder. */
  skipped: boolean;
}

/** The quick probe's answer for one row (S8): `null` where the header said nothing. */
export interface Fact {
  i: number;
  duration: number | null;
  width: number | null;
  height: number | null;
}

export type DiscoverEvent =
  | { type: 'found'; files: Found[] }
  | { type: 'listed'; total: number; ms: number }
  | { type: 'probed'; facts: Fact[] }
  | { type: 'done'; ms: number };

export interface DiscoverStart {
  id: number;
  folder: string | null;
  /** The folder is a place already: its saved filters. */
  filters: Filters | null;
  /** The place it belongs to, when it is a folder inside one. */
  inside: string | null;
}

/** Windows' folder dialog: the folder, or `null` when cancelled. */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>('import_pick_folder', { title: strings.library.addTitle });
}

/** Windows' file dialog: the media files picked (none when cancelled). */
export function pickFiles(): Promise<string[]> {
  return invoke<string[]>('import_pick_files', { title: strings.library.addFilesTitle, audio: strings.player.audioFiles, video: strings.player.videoFiles });
}

/** Finds what's in a folder, or describes some files: `onEvent` gets the rows, then their lengths. */
export async function discover(source: { folder: string } | { files: string[] }, onEvent: (e: DiscoverEvent) => void): Promise<DiscoverStart> {
  const { Channel, invoke: call } = await core();
  const channel = new Channel<DiscoverEvent>();
  channel.onmessage = onEvent;
  return call<DiscoverStart>('import_discover', { ...source, onEvent: channel });
}

export function cancelDiscover(id: number): Promise<void> {
  return invoke('import_discover_cancel', { id });
}

export interface ImportRequest {
  /** A folder becomes a place, rescanned with `filters`; `null` for files added on their own. */
  folder: string | null;
  files: string[];
  /** Unchecked by hand: rescans leave them out. */
  skipped: string[];
  filters: Filters;
  /** No review list: the job finds the folder's files and keeps those that pass. */
  direct?: boolean;
}

/** One row of the import queue (Rust `JobView`). */
export interface Job {
  id: number;
  kind: 'import' | 'rescan';
  /** The folder, shown; `null` for files on their own or a check of every folder. */
  place: string | null;
  state: 'queued' | 'sizing' | 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  done: number;
  totalBytes: number;
  doneBytes: number;
  current: string | null;
  added: number;
  updated: number;
  missing: number;
  /** "name: why", one per file that didn't make it. */
  errors: string[];
  quiet: boolean;
}

export const isOver = (j: Job) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled';

// ---- The queue's store ----

let jobs: Job[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
let listening: Promise<void> | null = null;

function put(job: Job) {
  if (job.quiet) return;
  const i = jobs.findIndex((j) => j.id === job.id);
  jobs = i < 0 ? [...jobs, job] : jobs.map((j) => (j.id === job.id ? job : j));
  notify();
}

/** Starts following the jobs (once): their events, and the library's changes. */
function listen(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  listening ??= (async () => {
    const { listen: on } = await import('@tauri-apps/api/event');
    await on<Job>('import://job', (e) => put(e.payload));
    await on('library://changed', () => libraryChanged());
    jobs = await invoke<Job[]>('import_jobs');
    notify();
  })();
  return listening;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void listen();
  return () => {
    listeners.delete(listener);
  };
}

/** The import queue's rows, newest last. */
export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => jobs, () => jobs);
}

/** Starts an import; its row shows at once. */
export async function startImport(request: ImportRequest): Promise<Job> {
  await listen();
  const job = await invoke<Job>('import_start', { request });
  put(job);
  return job;
}

export async function stopJob(id: number): Promise<void> {
  await invoke('import_stop', { id });
}

export async function retryJob(id: number): Promise<void> {
  const job = await invoke<Job>('import_retry', { id });
  jobs = jobs.filter((j) => j.id !== id);
  put(job);
}

export async function dismissJob(id: number): Promise<void> {
  await invoke('import_dismiss', { id });
  jobs = jobs.filter((j) => j.id !== id);
  notify();
}

export async function clearFinished(): Promise<void> {
  await invoke('import_clear_finished');
  jobs = jobs.filter((j) => !isOver(j));
  notify();
}

// ---- Places (Settings → Library) ----

/** A folder of the library (Rust `PlaceView`). */
export interface Place {
  id: number;
  path: string;
  /** The folder is there now (a drive can be unplugged). */
  found: boolean;
  files: number;
  missing: number;
  preset: string;
  lastScanAt: number | null;
}

export function places(): Promise<Place[]> {
  return isDesktop() ? invoke<Place[]>('places_list') : Promise.resolve([]);
}

export async function rescan(placeId: number | null): Promise<void> {
  await listen();
  put(await invoke<Job>('places_rescan', { placeId }));
}

/** Forgets a folder and its files (the files themselves are untouched). */
export function removePlace(placeId: number): Promise<void> {
  return invoke('places_remove', { placeId });
}

/** For tests: forget the store. */
export function resetJobsForTests(list: Job[] = []) {
  jobs = list;
  listening = Promise.resolve();
  notify();
}
