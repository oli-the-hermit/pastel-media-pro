import { useState } from 'react';
import { EmptyState, Field, Select, Switch, Tabs } from '@pastel-studio/react';
import { updateSettings, useSettings, type StartPage } from '../settings';
import { strings } from '../strings';

type SettingsTab = keyof typeof strings.settings.tabs;

const TABS = (Object.keys(strings.settings.tabs) as SettingsTab[]).map((key) => ({ key, label: strings.settings.tabs[key].label }));

const START_PAGES = (Object.keys(strings.general.startPages) as StartPage[]).map((value) => ({ value, label: strings.general.startPages[value] }));

/** General: where the app opens, and whether Streaming shows. Saved as soon as they change. */
function GeneralSettings() {
  const settings = useSettings();
  return (
    <div className="mp-settings">
      <Field label={strings.general.startOn} hint={strings.general.startOnHint} htmlFor="mp-start-on">
        <Select id="mp-start-on" value={settings.startOn} options={START_PAGES} onChange={(startOn) => updateSettings({ startOn })} />
      </Field>
      <Switch
        label={strings.general.showStreaming}
        hint={strings.general.showStreamingHint}
        checked={settings.showStreaming}
        onChange={(showStreaming) => updateSettings({ showStreaming })}
      />
    </div>
  );
}

/** Settings, in the account menu's dialog: one tab per area. */
export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('general');
  const current = strings.settings.tabs[tab];
  return (
    <Tabs tabs={TABS} value={tab} onChange={(key) => setTab(key as SettingsTab)} ariaLabel={strings.settings.ariaLabel}>
      {tab === 'general' ? <GeneralSettings /> : <EmptyState>{'empty' in current ? current.empty : null}</EmptyState>}
    </Tabs>
  );
}
