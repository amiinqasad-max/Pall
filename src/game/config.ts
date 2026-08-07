/**
 * Every tunable number in TARTAN lives here.
 *
 * Balance work should never mean hunting through scene code. The values below
 * were tuned against a 60Hz target with a ~1.9s reaction window at the opening
 * speed, narrowing to ~0.9s at terminal speed — fast enough to feel dangerous,
 * never so fast that an obstacle appears inside the player's stopping distance.
 */

export const GAME = {
  /**
   * The camera, expressed as a composition rather than a focal length. The
   * projector solves for the lens that produces this shot on any viewport —
   * see Projector.resize.
   */
  camera: {
    height: 5.5,
    /** How far ahead of the camera the ball sits. Gives it screen presence. */
    playerOffset: 15,
    /** Road width at the ball, as a fraction of the viewport width. */
    roadFill: 1.22,
    /** Where the ball sits vertically, as a fraction of viewport height. */
    ballAnchor: 0.73,
    /** The horizon never rises above this fraction of the height. */
    minHorizon: 0.24,
    /** Segments drawn per frame before the fog swallows the track. */
    drawDistance: 96,
    /** How hard the camera leans into curves, 0..1. */
    curveLean: 0.62,
    /**
     * How quickly the camera's ground reference follows the terrain under it,
     * as an exponential rate (per second). The camera height above the road is
     * fixed; only the elevation it is measured from is smoothed, so a sharp
     * crest eases the horizon instead of snapping it.
     */
    elevationLerp: 5.5,
    /**
     * Hard cap, in metres, on how far the camera's smoothed ground reference
     * may lag the true elevation under the ball. Smoothing alone is unbounded
     * on a long climb, and an unbounded lag is exactly what walks the ball off
     * the top or bottom of the screen.
     */
    maxElevationLag: 3.2,
  },

  world: {
    segmentLength: 6,
    roadHalfWidth: 5.4,
    /** Lane count on a full-width road. Narrow sections mask the outer lanes. */
    lanes: 5,
    /** Rumble strip / edge width as a fraction of the road half width. */
    shoulder: 0.14,
    /** Segments generated per chunk; the generator keeps ~4 chunks live. */
    chunkSize: 60,
    /** How many chunks stay resident ahead of the player. */
    chunksAhead: 4,
  },

  speed: {
    /** Forward speed at the start of a run, m/s. */
    start: 23,
    /** Terminal speed. Reached around 3 minutes in. */
    max: 63,
    /** Linear acceleration, m/s per second of survival. */
    accel: 0.19,
    /** Multiplier applied inside a boost zone. */
    boostMultiplier: 1.42,
    /** How quickly the boost multiplier eases in and out. */
    boostLerp: 2.4,
    /** Speed retained after a rewarded-ad continue, as a fraction of current. */
    continueFalloff: 0.72,
  },

  player: {
    radius: 0.92,
    /** Peak height of a jump, metres. Gravity is derived from this and jumpTime. */
    jumpHeight: 3.5,
    /** Airborne duration, seconds. Deliberately short — this is not a platformer. */
    jumpTime: 0.62,
    /** Downward speed forced by a slam, m/s. Cuts a bad jump short. */
    slamSpeed: 16,
    /**
     * Absolute ceiling on the ball's height above the road, metres. The gravity
     * model cannot exceed `jumpHeight` on its own; this is a structural backstop
     * so no future change to the arc can put the ball outside the shot.
     */
    maxHeight: 4.2,
    /**
     * Depth below the road at which the ball is considered lost. Only reachable
     * over a chasm, where falling is the intended outcome.
     */
    lostBelow: -6,
    /** Seconds of invulnerability after a continue. */
    continueGrace: 1.8,
    /** Lateral distance counted as a near miss. */
    nearMissRadius: 1.5,
  },

  scoring: {
    perMetre: 1,
    perPrism: 25,
    perNearMiss: 15,
    /** Awarded once per difficulty stage cleared. */
    stageBonus: 100,
  },

  /**
   * Difficulty stages. The run walks through these by elapsed time; each one
   * widens the obstacle vocabulary and tightens the spacing. `gapMultiplier`
   * scales the breathing room between hazards, and never drops below the
   * reaction floor computed in TrackGenerator.
   */
  difficulty: {
    stages: [
      { name: 'Drift', atSeconds: 0, density: 0.34, gapMultiplier: 1.9, maxSimultaneous: 1 },
      { name: 'Pulse', atSeconds: 25, density: 0.46, gapMultiplier: 1.55, maxSimultaneous: 2 },
      { name: 'Surge', atSeconds: 60, density: 0.58, gapMultiplier: 1.3, maxSimultaneous: 2 },
      { name: 'Fracture', atSeconds: 105, density: 0.68, gapMultiplier: 1.12, maxSimultaneous: 3 },
      { name: 'Overdrive', atSeconds: 160, density: 0.76, gapMultiplier: 1.0, maxSimultaneous: 3 },
      { name: 'Singularity', atSeconds: 230, density: 0.82, gapMultiplier: 0.94, maxSimultaneous: 3 },
    ],
    /**
     * The fairness floor. However hard the run gets, an obstacle must be
     * visible for at least this long before the player reaches it.
     */
    minReactionSeconds: 0.85,
    /** Guaranteed clear track after every hazard cluster, in seconds. */
    minRecoverySeconds: 0.42,
    /** A safe, empty stretch is forced at least this often. */
    breatherEverySeconds: 22,
    breatherSeconds: 2.6,
  },

  /** Rewarded-ad continue: how many per run, and the cost curve. */
  continues: {
    maxPerRun: 1,
  },

  /** Bounds shared with the server-side run validator. */
  validation: {
    minRunSeconds: 1.5,
    maxRunSeconds: 3600,
    speedTolerance: 1.55,
    scoreTolerance: 1.08,
    maxPrismsPerSegment: 1.2,
  },

  /**
   * Per-tier rendering budgets. `auto` resolves to one of these at boot from
   * the heuristics in systems/device.ts.
   */
  quality: {
    low: {
      drawDistance: 58,
      maxParticles: 24,
      trailRateScale: 0.35,
      shadows: false,
      fogSteps: 6,
      resolutionCap: 1,
      lights: false,
      targetFps: 30,
    },
    medium: {
      drawDistance: 78,
      maxParticles: 60,
      trailRateScale: 0.7,
      shadows: true,
      fogSteps: 10,
      resolutionCap: 1.5,
      lights: true,
      targetFps: 60,
    },
    high: {
      drawDistance: 96,
      maxParticles: 120,
      trailRateScale: 1,
      shadows: true,
      fogSteps: 14,
      resolutionCap: 2,
      lights: true,
      targetFps: 60,
    },
  },

  /**
   * Direct touch steering.
   *
   * The ball follows a target that the finger drags, and chases it with a
   * critically damped spring. Critical damping is the specific choice that
   * makes this feel premium rather than floaty: it is the fastest response that
   * cannot overshoot, so the ball never wobbles around the finger and never
   * needs a deadzone to hide oscillation.
   */
  control: {
    /**
     * How much of the viewport width the finger must travel to cross the whole
     * road. Expressed as a fraction rather than metres-per-pixel so the control
     * feels identical on a 320px phone and a 480px one — a fixed sensitivity
     * makes small screens twitchy and large screens sluggish.
     */
    traverseFraction: 0.5,
    /**
     * Spring frequency in Hz. Higher is more immediate and less forgiving;
     * ~6.5Hz settles in about 100ms, matching the snap of the lane system it
     * replaces without the discrete steps.
     */
    responseHz: 6.5,
    /** Hard ceiling on lateral speed, m/s. A fast flick cannot teleport. */
    maxLateralSpeed: 26,
    /**
     * Fixed integration step, seconds. The spring is stiff enough to go
     * unstable at a 30fps frame time, so it is substepped rather than
     * integrated once per frame — 4 steps at 60fps, 8 at 30fps, each a handful
     * of flops.
     */
    substep: 1 / 240,
    /**
     * Fraction of the finger's release velocity carried into the ball, giving a
     * small flick-through rather than a dead stop. Kept low: this is a
     * precision game, and real inertia fights the player.
     */
    releaseInertia: 0.1,
    /** Target movement speed for held keyboard input, m/s. */
    keyboardSpeed: 15,
    /** A touch under this duration that barely moves is a tap, i.e. a jump. */
    tapMaxMs: 220,
    tapSlopPx: 14,
    /** Upward flick distance that also triggers a jump, in px. */
    flickUpPx: 46,
  },
} as const;

export type QualitySettings = (typeof GAME.quality)['high'];
export type DifficultyStage = (typeof GAME.difficulty.stages)[number];
