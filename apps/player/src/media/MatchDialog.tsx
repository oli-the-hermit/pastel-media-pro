import { useEffect, useState, type FormEvent } from 'react';
import { Button, EmptyState, Field, IconFileVideo, IconMonitor, ListRow, Modal, TextInput } from '@pastel-studio/react';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { searchTitles, setMatch, type Candidate, type TitleKind } from './online';

/** What "Not the right title?" is asked about: a film (by its file's path) or a series (by its key). */
export interface MatchTarget {
  kind: TitleKind;
  key: string;
  /** What the library calls it now: the first thing searched for. */
  name: string;
  year?: number | null;
}

/**
 * "Not the right title?": search TMDB for what the person types and pick the title this really is, or say it has
 * no match. Their answer is kept: no later lookup undoes it.
 */
export function MatchDialog({ target, onClose }: { target: MatchTarget | null; onClose: () => void }) {
  const notify = useNotify();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = (e: unknown) => notify(strings.match.failed(String(e)), 'error');

  const search = (text: string, year?: number | null) => {
    if (!target || !text.trim()) return;
    setBusy(true);
    void searchTitles(target.kind, text, year)
      .then(setFound, failed)
      .finally(() => setBusy(false));
  };
  // Opened: what the library calls it is searched for at once.
  const opened = target ? `${target.kind}:${target.key}` : '';
  useEffect(() => {
    if (!target) return;
    setQuery(target.name);
    setFound(null);
    search(target.name, target.year);
    // Only when another title is asked about
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(query);
  };
  const choose = (id: number | null) => {
    if (!target) return;
    setBusy(true);
    void setMatch(target.kind, target.key, id)
      .then(() => {
        notify(id == null ? strings.match.removed : strings.match.saved, 'success');
        onClose();
      }, failed)
      .finally(() => setBusy(false));
  };

  return (
    <Modal isOpen={target !== null} title={strings.match.title} onClose={onClose} dismissible wide>
      {target ? (
        <div className="mp-form">
          <form className="mp-match-search" onSubmit={submit}>
            <Field label={strings.match.searchLabel(target.kind)}>
              <TextInput value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} />
            </Field>
            <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
              {strings.match.search}
            </Button>
          </form>
          {found === null ? (
            <EmptyState size="sm">{busy ? strings.match.searching : ''}</EmptyState>
          ) : found.length === 0 ? (
            <EmptyState size="sm">{strings.match.nothing}</EmptyState>
          ) : (
            <div role="list" className="mp-match-list" aria-label={strings.match.results}>
              {found.map((c) => (
                <div role="listitem" key={c.id}>
                  <ListRow
                    icon={target.kind === 'movie' ? <IconFileVideo size={18} /> : <IconMonitor size={18} />}
                    title={[c.title, c.year ? `(${c.year})` : ''].filter(Boolean).join(' ')}
                    description={[c.originalTitle && c.originalTitle !== c.title ? c.originalTitle : '', c.overview].filter(Boolean).join(' · ') || undefined}
                    disabled={busy}
                    onClick={() => choose(c.id)}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mp-match-foot">
            <Button disabled={busy} onClick={() => choose(null)}>
              {strings.match.none}
            </Button>
            <Button disabled={busy} onClick={onClose}>
              {strings.match.cancel}
            </Button>
          </div>
        </div>
      ) : undefined}
    </Modal>
  );
}
