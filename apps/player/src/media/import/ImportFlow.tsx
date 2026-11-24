import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from '@pastel-studio/react';
import { updateSettings, useSettings } from '../../settings';
import { useNotify } from '../../shell/notify';
import { strings } from '../../strings';
import { cancelDiscover, discover, pickFiles, pickFolder, startImport, type DiscoverEvent } from './api';
import { PRESETS, type Filters, type Preset } from './filters';
import { ReviewList, toRow, withFacts, type ReviewChoice, type ReviewStatus, type Row } from './ReviewList';

/** Where adding starts decides the first preset: Streaming → Movies & series, Music → Music, Settings → Everything. */
export type AddPreset = Exclude<Preset, 'custom'>;

interface ImportFlow {
  /** Windows' folder dialog, then the review list (or straight to the queue when it is switched off). */
  addFolder: (preset: AddPreset) => void;
  /** Windows' file dialog, then the review list (or straight to the queue). */
  addFiles: (preset: AddPreset) => void;
}

const ImportContext = createContext<ImportFlow>({ addFolder: () => {}, addFiles: () => {} });

/** Adding to the library from any page: `addFolder` and `addFiles`. */
export const useImportFlow = () => useContext(ImportContext);

interface Review {
  key: number;
  title: string;
  folder: string | null;
  inside: string | null;
  filters: Filters;
}

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/**
 * The import flow (ux.md §2b): pick a folder or files, then the review list with live filters, then the queue.
 * The review list fills as discovery streams its rows and the quick probe their lengths.
 */
export function ImportProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const showToast = useNotify();
  const [review, setReview] = useState<Review | null>(null);
  const rows = useRef<Row[]>([]);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<ReviewStatus>({ listing: true, probed: 0, done: false });
  const discovery = useRef<number | null>(null);
  const keys = useRef(0);

  const stopDiscovery = useCallback(() => {
    if (discovery.current != null) void cancelDiscover(discovery.current).catch(() => {});
    discovery.current = null;
  }, []);
  useEffect(() => stopDiscovery, [stopDiscovery]);

  const failed = useCallback((e: unknown) => showToast(strings.library.failed(String(e)), 'error'), [showToast]);

  const open = useCallback(
    async (source: { folder: string } | { files: string[] }, preset: AddPreset) => {
      stopDiscovery();
      rows.current = [];
      setStatus({ listing: true, probed: 0, done: false });
      setVersion((v) => v + 1);
      const key = ++keys.current;
      const onEvent = (e: DiscoverEvent) => {
        if (keys.current !== key) return;
        if (e.type === 'found') rows.current.push(...e.files.map(toRow));
        else if (e.type === 'listed') setStatus((s) => ({ ...s, listing: false }));
        else if (e.type === 'probed') {
          withFacts(rows.current, e.facts);
          setStatus((s) => ({ ...s, probed: s.probed + e.facts.length }));
        } else if (e.type === 'done') {
          setStatus((s) => ({ ...s, listing: false, done: true }));
          discovery.current = null;
        }
        setVersion((v) => v + 1);
      };
      const start = await discover(source, onEvent);
      discovery.current = start.id;
      const what = start.folder ? folderName(start.folder) : strings.review.files('files' in source ? source.files.length : 0);
      setReview({
        key,
        title: strings.review.title(what),
        folder: start.folder,
        inside: start.inside,
        filters: start.filters ?? PRESETS[preset],
      });
    },
    [stopDiscovery],
  );

  const addFolder = useCallback(
    (preset: AddPreset) => {
      void (async () => {
        const folder = await pickFolder();
        if (!folder) return;
        // No list: the job finds the files and keeps those that pass the preset (or the folder's saved filters).
        if (!settings.showReview) {
          await startImport({ folder, files: [], skipped: [], filters: PRESETS[preset], direct: true });
          return;
        }
        await open({ folder }, preset);
      })().catch(failed);
    },
    [settings.showReview, open, failed],
  );

  const addFiles = useCallback(
    (preset: AddPreset) => {
      void (async () => {
        const files = await pickFiles();
        if (files.length === 0) return;
        // Files picked one by one are wanted: without the list, all of them go in.
        if (!settings.showReview) {
          await startImport({ folder: null, files, skipped: [], filters: PRESETS.everything });
          return;
        }
        await open({ files }, preset);
      })().catch(failed);
    },
    [settings.showReview, open, failed],
  );

  const close = useCallback(() => {
    stopDiscovery();
    setReview(null);
  }, [stopDiscovery]);

  const confirm = useCallback(
    (choice: ReviewChoice) => {
      const folder = review?.folder ?? null;
      close();
      void startImport({ folder, ...choice }).catch(failed);
    },
    [review, close, failed],
  );

  const flow = useMemo(() => ({ addFolder, addFiles }), [addFolder, addFiles]);
  return (
    <ImportContext.Provider value={flow}>
      {children}
      <Modal isOpen={review != null} title={review?.title ?? ''} onClose={close} wide className="mp-review-dialog">
        {review ? (
          <ReviewList
            key={review.key}
            rows={rows.current}
            version={version}
            status={status}
            initialFilters={review.filters}
            inside={review.inside}
            showList={settings.showReview}
            onShowListChange={(showReview) => updateSettings({ showReview })}
            onImport={confirm}
            onCancel={close}
          />
        ) : undefined}
      </Modal>
    </ImportContext.Provider>
  );
}
