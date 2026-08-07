import { useUi } from '@/state/ui';
import { useStore, useMissions } from '@/state/store';
import { dailyMissions, weeklyMissions } from '@/data/missions';
import { feedback } from '@/ui/components/primitives';
import type { ScreenId } from '@/types';

const ITEMS: { id: ScreenId; label: string; icon: string }[] = [
  { id: 'home', label: 'Play', icon: '▶' },
  { id: 'store', label: 'Store', icon: '◈' },
  { id: 'missions', label: 'Missions', icon: '◎' },
  { id: 'leaderboard', label: 'Ranks', icon: '⌁' },
  { id: 'profile', label: 'Profile', icon: '◇' },
];

/**
 * Bottom navigation. The dots are load-bearing: a player should be able to see
 * at a glance that there is something to collect without opening every tab.
 */
export function NavBar() {
  const screen = useUi((s) => s.screen);
  const go = useUi((s) => s.go);

  const daily = useMissions('daily');
  const weekly = useMissions('weekly');
  const save = useStore((s) => s.save);

  const missionsReady =
    [...daily, ...weekly].some((m) => !m.progress.claimed && m.progress.progress >= m.def.target);

  // The home dot means "there is a reward waiting here": an unclaimed daily
  // challenge payout, or a login reward that has not been taken today.
  const challengeReady = save.daily.completed && !save.daily.claimed;
  const loginRewardReady = save.rewards.lastClaimDay !== save.daily.day;

  const dots: Partial<Record<ScreenId, boolean>> = {
    missions: missionsReady,
    home: challengeReady || loginRewardReady,
  };

  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          className={`nav__item ${screen === item.id ? 'nav__item--active' : ''}`}
          aria-current={screen === item.id ? 'page' : undefined}
          onClick={() => {
            if (screen === item.id) return;
            feedback('toggle');
            go(item.id);
          }}
        >
          <span className="nav__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
          {dots[item.id] && <span className="nav__dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  );
}

/** Exported for tests and for the home screen's own badge logic. */
export function hasUnclaimedMissions(
  save: ReturnType<typeof useStore.getState>['save'],
): boolean {
  const defs = [...dailyMissions(save.missions.dailyKey), ...weeklyMissions(save.missions.weeklyKey)];
  const progress = [...save.missions.daily, ...save.missions.weekly];
  return defs.some((def) => {
    const entry = progress.find((p) => p.id === def.id);
    return Boolean(entry && !entry.claimed && entry.progress >= def.target);
  });
}
