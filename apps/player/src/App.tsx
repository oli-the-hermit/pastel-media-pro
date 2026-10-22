import { useState } from 'react';
import {
  AccountMenu, AppShell, AppShellPage, EmptyState, IconLogOut, IconPlay, Modal, NavRail, ToastRegion, useDrawer, useToasts,
  type NavRailItem,
} from '@pastel-studio/react';
import { accountViews } from './shell/accountViews';
import { AppTopBar } from './shell/AppTopBar';
import { PAGES, type PageKey } from './shell/pages';
import { strings } from './strings';
import { useAppearance } from './theme';

const NAV_ITEMS: NavRailItem[] = PAGES.map(({ key, icon }) => ({ key, label: strings.pages[key].label, icon }));
// A placeholder mark until the logo is designed.
const BRAND = { mark: <IconPlay size={18} />, name: strings.app.name };
const PROFILE = { name: strings.account.defaultName };

/** The main window: Focus Space's shell from the design system, around the media pages. */
export function App() {
  const [page, setPage] = useState<PageKey>('home');
  const [helpOpen, setHelpOpen] = useState(false);
  const drawer = useDrawer('pastelmedia_drawer');
  const appearance = useAppearance();
  const { toasts, showToast } = useToasts();
  const exit = { label: strings.account.switchProfile, icon: <IconLogOut />, onSelect: () => showToast(strings.account.switchProfileLater, 'info') };

  return (
    <AppShell
      nav={
        <NavRail
          label={strings.nav.label}
          items={NAV_ITEMS}
          activeKey={page}
          onSelect={(key) => setPage(key as PageKey)}
          variant={drawer.expanded ? 'expanded' : 'rail'}
          brand={BRAND}
          onToggle={drawer.canExpand ? drawer.toggle : undefined}
          footer={({ expanded }) => <AccountMenu profile={PROFILE} compact={!expanded} views={accountViews(appearance)} exit={exit} />}
        />
      }
      topBar={<AppTopBar title={strings.pages[page].label} onOpenHelp={() => setHelpOpen(true)} />}
      overlays={
        <>
          <ToastRegion toasts={toasts} />
          <Modal isOpen={helpOpen} title={strings.help.title} onClose={() => setHelpOpen(false)}>
            <EmptyState>{strings.help.empty}</EmptyState>
          </Modal>
        </>
      }
    >
      {PAGES.map(({ key }) => (
        <AppShellPage key={key} active={key === page}>
          <EmptyState>{strings.pages[key].empty}</EmptyState>
        </AppShellPage>
      ))}
    </AppShell>
  );
}
