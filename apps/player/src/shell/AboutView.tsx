import { useState } from 'react';
import { Button, Field } from '@pastel-studio/react';
import { version } from '../../package.json';
import { strings } from '../strings';

/** The texts shipped in public/licenses (written by scripts/release/notices.ts). */
const TEXTS = {
  notices: 'licenses/third-party-notices.txt',
  lgpl: 'licenses/LGPL-2.1.txt',
} as const;

type Shown = keyof typeof TEXTS;

/** About, in the account menu's dialog: the version, the licence, and the third-party notices with the LGPL text. */
export function AboutView() {
  const [shown, setShown] = useState<{ key: Shown; text: string } | null>(null);
  const show = (key: Shown) => {
    if (shown?.key === key) {
      setShown(null);
      return;
    }
    void fetch(TEXTS[key])
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (text) => setShown({ key, text }),
        () => setShown({ key, text: strings.about.textMissing }),
      );
  };
  return (
    <div className="mp-settings mp-about">
      <div className="mp-about-head">
        <h2>{strings.app.name}</h2>
        <p>{strings.about.version(version)}</p>
        <p>{strings.about.description}</p>
      </div>
      <Field label={strings.about.licenceLabel} group>
        <p>{strings.about.licence}</p>
        <p className="mp-about-url">{strings.about.source}</p>
      </Field>
      <Field label={strings.about.tmdbLabel} group>
        <p>{strings.about.tmdb}</p>
      </Field>
      <Field label={strings.about.thirdPartyLabel} group>
        <p>{strings.about.libmpv}</p>
        <div className="mp-about-actions">
          <Button variant="tonal" aria-expanded={shown?.key === 'notices'} onClick={() => show('notices')}>
            {strings.about.showNotices}
          </Button>
          <Button variant="tonal" aria-expanded={shown?.key === 'lgpl'} onClick={() => show('lgpl')}>
            {strings.about.showLgpl}
          </Button>
        </div>
        {shown ? (
          <pre className="mp-about-text" tabIndex={0} aria-label={shown.key === 'notices' ? strings.about.showNotices : strings.about.showLgpl}>
            {shown.text}
          </pre>
        ) : undefined}
      </Field>
    </div>
  );
}
