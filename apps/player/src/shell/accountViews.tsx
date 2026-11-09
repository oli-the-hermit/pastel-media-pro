import { AppearancePanel, EmptyState, IconPalette, IconSettings, IconUser, type AccountView } from '@pastel-studio/react';
import { strings } from '../strings';
import { themeStore, type useAppearance } from '../theme';
import { SettingsView } from './SettingsView';

type Appearance = ReturnType<typeof useAppearance>;

/** The account menu's views: Profile, Appearance (the shared one) and Settings. */
export function accountViews({ mode, setMode, accent, setAccent }: Appearance): AccountView[] {
  return [
    {
      key: 'profile',
      label: strings.account.profile,
      icon: <IconUser />,
      render: () => <EmptyState>{strings.account.profileEmpty}</EmptyState>,
    },
    {
      key: 'appearance',
      label: strings.account.appearance,
      icon: <IconPalette />,
      render: () => (
        <AppearancePanel
          theme={mode}
          onThemeChange={setMode}
          accent={accent}
          onAccentChange={setAccent}
          recent={themeStore.recent()}
          onRemember={(picked) => picked.forEach((id) => themeStore.pushRecent(id))}
        />
      ),
    },
    {
      key: 'settings',
      label: strings.account.settings,
      icon: <IconSettings />,
      render: () => <SettingsView />,
    },
  ];
}
