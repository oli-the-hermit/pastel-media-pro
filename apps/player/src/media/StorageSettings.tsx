import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, IconTrash, Select } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';

/** What the desktop app says of its image cache (Rust `CacheInfo`). */
interface CacheInfo {
  bytes: number;
  pictures: number;
  capMb: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

const CAPS = [250, 500, 1024, 2048, 5120];

/** A size as people read it: "12 MB", "1.4 GB". */
export function sizeOf(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return bytes > 0 ? '1 MB' : '0 MB';
}

/**
 * Settings → Storage: the pictures the app keeps (frames taken from your videos, art found beside them or online),
 * how much room they may take, and Clear cache. Everything dropped can be made again; your own files are never touched.
 */
export function StorageSettings() {
  const notify = useNotify();
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const failed = (e: unknown) => notify(strings.storage.failed(String(e)), 'error');
  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    void invoke<CacheInfo>('cache_info').then(
      (i) => alive && setInfo(i),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!isDesktop()) return <EmptyState>{strings.storage.browserOnly}</EmptyState>;
  const caps = info && !CAPS.includes(info.capMb) ? [...CAPS, info.capMb].sort((a, b) => a - b) : CAPS;
  return (
    <div className="mp-settings">
      <Field label={strings.storage.picturesLabel} hint={strings.storage.picturesHint} group>
        <p className="mp-storage-use">{info ? strings.storage.use(sizeOf(info.bytes), info.pictures) : strings.storage.reading}</p>
      </Field>
      <Field label={strings.storage.capLabel} hint={strings.storage.capHint} htmlFor="mp-cache-cap">
        <Select
          id="mp-cache-cap"
          value={info?.capMb ?? 1024}
          options={caps.map((mb) => ({ value: mb, label: sizeOf(mb * 1024 * 1024) }))}
          onChange={(mb) => void invoke<CacheInfo>('cache_set_cap', { mb }).then(setInfo, failed)}
        />
      </Field>
      <div className="mp-add">
        <Button
          icon={<IconTrash />}
          disabled={!info || info.pictures === 0}
          onClick={() =>
            void invoke<CacheInfo>('cache_clear').then((now) => {
              setInfo(now);
              notify(strings.storage.cleared, 'success');
            }, failed)
          }
        >
          {strings.storage.clear}
        </Button>
      </div>
    </div>
  );
}
