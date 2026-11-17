import { useEffect, useState } from 'react';
import { EmptyState, IconClose, WindowButton, useLabels, useThemeSync } from '@pastel-studio/react';
import { closeWindow } from '../desktop';
import { strings } from '../strings';
import { themeStore } from '../theme';
import './mini.css';

const readLook = () => ({ mode: themeStore.getMode() ?? 'system', accent: themeStore.getAccent() });

/**
 * The mini player window (index.html#mini). It holds no data of its own yet: it paints in the
 * look the main window remembered, and follows it live, since both windows share the storage.
 */
export function MiniApp() {
  const [look, setLook] = useState(readLook);
  const labels = useLabels();
  useThemeSync(look.mode, look.accent, themeStore);

  useEffect(() => {
    const onStorage = () => setLook(readLook());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <div className="mini" data-tauri-drag-region>
      <WindowButton size="sm" label={labels.close} className="mini-close" onClick={() => void closeWindow().catch(() => {})}>
        <IconClose size={14} />
      </WindowButton>
      <EmptyState size="sm" data-tauri-drag-region>{strings.mini.empty}</EmptyState>
    </div>
  );
}
