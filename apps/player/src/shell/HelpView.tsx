import { strings } from '../strings';

/** Help, in the top bar's dialog: how files play, the library, the keyboard shortcuts, and where to report a problem. */
export function HelpView() {
  const h = strings.help;
  return (
    <div className="mp-help">
      <section aria-labelledby="mp-help-play">
        <h3 id="mp-help-play">{h.playTitle}</h3>
        <p>{h.play}</p>
      </section>
      <section aria-labelledby="mp-help-library">
        <h3 id="mp-help-library">{h.libraryTitle}</h3>
        <p>{h.library}</p>
      </section>
      <section aria-labelledby="mp-help-keys">
        <h3 id="mp-help-keys">{h.keysTitle}</h3>
        <p>{h.keysHint}</p>
        <dl className="mp-keys">
          {h.keys.map(([keys, what]) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="mp-help-issues">
        <h3 id="mp-help-issues">{h.issuesTitle}</h3>
        <p className="mp-about-url">{h.issues}</p>
      </section>
    </div>
  );
}
