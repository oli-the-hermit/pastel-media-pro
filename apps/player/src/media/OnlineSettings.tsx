import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, IconRefresh, PasswordField, Select, Switch } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { useNotify } from '../shell/notify';
import { strings } from '../strings';
import { lookUpNow, refreshOnline, setKey, setLanguage, setPlace, useOnline, type OnlineStatus, type Service } from './online';

const LANGUAGES = Object.entries(strings.online.languages).map(([value, label]) => ({ value, label }));

/**
 * One service's key: a field and Save while there is none; "A key is saved" and Remove once there is. The key
 * itself is never shown again: it lives in the system's keychain.
 */
function KeyField({ service, saved }: { service: Service; saved: boolean }) {
  const notify = useNotify();
  const words = strings.online[service];
  const [key, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = (next: string | null) => {
    setBusy(true);
    setError('');
    void setKey(service, next)
      .then(
        () => {
          setTyped('');
          notify(next ? words.saved : words.removed, 'success');
        },
        (e) => setError(String(e).includes('key-refused') ? words.refused : strings.online.failed(String(e))),
      )
      .finally(() => setBusy(false));
  };
  if (saved) {
    return (
      <Field label={words.label} hint={words.hint} group>
        <p className="mp-online-saved">{strings.online.keySaved}</p>
        <div className="mp-add">
          <Button size="sm" disabled={busy} onClick={() => act(null)}>
            {strings.online.removeKey}
          </Button>
        </div>
      </Field>
    );
  }
  return (
    <div className="mp-online-key">
      <PasswordField
        label={words.label}
        hint={words.hint}
        error={error || undefined}
        value={key}
        onChange={setTyped}
        autoComplete="off"
        labels={{ showPassword: strings.online.showKey, hidePassword: strings.online.hideKey }}
      />
      <div className="mp-add">
        <Button variant="primary" size="sm" disabled={busy || !key.trim()} onClick={() => act(key)}>
          {busy ? strings.online.checking : strings.online.saveKey}
        </Button>
      </div>
    </div>
  );
}

function progress(s: OnlineStatus): string {
  if (s.trouble === 'key') return strings.online.troubleKey;
  if (s.trouble === 'offline') return strings.online.troubleOffline;
  return [strings.online.matched(s.matched), s.unmatched > 0 ? strings.online.unmatched(s.unmatched) : '', s.waiting > 0 ? strings.online.waiting(s.waiting) : ''].filter(Boolean).join(' · ');
}

/**
 * Settings → Online: what goes online and to whom, the TMDB key that switches it on, the language, each library
 * folder's own switch, Look up now, and the optional OMDb key for IMDb ratings.
 */
export function OnlineSettings() {
  const notify = useNotify();
  const status = useOnline();
  // Lookups move on by themselves while this is open.
  const waiting = status?.waiting ?? 0;
  useEffect(() => {
    if (waiting === 0) return;
    const id = window.setInterval(() => void refreshOnline(), 3000);
    return () => window.clearInterval(id);
  }, [waiting]);
  const failed = (e: unknown) => notify(strings.online.failed(String(e)), 'error');
  if (!isDesktop()) return <EmptyState>{strings.online.browserOnly}</EmptyState>;
  if (!status) return <EmptyState>{strings.online.reading}</EmptyState>;
  return (
    <div className="mp-settings">
      <p className="mp-online-privacy">{strings.online.privacy}</p>
      <KeyField service="tmdb" saved={status.tmdbKey} />
      {status.tmdbKey ? (
        <>
          <Field label={strings.online.progressLabel} group>
            <p className="mp-online-saved">{progress(status)}</p>
            <div className="mp-add">
              <Button variant="tonal" size="sm" icon={<IconRefresh />} onClick={() => void lookUpNow().catch(failed)}>
                {strings.online.lookUpNow}
              </Button>
            </div>
          </Field>
          <Field label={strings.online.languageLabel} hint={strings.online.languageHint} htmlFor="mp-online-language">
            <Select
              id="mp-online-language"
              value={status.language}
              options={LANGUAGES.some((l) => l.value === status.language) ? LANGUAGES : [...LANGUAGES, { value: status.language, label: status.language }]}
              onChange={(language) => void setLanguage(language).catch(failed)}
            />
          </Field>
          {status.places.length > 0 ? (
            <Field label={strings.online.foldersLabel} hint={strings.online.foldersHint} group>
              {status.places.map((p) => (
                <Switch key={p.id} label={p.path} checked={p.enabled} onChange={(enabled) => void setPlace(p.id, enabled).catch(failed)} />
              ))}
            </Field>
          ) : undefined}
          <KeyField service="omdb" saved={status.omdbKey} />
        </>
      ) : undefined}
    </div>
  );
}
