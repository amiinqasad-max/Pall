/**
 * Add-to-home-screen prompt.
 *
 * Chrome fires `beforeinstallprompt`, which we stash and replay on a tap.
 * iOS Safari has no such event, so it gets short manual instructions instead —
 * and only after the player has finished a few runs, because prompting someone
 * to install a game they have not decided they like yet is how you train
 * people to dismiss prompts.
 */

import { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { analytics } from '@/systems/analytics';
import { storage } from '@/systems/storage';
import { Button, Panel } from '@/ui/components/primitives';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'install.dismissed';
const MIN_RUNS = 3;

let deferred: BeforeInstallPromptEvent | null = null;

export function InstallPrompt() {
  const runs = useStore((s) => s.save.stats.runs);
  const toast = useUi((s) => s.toast);
  const [available, setAvailable] = useState(Boolean(deferred));
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    void storage.get<boolean>(DISMISS_KEY).then((value) => setDismissed(Boolean(value)));

    const onPrompt = (event: Event): void => {
      event.preventDefault();
      deferred = event as BeforeInstallPromptEvent;
      setAvailable(true);
      analytics.track('install_prompt_available', {});
    };
    const onInstalled = (): void => {
      deferred = null;
      setAvailable(false);
      analytics.track('app_installed', {});
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

  if (standalone || dismissed || runs < MIN_RUNS) return null;
  if (!available && !isIos) return null;

  const install = async (): Promise<void> => {
    if (!deferred) return;
    analytics.track('install_prompt_shown', {});
    await deferred.prompt();
    const choice = await deferred.userChoice;
    analytics.track('install_prompt_result', { outcome: choice.outcome });
    if (choice.outcome === 'accepted') toast('Installing TARTAN', 'reward', '📲');
    deferred = null;
    setAvailable(false);
  };

  const dismiss = async (): Promise<void> => {
    setDismissed(true);
    await storage.set(DISMISS_KEY, true);
  };

  return (
    <Panel title="Install">
      <div className="row row--between" style={{ marginBottom: 'var(--sp-3)' }}>
        <div style={{ minWidth: 0 }}>
          <div className="strong">Add TARTAN to your home screen</div>
          <div className="small muted">
            {isIos && !available
              ? 'Tap the share button, then "Add to Home Screen".'
              : 'Instant loading, full screen, and it works offline.'}
          </div>
        </div>
      </div>
      <div className="row">
        {available && (
          <Button variant="primary" size="sm" onClick={() => void install()}>
            Install
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
          Not now
        </Button>
      </div>
    </Panel>
  );
}
