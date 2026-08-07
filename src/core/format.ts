/** Display formatting shared by the HUD and the React UI. */

/** 1234 -> "1,234". Uses grouping the platform locale understands. */
export function num(value: number): string {
  return Math.round(value).toLocaleString();
}

/** 12500 -> "12.5K", 3400000 -> "3.4M". For tight spots like the coin chip. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trim(value / 1000)}K`;
  if (abs < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

function trim(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Distance in metres -> "1,204 m" or "1.2 km". */
export function distance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

/** 0.42 -> "42%". */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** "12" -> "12th", "1" -> "1st". Leaderboard ranks. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Country code -> flag emoji. Returns an empty string for unknown input. */
export function flagEmoji(countryCode?: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '';
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
