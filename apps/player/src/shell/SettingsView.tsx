import { useState } from 'react';
import { EmptyState, Tabs } from '@pastel-studio/react';
import { strings } from '../strings';

type SettingsTab = keyof typeof strings.settings.tabs;

const TABS = (Object.keys(strings.settings.tabs) as SettingsTab[]).map((key) => ({ key, label: strings.settings.tabs[key].label }));

/** Settings, in the account menu's dialog: one tab per area, each still empty. */
export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('library');
  return (
    <Tabs tabs={TABS} value={tab} onChange={(key) => setTab(key as SettingsTab)} ariaLabel={strings.settings.ariaLabel}>
      <EmptyState>{strings.settings.tabs[tab].empty}</EmptyState>
    </Tabs>
  );
}
