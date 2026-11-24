import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Field, IconButton, IconClose, IconFile, IconFolder, IconFolderPlus, IconRefresh, Switch } from '@pastel-studio/react';
import { updateSettings, useSettings } from '../settings';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { isOver, places, removePlace, rescan, useJobs, type Place } from './import/api';
import { useImportFlow, type AddPreset } from './import/ImportFlow';
import { canAddFolders } from './library';

/** Add a folder and Add files, for a page's own kind of media. */
export function AddButtons({ preset, primary = false }: { preset: AddPreset; primary?: boolean }) {
  const flow = useImportFlow();
  if (!canAddFolders()) return null;
  return (
    <div className="mp-add">
      <Button variant={primary ? 'primary' : 'tonal'} size={primary ? 'md' : 'sm'} icon={<IconFolderPlus />} onClick={() => flow.addFolder(preset)}>
        {strings.library.add}
      </Button>
      <Button variant="tonal" size={primary ? 'md' : 'sm'} icon={<IconFile />} onClick={() => flow.addFiles(preset)}>
        {strings.library.addFiles}
      </Button>
    </div>
  );
}

/** A media page with nothing to show yet: one thing to do (ux.md, "capture before organising"). */
export function NoFolders({ preset }: { preset: AddPreset }) {
  return (
    <EmptyState className="mp-player-empty">
      <p>{strings.library.noFolders}</p>
      {canAddFolders() ? <AddButtons preset={preset} primary /> : <p>{strings.library.browserOnly}</p>}
    </EmptyState>
  );
}

/** The places, read again whenever a job finishes (it may have added files, or a folder). */
function usePlaces(): [Place[], () => void] {
  const [list, setList] = useState<Place[]>([]);
  const jobs = useJobs();
  const finished = jobs.filter(isOver).length;
  const reload = useCallback(() => void places().then(setList, () => {}), []);
  useEffect(reload, [reload, finished]);
  return [list, reload];
}

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/**
 * Settings → Library: the folders the library reads (each with its files, its filters' name, Check for changes and
 * Remove), Add a folder and Add files, and whether the files found are shown before adding (ux.md §2b).
 */
export function LibraryFoldersSettings() {
  const settings = useSettings();
  const [list, reload] = usePlaces();
  const showToast = useNotify();
  const failed = (e: unknown) => showToast(strings.library.failed(String(e)), 'error');
  if (!canAddFolders()) return <EmptyState>{strings.library.browserOnly}</EmptyState>;
  return (
    <div className="mp-settings">
      <Field label={strings.library.foldersLabel} hint={strings.library.foldersHint} group>
        {/* `undefined`, never `false`: the design system's Field counts `false` as a child and crashes on it. */}
        {list.length === 0 ? undefined : (
          <ul className="mp-folders">
            {list.map((p) => (
              <li key={p.id} className={p.found ? undefined : 'is-gone'}>
                <IconFolder size={18} />
                <span className="mp-folder-text">
                  <span className="mp-folder-path">{p.path}</span>
                  <span className="mp-folder-facts">{strings.library.folderFacts(p.files, p.missing, strings.library.presets[p.preset] ?? p.preset)}</span>
                  {p.found ? undefined : <span className="mp-folder-gone">{strings.library.gone}</span>}
                </span>
                <IconButton label={strings.library.rescan(folderName(p.path))} disabled={!p.found} onClick={() => void rescan(p.id).catch(failed)}>
                  <IconRefresh size={16} />
                </IconButton>
                <IconButton
                  label={strings.library.remove(p.path)}
                  onClick={() =>
                    void removePlace(p.id).then(() => {
                      reload();
                      showToast(strings.library.removed(folderName(p.path)), 'info');
                    }, failed)
                  }
                >
                  <IconClose size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <div className="mp-add">
        <AddButtons preset="everything" />
        {list.length > 1 ? (
          <Button variant="tonal" size="sm" icon={<IconRefresh />} onClick={() => void rescan(null).catch(failed)}>
            {strings.library.rescanAll}
          </Button>
        ) : undefined}
      </div>
      <Switch label={strings.library.showReview} hint={strings.library.showReviewHint} checked={settings.showReview} onChange={(showReview) => updateSettings({ showReview })} />
    </div>
  );
}
