/**
 * Shared UI primitives.
 *
 * Every interactive element routes through `tap()` so audio and haptic
 * feedback are consistent by construction — a button that forgets to click is
 * impossible rather than merely unlikely.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { compact } from '@/core/format';

export function feedback(kind: 'tap' | 'back' | 'toggle' = 'tap'): void {
  audio.play(kind === 'tap' ? 'ui.tap' : kind === 'back' ? 'ui.back' : 'ui.toggle');
  haptics.fire(kind === 'toggle' ? 'select' : 'tap');
}

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'amber' | 'violet' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  block,
  disabled,
  className = '',
  ariaLabel,
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => {
        if (disabled) return;
        feedback(variant === 'ghost' ? 'back' : 'tap');
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  label,
}: {
  icon: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="iconbtn"
      aria-label={label}
      onClick={() => {
        feedback('back');
        onClick();
      }}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}

export function Panel({
  children,
  title,
  action,
  accent,
  tone,
  float,
  className = '',
}: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
  accent?: boolean;
  /** Colour of the ambient bloom cast under the card. */
  tone?: 'teal' | 'violet' | 'amber';
  /** Slow idle drift, so a card reads as hovering rather than pasted down. */
  float?: boolean;
  className?: string;
}) {
  const classes = [
    'panel',
    accent || tone ? 'panel--accent' : '',
    tone && tone !== 'teal' ? `panel--${tone}` : '',
    float ? 'panel--float' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes}>
      {(title || action) && (
        <header className="panel__head">
          {title && <h2 className="panel__title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * The reward flourish: rotating light rays, a popping icon, and sparkles thrown
 * outward on fixed vectors.
 *
 * The sparkle directions are computed once rather than randomised per render,
 * so React never reconciles a changing style object and the animation cannot
 * restart mid-flight.
 */
const SPARKLES = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2 + 0.4;
  const reach = 46 + (i % 3) * 12;
  return {
    dx: `${Math.round(Math.cos(angle) * reach)}px`,
    dy: `${Math.round(Math.sin(angle) * reach)}px`,
    delay: `${(i * 0.11).toFixed(2)}s`,
  };
});

export function RewardBurst({
  icon,
  sparkles = true,
  size = 'md',
}: {
  icon: string;
  sparkles?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`burst ${size === 'sm' ? 'burst--sm' : ''}`} aria-hidden="true">
      <div className="burst__rays" />
      {sparkles &&
        SPARKLES.map((s, i) => (
          <span
            key={i}
            className="sparkle"
            style={{ ['--dx' as string]: s.dx, ['--dy' as string]: s.dy, animationDelay: s.delay }}
          />
        ))}
      <div className="burst__core">{icon}</div>
    </div>
  );
}

export function Meter({
  value,
  amber,
  complete,
  thin,
}: {
  value: number;
  /** Reserved for economy-tied progress — the daily challenge pays coins. */
  amber?: boolean;
  /** A finished, claimable objective — cyan with a satisfied glow, not gold. */
  complete?: boolean;
  thin?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const tone = amber ? 'meter__fill--amber' : complete ? 'meter__fill--complete' : '';
  return (
    <div
      className={`meter ${thin ? 'meter--thin' : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`meter__fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The rank emblem shown on the profile hero card — one of seven tiered treatments. */
export function RankBadge({ glyph, tone, size = 'md' }: { glyph: string; tone: string; size?: 'md' | 'sm' }) {
  return (
    <div className={`rank-badge rank-badge--${tone} ${size === 'sm' ? 'rank-badge--sm' : ''}`} aria-hidden="true">
      <span className="rank-badge__glyph">{glyph}</span>
    </div>
  );
}

/**
 * The coin balance chip. Pops whenever the balance rises so a reward is
 * acknowledged even when the player is looking somewhere else on the screen.
 */
export function CoinChip({ coins, onClick }: { coins: number; onClick?: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const previous = useRef(coins);

  useEffect(() => {
    if (coins > previous.current && ref.current) {
      const node = ref.current;
      node.classList.remove('chip--pop');
      // Force a reflow so the animation restarts on consecutive gains.
      void node.offsetWidth;
      node.classList.add('chip--pop');
    }
    previous.current = coins;
  }, [coins]);

  const content = (
    <>
      <span aria-hidden="true">🪙</span>
      <span className="numeric">{compact(coins)}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        ref={ref as React.RefObject<HTMLButtonElement>}
        className="chip chip--coin"
        onClick={() => {
          feedback();
          onClick();
        }}
        aria-label={`${coins} Tartan coins`}
      >
        {content}
      </button>
    );
  }
  return (
    <span ref={ref as React.RefObject<HTMLSpanElement>} className="chip chip--coin" aria-label={`${coins} Tartan coins`}>
      {content}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          className={`tabs__tab ${value === tab.id ? 'tabs__tab--active' : ''}`}
          onClick={() => {
            if (value === tab.id) return;
            feedback('toggle');
            onChange(tab.id);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet({
  children,
  onClose,
  title,
  subtitle,
  dismissable = true,
}: {
  children: ReactNode;
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  dismissable?: boolean;
}) {
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (dismissable && event.target === event.currentTarget) {
          feedback('back');
          onClose?.();
        }
      }}
    >
      <div className="sheet">
        {title && <h2 className="sheet__title">{title}</h2>}
        {subtitle && <p className="sheet__sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function StatGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="statgrid">
      {items.map((item) => (
        <div key={item.label}>
          <div className="statgrid__value">{item.value}</div>
          <div className="statgrid__label">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="center stack" style={{ padding: 'var(--sp-6) var(--sp-4)' }}>
      <div style={{ fontSize: '2.5rem' }} aria-hidden="true">
        {icon}
      </div>
      <div className="strong">{title}</div>
      <div className="small muted">{body}</div>
    </div>
  );
}
