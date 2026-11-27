import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ConfirmModal, Field, FormActions, IconPlaylistAdd, IconPlus, Modal, TextArea, TextInput, type MenuItem } from '@pastel-studio/react';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { addToPlaylist, createPlaylist, deletePlaylist, updatePlaylist, usePlaylists, type Playlist } from './playlists';

/** The dialogs any page can open: a new playlist (with songs to put in it), a playlist's name, and deleting one. */
interface Dialogs {
  create: (paths?: string[]) => void;
  edit: (playlist: Playlist) => void;
  remove: (playlist: Playlist) => void;
}

const Ctx = createContext<Dialogs>({ create: () => {}, edit: () => {}, remove: () => {} });

export const usePlaylistDialogs = () => useContext(Ctx);

/** Name and description, for a new playlist or one being renamed. Cancel shows once something was typed. */
function PlaylistForm({ playlist, onSubmit, onCancel }: { playlist?: Playlist; onSubmit: (name: string, description: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(playlist?.name ?? '');
  const [description, setDescription] = useState(playlist?.description ?? '');
  const dirty = name !== (playlist?.name ?? '') || description !== (playlist?.description ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name, description);
  };
  return (
    <form className="mp-form" onSubmit={submit}>
      <Field label={strings.playlists.name}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
      </Field>
      <Field label={strings.playlists.description} labelHint={strings.playlists.optional}>
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} />
      </Field>
      <FormActions dirty={dirty} onCancel={onCancel} primaryLabel={playlist ? strings.playlists.save : strings.playlists.create} primaryDisabled={!name.trim()} />
    </form>
  );
}

/** How many of the songs went in, said in a toast. */
function addedMessage(added: number, name: string): string {
  return added === 0 ? strings.playlists.already(name) : strings.playlists.added(added, name);
}

/** Holds the playlists' dialogs for the whole window, so a song's menu on any page can open them. */
export function PlaylistDialogs({ children }: { children: ReactNode }) {
  const notify = useNotify();
  const [form, setForm] = useState<{ playlist?: Playlist; paths: string[] } | null>(null);
  const [removing, setRemoving] = useState<Playlist | null>(null);
  const dialogs = useMemo<Dialogs>(
    () => ({
      create: (paths = []) => setForm({ paths }),
      edit: (playlist) => setForm({ playlist, paths: [] }),
      remove: setRemoving,
    }),
    [],
  );
  const failed = (e: unknown) => notify(strings.playlists.failed(String(e)), 'error');
  const submit = (name: string, description: string) => {
    if (!form) return;
    const { playlist, paths } = form;
    setForm(null);
    if (playlist) {
      void updatePlaylist(playlist.id, name, description).catch(failed);
      return;
    }
    void createPlaylist(name, description, paths).then((made) => {
      if (paths.length > 0) notify(addedMessage(made.paths.length, made.name), 'success');
    }, failed);
  };
  return (
    <Ctx.Provider value={dialogs}>
      {children}
      <Modal isOpen={form !== null} title={form?.playlist ? strings.playlists.editTitle : strings.playlists.newTitle} onClose={() => setForm(null)}>
        {form ? <PlaylistForm playlist={form.playlist} onSubmit={submit} onCancel={() => setForm(null)} /> : undefined}
      </Modal>
      <Modal isOpen={removing !== null} title={strings.playlists.deleteTitle} onClose={() => setRemoving(null)} dismissible>
        {removing ? (
          <ConfirmModal
            message={strings.playlists.deleteMessage(removing.name)}
            onConfirm={() => void deletePlaylist(removing.id).catch(failed)}
            onClose={() => setRemoving(null)}
          />
        ) : undefined}
      </Modal>
    </Ctx.Provider>
  );
}

/**
 * "Add to playlist" for a menu: a row that opens the playlists, with "New playlist…" first. For one song's ⋮ menu,
 * or an album's (all its songs). `except` leaves a playlist out: the one the song is already shown in.
 */
export function useAddToPlaylist(except?: number): (paths: string[]) => MenuItem[] {
  const lists = usePlaylists();
  const dialogs = usePlaylistDialogs();
  const notify = useNotify();
  return useCallback(
    (paths) => {
      const others = lists.filter((p) => p.id !== except);
      const add = (p: Playlist) =>
        void addToPlaylist(p.id, paths).then(
          (added) => notify(addedMessage(added, p.name), added === 0 ? 'info' : 'success'),
          (e) => notify(strings.playlists.failed(String(e)), 'error'),
        );
      return [
        {
          key: 'add-to-playlist',
          label: strings.playlists.addTo,
          icon: <IconPlaylistAdd size={16} />,
          items: [
            { key: 'new', label: strings.playlists.newMenu, icon: <IconPlus size={16} />, onSelect: () => dialogs.create(paths) },
            ...(others.length > 0 ? [{ key: 'divider', divider: true as const }] : []),
            ...others.map((p) => ({ key: `playlist-${p.id}`, label: p.name, onSelect: () => add(p) })),
          ],
        },
      ];
    },
    [lists, except, dialogs, notify],
  );
}
