/**
 * Content for the "Read Article" coin-earning method.
 *
 * These are real, in-house explainers about TARTAN itself — there is no
 * external content provider or CMS wired into this build, so rather than
 * fake one, the reward is attached to content the game actually owns and
 * that a player might genuinely want to read. See
 * supabase/migrations/0003_coin_economy.sql's header for why "read for 2
 * minutes" is enforced as a server-timed session rather than a claim that
 * proves anyone read every word.
 */

export interface Article {
  id: string;
  title: string;
  paragraphs: string[];
}

export const ARTICLES: Article[] = [
  {
    id: 'how-the-economy-works',
    title: 'How TARTAN’s Coin Economy Works',
    paragraphs: [
      'Coins are TARTAN’s only virtual currency. They unlock ball skins and trails in the Store, and they can pay for a Revive during a normal run. They are never required to play, and they never affect how the game handles.',
      'Every coin you earn or spend is recorded on the server the moment it happens — watching a rewarded video, finishing a timed article like this one, completing a mission, or buying a coin package. Your balance lives on TARTAN’s servers, not just on your device, so it survives a reinstall once you’re signed in.',
      'Coins cannot be withdrawn, exchanged for cash, transferred to another player, or converted into prize money of any kind. They are a game currency, full stop — the same way an arcade token only ever becomes another play, never change back at the counter.',
      'The Daily Championship and Cash Championship are entirely separate from this coin economy. Coins, purchased items and Revives cannot be used inside a Championship final — everyone starts that run from zero, on equal footing.',
    ],
  },
  {
    id: 'track-fairness',
    title: 'Why Every TARTAN Track Is Actually Fair',
    paragraphs: [
      'TARTAN’s track generator does not just scatter obstacles and hope for the best. Every stretch of road is checked by a fairness solver before it’s ever placed in front of you: it sweeps the full width of the track, at the speeds and lateral movement the ball can actually achieve, and confirms a real, physical path through exists.',
      'This matters because a track that only looks fair — that merely avoids obviously overlapping obstacles — can still hide a gap that’s technically there on paper but impossible to reach in time at speed. TARTAN’s solver checks reachability, not just geometry.',
      'The same seed always produces the same track. That’s what lets the Daily Challenge and the Cash Championship give every player, anywhere in the world, the literal same course — no player ever gets an easier or harder version of today’s run than anyone else.',
      'None of this changes based on what you own, what level you are, or what you’ve bought. A fairness guarantee that only applied to some players wouldn’t be one at all.',
    ],
  },
];

export function getArticle(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}
