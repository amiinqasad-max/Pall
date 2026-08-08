/**
 * The in-run HUD.
 *
 * Every value here changes 60 times a second. Routing that through React state
 * would mean 60 reconciliations per second competing with the game loop for the
 * main thread, so the tick handler writes to DOM nodes directly through refs
 * and React only ever re-renders for discrete events (a stage change, the
 * countdown). This is the one place in the app where bypassing React is worth
 * it, and it is contained to this file.
 */

import { useEffect, useRef, useState } from 'react';
import { gameEvents } from '@/game/events';
import { IconButton } from '@/ui/components/primitives';
import { num } from '@/core/format';

interface Props {
  visible: boolean;
  showFps: boolean;
  bestScore: number;
  onPause: () => void;
}

export function GameHud({ visible, showFps, bestScore, onPause }: Props) {
  const scoreRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const prismRef = useRef<HTMLSpanElement>(null);
  const fpsRef = useRef<HTMLDivElement>(null);
  const chainRef = useRef<HTMLDivElement>(null);

  const [countdown, setCountdown] = useState<number | null>(null);
  const [stageName, setStageName] = useState<string | null>(null);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    let lastScore = -1;
    let lastDistance = -1;
    let lastSpeed = -1;
    let lastPrisms = -1;
    let lastChain = -1;
    let lastFps = -1;

    const offTick = gameEvents.on('tick', (tick) => {
      // Only touch the DOM when the rendered text would actually change;
      // assigning an identical string still invalidates layout in some engines.
      if (tick.score !== lastScore && scoreRef.current) {
        scoreRef.current.textContent = num(tick.score);
        lastScore = tick.score;
      }
      if (tick.distance !== lastDistance && distanceRef.current) {
        distanceRef.current.textContent = `${num(tick.distance)} m`;
        lastDistance = tick.distance;
      }
      const kmh = Math.round(tick.speed * 3.6);
      if (kmh !== lastSpeed && speedRef.current) {
        speedRef.current.textContent = `${kmh} km/h`;
        speedRef.current.style.color = tick.boosting ? 'var(--cyan-bright)' : '';
        lastSpeed = kmh;
      }
      if (tick.prisms !== lastPrisms && prismRef.current) {
        prismRef.current.textContent = String(tick.prisms);
        lastPrisms = tick.prisms;
      }
      if (tick.chain !== lastChain && chainRef.current) {
        const multiplier = Math.min(5, 1 + Math.floor(tick.chain / 5) * 0.5);
        chainRef.current.textContent = tick.chain >= 5 ? `${multiplier.toFixed(1)}× CHAIN` : '';
        lastChain = tick.chain;
      }
      if (showFps && fpsRef.current) {
        const fps = Math.round(tick.fps);
        if (fps !== lastFps) {
          fpsRef.current.textContent = `${fps} fps`;
          lastFps = fps;
        }
      }
    });

    const offCountdown = gameEvents.on('countdown', ({ value }) => {
      setCountdown(value > 0 ? value : null);
    });

    const offStage = gameEvents.on('stage', ({ name, stage }) => {
      if (stage === 0) return;
      setStageName(name);
      setTimeout(() => setStageName(null), 1600);
    });

    const offStarted = gameEvents.on('started', () => {
      setCountdown(null);
      setTimeout(() => setHint(false), 4200);
    });

    return () => {
      offTick();
      offCountdown();
      offStage();
      offStarted();
    };
  }, [showFps]);

  return (
    <div className="hud" aria-hidden={!visible} style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.2s' }}>
      <div className="hud__top">
        <div>
          <div className="hud__score" ref={scoreRef}>
            0
          </div>
          <div className="hud__sub">Best {num(bestScore)}</div>
        </div>

        <div className="hud__right">
          <div className="hud__pause">
            <IconButton icon="❚❚" label="Pause" onClick={onPause} />
          </div>
          <div className="small numeric" ref={distanceRef}>
            0 m
          </div>
          <div className="tiny numeric muted" ref={speedRef}>
            0 km/h
          </div>
          <div className="tiny muted">
            <span aria-hidden="true">◈ </span>
            <span className="numeric" ref={prismRef}>
              0
            </span>
          </div>
        </div>
      </div>

      <div className="hud__chain numeric" ref={chainRef} />

      {stageName && <div className="hud__stage">{stageName}</div>}

      {countdown !== null && (
        <div className="hud__countdown">
          <span key={countdown}>{countdown}</span>
        </div>
      )}

      {hint && countdown === null && (
        <div className="hud__hint">
          Hold and drag anywhere to steer · tap to jump
        </div>
      )}

      {showFps && <div className="hud__fps" ref={fpsRef} />}
    </div>
  );
}
