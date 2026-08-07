/**
 * The 2.5D projection.
 *
 * TARTAN is not a 3D game. It is a 2D renderer driven by a perspective divide,
 * the same trick arcade racers used before hardware transforms existed. Every
 * point in the world has (x, y, z) in metres; projecting it is one division.
 * That is the entire reason this runs at 60fps on a 1GB Android phone: there
 * is no scene graph, no matrix stack, no depth buffer, and no shader beyond
 * Phaser's default quad pipeline.
 *
 * Coordinate system:
 *   x — lateral, metres from the centre line, +x is right
 *   y — vertical, metres above the road surface, +y is up
 *   z — forward, metres travelled down the track, always increasing
 */

export interface Projected {
  screenX: number;
  screenY: number;
  /** Pixels per metre at this depth. Multiply any world size by it. */
  scale: number;
  /** Road half-width in pixels at this depth. */
  roadWidth: number;
  /** 0 at the camera, 1 at the fog plane. Drives tint and alpha. */
  depth: number;
  /** False when the point is behind the camera and must not be drawn. */
  visible: boolean;
}

export interface CameraState {
  /** Camera position along the track. */
  z: number;
  /** Lateral camera offset in metres — follows the ball, damped. */
  x: number;
  /** Camera height above the road. */
  height: number;
  /** Accumulated curve offset applied to the world as it recedes. */
  curveX: number;
  /** Vertical world offset from hills. */
  worldY: number;
}

/**
 * How the shot should be composed, in terms a designer can reason about,
 * rather than in focal lengths. The projector solves for the camera that
 * produces this framing on whatever viewport it is handed.
 */
export interface Framing {
  /** Distance from the camera to the ball, metres. */
  playerOffset: number;
  cameraHeight: number;
  roadHalfWidth: number;
  playerRadius: number;
  /** Road width at the ball, as a fraction of the viewport width. */
  roadFill: number;
  /** Where the ball sits vertically, as a fraction of viewport height. */
  ballAnchor: number;
  /** The horizon is never allowed above this fraction of the height. */
  minHorizon: number;
}

export class Projector {
  /** Viewport half width in pixels. */
  private halfWidth = 0;
  private centreY = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private horizonY = 0;
  private roadHalfWidth = 5.4;
  private fogDistance = 1;
  private cameraDepth = 1.6;

  /**
   * Solves for a camera that puts the road and the ball where the framing asks
   * for them.
   *
   * Fixing the focal length instead — the obvious approach — makes the shot
   * depend entirely on the viewport's aspect ratio: the same constants that
   * frame a 20:9 phone correctly put the road at twice the screen width on a
   * squat one, and off the bottom of the screen in landscape. Deriving the
   * camera from the composition means every device gets the intended shot.
   */
  resize(width: number, height: number, framing: Framing): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.halfWidth = width / 2;
    this.roadHalfWidth = framing.roadHalfWidth;

    const eyeToBall = framing.cameraHeight - framing.playerRadius;

    // Pixels per metre at the ball's depth, from the desired road width.
    let scaleAtPlayer = (width * framing.roadFill) / (2 * framing.roadHalfWidth);

    // On a short or landscape viewport that scale would push the horizon off
    // the top of the screen. Narrow the road rather than lose the horizon.
    const horizonFromWidth = framing.ballAnchor * height - eyeToBall * scaleAtPlayer;
    const minHorizon = height * framing.minHorizon;
    if (horizonFromWidth < minHorizon) {
      scaleAtPlayer = ((framing.ballAnchor - framing.minHorizon) * height) / eyeToBall;
    }

    this.horizonY = Math.max(minHorizon, framing.ballAnchor * height - eyeToBall * scaleAtPlayer);
    this.centreY = this.horizonY;
    // scale = cameraDepth * height / (2 * dz), solved at dz = playerOffset.
    this.cameraDepth = (2 * framing.playerOffset * scaleAtPlayer) / height;
  }

  setFogDistance(metres: number): void {
    this.fogDistance = Math.max(1, metres);
  }

  get horizon(): number {
    return this.horizonY;
  }

  get width(): number {
    return this.viewportWidth;
  }

  get height(): number {
    return this.viewportHeight;
  }

  /**
   * Projects a world point through the camera.
   *
   * `curveOffset` is the accumulated lateral shift from the curve integration
   * done by the road renderer, passed in rather than recomputed, because the
   * renderer already walks the segments in order and has it to hand.
   */
  project(camera: CameraState, x: number, y: number, z: number, curveOffset: number): Projected {
    const dz = z - camera.z;

    if (dz <= 0.35) {
      // Behind or on top of the camera: the divide explodes. Callers check
      // `visible` and skip; returning zeroed geometry avoids NaNs leaking into
      // Phaser transforms, which is far harder to debug than a missing sprite.
      return { screenX: 0, screenY: 0, scale: 0, roadWidth: 0, depth: 1, visible: false };
    }

    const scale = (this.cameraDepth * this.viewportHeight) / (2 * dz);
    const worldX = x - camera.x + curveOffset;
    // The camera's eye is at `worldY + height` in world space — the elevation
    // of the road beneath it, plus its height above that road. Both terms are
    // therefore subtracted. Adding `camera.worldY` here instead doubles the
    // terrain elevation rather than cancelling it, which is invisible while the
    // ground is flat (elevation 0) and catastrophic on the first hill.
    const worldY = y - camera.height - camera.worldY;

    return {
      screenX: this.halfWidth + worldX * scale,
      screenY: this.centreY - worldY * scale,
      scale,
      roadWidth: this.roadHalfWidth * scale,
      depth: Math.min(1, dz / this.fogDistance),
      visible: true,
    };
  }

  /** Cheap depth-only query, for culling before doing the full projection. */
  depthOf(camera: CameraState, z: number): number {
    return Math.min(1, Math.max(0, (z - camera.z) / this.fogDistance));
  }
}

/**
 * Fog blend. Objects do not simply fade to transparent — they fade *into the
 * fog colour*, which is what sells depth. Returns a 0..1 blend factor with an
 * ease so the near field stays fully saturated.
 */
export function fogFactor(depth: number, density = 2.4): number {
  const t = Math.min(1, Math.max(0, depth));
  return 1 - Math.exp(-density * t * t);
}

/** Blends two packed 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = (ar + (br - ar) * clamped) | 0;
  const g = (ag + (bg - ag) * clamped) | 0;
  const bl = (ab + (bb - ab) * clamped) | 0;
  return (r << 16) | (g << 8) | bl;
}

/** Scales a colour's brightness, used for the lit/unlit road stripes. */
export function shadeColor(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}
