import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Field, IconClose, IconFolder, IconFolderPlus, IconButton } from '@pastel-studio/react';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { addLibraryFolder, canAddFolders, libraryFolders, removeLibraryFolder } from './library';

/** Adds a folder through Windows' dialog; a failure becomes a toast. */
function useAddFolder(onList?: (folders: string[]) => void) {
  const showToast = useNotify();
  return useCallback(() => {
    void addLibraryFolder().then(
      (list) => onList?.(list),
      (e) => showToast(strings.library.failed(String(e)), 'error'),
    );
  }, [onList, showToast]);
}

/** A media page with no folders to read yet: one thing to do (ux.md, "capture before organising"). */
export function NoFolders() {
  const add = useAddFolder();
  return (
    <EmptyState className="mp-player-empty">
      <p>{strings.library.noFolders}</p>
      {canAddFolders() ? (
        <Button variant="primary" icon={<IconFolderPlus />} onClick={add}>
          {strings.library.add}
        </Button>
      ) : (
        <p>{strings.library.browserOnly}</p>
      )}
    </EmptyState>
  );
}

/** Settings → Library: the folders the library reads, with Add and a way to stop reading one. */
export function LibraryFoldersSettings() {
  const [folders, setFolders] = useState<string[]>([]);
  const showToast = useNotify();
  useEffect(() => {
    void libraryFolders().then(setFolders, () => {});
  }, []);
  const add = useAddFolder(setFolders);
  if (!canAddFolders()) return <EmptyState>{strings.library.browserOnly}</EmptyState>;
  return (
    <div className="mp-settings">
      <Field label={strings.library.foldersLabel} hint={strings.library.foldersHint} group>
        {/* `undefined`, never `false`: the design system's Field counts `false` as a child and crashes on it. */}
        {folders.length === 0 ? undefined : (
          <ul className="mp-folders">
            {folders.map((f) => (
              <li key={f}>
                <IconFolder size={18} />
                <span className="mp-folder-path">{f}</span>
                <IconButton
                  label={strings.library.remove(f)}
                  onClick={() => void removeLibraryFolder(f).then(setFolders, (e) => showToast(strings.library.failed(String(e)), 'error'))}
                >
                  <IconClose size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <div>
        <Button variant="tonal" icon={<IconFolderPlus />} onClick={add}>
          {strings.library.add}
        </Button>
      </div>
    </div>
  );
}
