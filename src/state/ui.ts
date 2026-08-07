/**
 * UI-only state: which screen is showing, transient toasts, and modals.
 *
 * Deliberately separate from the save store — nothing here is persisted, and
 * keeping them apart means a navigation change never triggers a disk write.
 */

import { create } from 'zustand';
import type { ScreenId } from '@/types';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'reward' | 'error';
  icon?: string;
}

interface UiState {
  screen: ScreenId;
  previous: ScreenId;
  toasts: Toast[];
  /** True while an ad is on screen; the app dims and blocks input under it. */
  adShowing: boolean;
  installPromptAvailable: boolean;

  go(screen: ScreenId): void;
  back(): void;
  toast(message: string, tone?: Toast['tone'], icon?: string): void;
  dismissToast(id: number): void;
  setAdShowing(showing: boolean): void;
  setInstallAvailable(available: boolean): void;
}

let toastId = 1;

export const useUi = create<UiState>((set, get) => ({
  screen: 'splash',
  previous: 'home',
  toasts: [],
  adShowing: false,
  installPromptAvailable: false,

  go(screen) {
    const current = get().screen;
    if (current === screen) return;
    set({ screen, previous: current });
  },

  back() {
    set({ screen: get().previous, previous: 'home' });
  },

  toast(message, tone = 'info', icon) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, message, tone, icon }] });
    // Auto-dismiss. Rewards linger slightly longer because they are the ones
    // players actually want to read.
    setTimeout(() => get().dismissToast(id), tone === 'reward' ? 3200 : 2400);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setAdShowing(adShowing) {
    set({ adShowing });
  },

  setInstallAvailable(installPromptAvailable) {
    set({ installPromptAvailable });
  },
}));
