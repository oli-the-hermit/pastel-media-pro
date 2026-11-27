/**
 * "Can't find this file": a song or a video of the library whose file moved, was renamed or deleted, or sits on a
 * drive that isn't connected. One dialog for the whole window says so and offers the two ways forward: Find it…
 * (the file dialog; the library then follows the file to where it is) and Remove from library. Nothing on disk is
 * ever touched.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, FormActions, IconSearch, IconTrash, Modal, type MenuItem } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { pickFile } from './import/api';
import { libraryChanged } from './library';
import { usePlayback } from './playback';

/** A file the library can't find: where it was, and the name people know it by. */
export interface MissingItem {
  path: string;
  name: string;
}

/** What the desktop app answers to a relink (Rust `Relinked`). */
type Relinked = 'done' | 'different' | 'taken' | 'wrongKind';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

interface Missing {
  /** Opens the dialog for a file. */
  find: (item: MissingItem) => void;
  /** The same two ways forward, for a row's ⋮ menu. */
  menu: (item: MissingItem) => MenuItem[];
}

const Ctx = createContext<Missing>({ find: () => {}, menu: () => [] });

export const useMissing = () => useContext(Ctx);

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
/** A path as people read it: without Windows' long-path prefix. */
const shownPath = (path: string) => path.replace(/^\\\\\?\\/, '');

/** Holds the dialog for the whole window, and opens it when the player is asked for a file that isn't there. */
export function MissingDialogs({ children }: { children: ReactNode }) {
  const notify = useNotify();
  const { missing, clearMissing } = usePlayback();
  const [item, setItem] = useState<MissingItem | null>(null);
  // A file was picked that is not the one that went missing: the dialog asks before using it.
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setItem(null);
    setOther(null);
  }, []);
  const open = useCallback((it: MissingItem) => {
    setOther(null);
    setItem(it);
  }, []);
  useEffect(() => {
    if (!missing) return;
    open({ path: missing, name: fileName(missing) });
    clearMissing();
  }, [missing, clearMissing, open]);

  const failed = useCallback((e: unknown) => notify(strings.missing.failed(String(e)), 'error'), [notify]);

  const relink = useCallback(
    async (it: MissingItem, newPath: string, anyway: boolean) => {
      setBusy(true);
      try {
        const answer = await invoke<Relinked>('file_relink', { path: it.path, newPath, anyway });
        if (answer === 'done') {
          libraryChanged();
          notify(strings.missing.found(it.name), 'success');
          close();
        } else if (answer === 'different') {
          setItem(it);
          setOther(newPath);
        } else {
          notify(answer === 'taken' ? strings.missing.taken : strings.missing.wrongKind, 'info');
        }
      } catch (e) {
        failed(e);
      } finally {
        setBusy(false);
      }
    },
    [notify, close, failed],
  );
  const pick = useCallback(
    (it: MissingItem) => {
      void pickFile(strings.missing.pickTitle(it.name)).then((picked) => {
        if (picked) void relink(it, picked, false);
      }, failed);
    },
    [relink, failed],
  );
  const forget = useCallback(
    (it: MissingItem) => {
      void invoke('file_forget', { path: it.path }).then(() => {
        libraryChanged();
        notify(strings.missing.removed(it.name), 'info');
        close();
      }, failed);
    },
    [notify, close, failed],
  );

  const value = useMemo<Missing>(
    () => ({
      find: open,
      menu: (it) =>
        isDesktop()
          ? [
              { key: 'find', label: strings.missing.find, icon: <IconSearch size={16} />, onSelect: () => pick(it) },
              { key: 'forget', label: strings.missing.remove, icon: <IconTrash size={16} />, danger: true, onSelect: () => forget(it) },
            ]
          : [],
    }),
    [open, pick, forget],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal isOpen={item !== null} title={other ? strings.missing.differentTitle : strings.missing.title} onClose={close} dismissible>
        {item && other ? (
          <div className="mp-form">
            <p>{strings.missing.different(fileName(other), item.name)}</p>
            <FormActions dirty onCancel={() => setOther(null)} primaryLabel={strings.missing.useIt} primaryDisabled={busy} onPrimary={() => void relink(item, other, true)} />
          </div>
        ) : item ? (
          <div className="mp-form">
            <p className="mp-missing-name">{item.name}</p>
            <p className="mp-missing-path">{shownPath(item.path)}</p>
            <p>{strings.missing.why}</p>
            <FormActions
              dirty
              onCancel={close}
              primaryLabel={strings.missing.find}
              primaryDisabled={busy}
              onPrimary={() => pick(item)}
              leading={
                <Button icon={<IconTrash />} onClick={() => forget(item)}>
                  {strings.missing.remove}
                </Button>
              }
            />
          </div>
        ) : undefined}
      </Modal>
    </Ctx.Provider>
  );
}
