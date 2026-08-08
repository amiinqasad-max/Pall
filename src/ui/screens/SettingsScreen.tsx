import { useEffect, useState } from 'react';
import { useStore, useSettings } from '@/state/store';
import { useUi } from '@/state/ui';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { analytics } from '@/systems/analytics';
import { storage } from '@/systems/storage';
import { isBackendConfigured } from '@/services/supabase';
import { Button, IconButton, Panel, Sheet } from '@/ui/components/primitives';
import type { PerfTier } from '@/types';

/** 'UltraLow' from naive capitalisation reads as one odd word; spell it out. */
const QUALITY_LABELS: Record<PerfTier | 'auto', string> = {
  auto: 'Auto',
  ultraLow: 'Ultra low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function SettingsScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const settings = useSettings();
  const update = useStore((s) => s.updateSettings);
  const reset = useStore((s) => s.resetProgress);
  const save = useStore((s) => s.save);
  const [confirmReset, setConfirmReset] = useState(false);
  const [driver, setDriver] = useState<string>('');

  useEffect(() => {
    void storage.driver().then(setDriver);
  }, []);

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('profile')} />
        <h1 className="topbar__title">Settings</h1>
      </header>

      <div className="screen__body">
        <div className="stack">
          <Panel title="Audio">
            <Toggle
              label="Mute everything"
              checked={settings.muted}
              onChange={(muted) => {
                update({ muted });
                audio.configure({ ...settings, muted });
                if (!muted) audio.play('ui.toggle');
              }}
            />
            <Slider
              label="Music"
              value={settings.musicVolume}
              disabled={settings.muted}
              onChange={(musicVolume) => {
                update({ musicVolume });
                audio.configure({ ...settings, musicVolume });
              }}
            />
            <Slider
              label="Effects"
              value={settings.sfxVolume}
              disabled={settings.muted}
              onCommit={() => audio.play('ui.tap')}
              onChange={(sfxVolume) => {
                update({ sfxVolume });
                audio.configure({ ...settings, sfxVolume });
              }}
            />
          </Panel>

          <Panel title="Feel">
            <Toggle
              label="Vibration"
              hint={haptics.isSupported ? undefined : 'Not supported on this device'}
              checked={settings.haptics && haptics.isSupported}
              disabled={!haptics.isSupported}
              onChange={(value) => {
                update({ haptics: value });
                haptics.setEnabled(value);
                if (value) haptics.fire('select');
              }}
            />
            <Toggle
              label="Reduced motion"
              hint="Turns off screen shake, flashes and the trail."
              checked={settings.reducedMotion}
              onChange={(reducedMotion) => update({ reducedMotion })}
            />
          </Panel>

          <Panel title="Performance">
            <div className="row" style={{ marginBottom: 'var(--sp-2)', flexWrap: 'wrap' }}>
              {(['auto', 'ultraLow', 'low', 'medium', 'high'] as const).map((option) => (
                <button
                  key={option}
                  className={`btn btn--sm ${settings.quality === option ? 'btn--primary' : ''}`}
                  style={{ flex: 1 }}
                  onClick={() => {
                    update({ quality: option as PerfTier | 'auto' });
                    audio.play('ui.toggle');
                  }}
                >
                  {QUALITY_LABELS[option]}
                </button>
              ))}
            </div>
            <p className="tiny dim" style={{ margin: 0 }}>
              Auto picks a tier from your device and steps down automatically if the frame rate drops. Takes effect on
              your next run.
            </p>
            <div style={{ height: 'var(--sp-3)' }} />
            <Toggle label="Show FPS" checked={settings.showFps} onChange={(showFps) => update({ showFps })} />
          </Panel>

          <Panel title="Data">
            <div className="row row--between small" style={{ marginBottom: 'var(--sp-2)' }}>
              <span className="muted">Cloud save</span>
              <span>{isBackendConfigured ? (save.cloud.userId ? 'Synced' : 'Connecting…') : 'Local only'}</span>
            </div>
            <div className="row row--between small" style={{ marginBottom: 'var(--sp-2)' }}>
              <span className="muted">Storage</span>
              <span>{driver === 'idb' ? 'IndexedDB' : driver === 'local' ? 'Local storage' : driver || '—'}</span>
            </div>
            <div className="row row--between small" style={{ marginBottom: 'var(--sp-3)' }}>
              <span className="muted">Last sync</span>
              <span>{save.cloud.lastSyncAt ? new Date(save.cloud.lastSyncAt).toLocaleTimeString() : 'Never'}</span>
            </div>
            <Toggle
              label="Share anonymous analytics"
              hint="Session counts and performance samples. No advertising or location identifiers."
              checked={settings.analytics}
              onChange={(enabled) => {
                update({ analytics: enabled });
                analytics.setEnabled(enabled);
                toast(enabled ? 'Analytics on' : 'Analytics off');
              }}
            />
          </Panel>

          <Panel title="About">
            <p className="small muted" style={{ marginTop: 0 }}>
              TARTAN — an original endless arcade runner. Version 1.0.0.
            </p>
            <p className="tiny dim" style={{ margin: 0 }}>
              All artwork and audio in this game is generated procedurally at runtime.
            </p>
          </Panel>

          <Button variant="danger" block onClick={() => setConfirmReset(true)}>
            Reset all progress
          </Button>
        </div>
      </div>

      {confirmReset && (
        <Sheet
          title="Reset everything?"
          subtitle="Coins, levels, unlocks, records and streaks on this device will be erased. This cannot be undone."
          onClose={() => setConfirmReset(false)}
        >
          <div className="stack">
            <Button
              variant="danger"
              block
              onClick={() => {
                void reset().then(() => {
                  setConfirmReset(false);
                  toast('Progress reset');
                  go('home');
                });
              }}
            >
              Yes, erase my progress
            </Button>
            <Button variant="ghost" block onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="row row--between" style={{ padding: 'var(--sp-2) 0', opacity: disabled ? 0.5 : 1 }}>
      <span style={{ minWidth: 0 }}>
        <span className="small">{label}</span>
        {hint && <span className="tiny dim" style={{ display: 'block' }}>{hint}</span>}
      </span>
      {/* The input stays in the DOM and keeps every keyboard and screen-reader
          behaviour a checkbox has; it is simply invisible over the switch. */}
      <span className={`switch ${checked ? 'switch--on' : ''}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span className="switch__knob" />
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <label style={{ display: 'block', padding: 'var(--sp-2) 0', opacity: disabled ? 0.5 : 1 }}>
      <div className="row row--between small" style={{ marginBottom: 4 }}>
        <span>{label}</span>
        <span className="tiny dim numeric">{Math.round(value * 100)}%</span>
      </div>
      <input
        className="slider"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        // The track's fill stop, so the filled part needs no second element.
        style={{ ['--fill' as string]: `${Math.round(value * 100)}%` }}
      />
    </label>
  );
}
