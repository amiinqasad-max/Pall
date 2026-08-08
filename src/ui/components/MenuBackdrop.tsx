/**
 * The world behind the menus.
 *
 * Five layers — sky, aurora, starfield, horizon line, grid floor — moving at
 * different rates against a single parallax input. That difference in rate is
 * the entire illusion: the eye reads unequal motion as depth long before it
 * reads any of the individual layers as scenery.
 *
 * The input is the pointer on a desktop and the device's own tilt on a phone,
 * normalised to the same -1..1 on both axes so one code path drives both.
 *
 * Cost control, because this sits under every screen in the app:
 *  - one rAF loop for all five layers, and it stops itself once the motion has
 *    settled rather than idling at 60Hz behind a static menu;
 *  - only `transform` is written, so the compositor moves already-painted
 *    layers and nothing repaints;
 *  - the starfield is a single element with a box-shadow list, painted once;
 *  - the low tier drops the aurora and the floor, which are the two largest
 *    fill-rate consumers.
 */

import { useEffect, useMemo, useRef } from 'react';
import { createRng, hashString } from '@/core/rng';
import { detectDevice, isLiteTier } from '@/systems/device';

/** How far each layer travels, in pixels, at full deflection. */
const DEPTH = {
  sky: 6,
  stars: 14,
  aurora: 22,
  horizon: 30,
  floor: 44,
} as const;

/** Below this the loop parks itself; a half-pixel of drift is not worth a frame. */
const SETTLE = 0.0006;

interface Props {
  /** Passed in so the caller can freeze the backdrop behind a modal if needed. */
  paused?: boolean;
}

export function MenuBackdrop({ paused = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const sky = useRef<HTMLDivElement>(null);
  const aurora = useRef<HTMLDivElement>(null);
  const stars = useRef<HTMLDivElement>(null);
  const horizon = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);

  const device = useMemo(() => detectDevice(), []);
  const lite = isLiteTier(device.tier);
  const still = device.reducedMotion;

  // Deterministic so the sky is the same one every session — a starfield that
  // reshuffles on each navigation reads as noise rather than as a place.
  const starShadow = useMemo(() => buildStars(lite ? 34 : 68), [lite]);

  useEffect(() => {
    if (still || paused) return;

    // Target and current deflection, both in -1..1.
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    let frame = 0;
    let last = 0;

    const write = (): void => {
      // A single template per layer; the browser parses these into the same
      // matrix it would build from discrete properties.
      if (sky.current) sky.current.style.transform = shift(cx, cy, DEPTH.sky);
      if (stars.current) stars.current.style.transform = shift(cx, cy, DEPTH.stars);
      if (aurora.current) aurora.current.style.transform = shift(cx, cy, DEPTH.aurora);
      if (horizon.current) horizon.current.style.transform = shift(cx, cy, DEPTH.horizon);
      // The floor already carries a perspective rotation, so its parallax has
      // to be composed *after* that transform or the rotation is discarded.
      if (floor.current) {
        floor.current.style.transform = `perspective(320px) rotateX(62deg) translate3d(${(-cx * DEPTH.floor).toFixed(2)}px, 0, 0)`;
      }
    };

    const tick = (now: number): void => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;

      // Frame-rate independent exponential smoothing. The layers trail the
      // finger by design: instant tracking feels like a sticker on the glass.
      const k = 1 - Math.exp(-4.5 * dt);
      cx += (tx - cx) * k;
      cy += (ty - cy) * k;
      write();

      if (Math.abs(tx - cx) < SETTLE && Math.abs(ty - cy) < SETTLE) {
        cx = tx;
        cy = ty;
        write();
        frame = 0;
        last = 0;
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    const kick = (): void => {
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const onPointer = (event: PointerEvent): void => {
      tx = (event.clientX / window.innerWidth) * 2 - 1;
      ty = (event.clientY / window.innerHeight) * 2 - 1;
      kick();
    };

    // Tilt. iOS 13+ gates this behind a permission prompt that must follow a
    // user gesture; asking for it to move a background would be rude, so on
    // iOS the backdrop simply stays still and the pointer path never fires.
    const onTilt = (event: DeviceOrientationEvent): void => {
      if (event.gamma == null || event.beta == null) return;
      tx = clamp(event.gamma / 35, -1, 1);
      // Phones are held at roughly 40° from flat; that posture is "centred".
      ty = clamp((event.beta - 40) / 35, -1, 1);
      kick();
    };

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('deviceorientation', onTilt, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('deviceorientation', onTilt);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [still, paused]);

  return (
    <div className="backdrop" ref={root} aria-hidden="true">
      <div className="backdrop__sky" ref={sky} />
      {!lite && <div className="backdrop__aurora" ref={aurora} />}
      <div className="backdrop__stars" ref={stars}>
        <i style={{ boxShadow: starShadow }} />
      </div>
      <div className="backdrop__horizon" ref={horizon} />
      {!lite && <div className="backdrop__floor" ref={floor} />}
    </div>
  );
}

function shift(x: number, y: number, depth: number): string {
  return `translate3d(${(-x * depth).toFixed(2)}px, ${(-y * depth * 0.6).toFixed(2)}px, 0)`;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The starfield, as one box-shadow list on one 2px dot.
 *
 * Offsets are in viewport units so the field reflows with the window without
 * any resize handling, and the whole thing is a single paint — the alternative,
 * one element per star, is 68 nodes and 68 composited layers.
 */
function buildStars(count: number): string {
  const rng = createRng(hashString('tartan:menu:stars'));
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, 100);
    // Weighted toward the top: stars below the horizon line would be lights in
    // the ground.
    const y = rng.range(0, 68) * (0.4 + rng.next() * 0.6);
    const bright = rng.next();
    const alpha = 0.25 + bright * 0.55;
    const spread = bright > 0.88 ? 0.5 : 0;
    parts.push(`${x.toFixed(2)}vw ${y.toFixed(2)}vh 0 ${spread}px rgba(226,247,255,${alpha.toFixed(2)})`);
  }
  return parts.join(', ');
}
