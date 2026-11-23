import { createContext, useContext } from 'react';
import type { useToasts } from '@pastel-studio/react';

type ShowToast = ReturnType<typeof useToasts>['showToast'];

/**
 * The window's one toast list (the design system's `useToasts` keeps its own per caller): App provides its
 * `showToast`, and any part of the window, such as a Settings tab, shows its toasts through it.
 */
export const NotifyContext = createContext<ShowToast>(() => {});

export function useNotify(): ShowToast {
  return useContext(NotifyContext);
}
