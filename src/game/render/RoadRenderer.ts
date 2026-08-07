/**
 * The road renderer.
 *
 * Walks the segment list from the camera outward, integrating curvature into a
 * lateral offset as it goes, and fills one trapezoid per segment. This is the
 * classic pre-3D arcade technique, and it is here for a reason: the entire
 * visible world costs a few hundred triangles and zero state changes, which is
 * what makes 60fps achievable on hardware that would choke on a real 3D scene.
 *
 * The walk also records the accumulated curve offset and elevation per segment
 * into flat typed arrays. Every other entity — the ball, obstacles, prisms,
 * particles — reads its screen position from those, so nothing can ever drift
 * off the road: there is exactly one integration of the curve per frame, and
 * everybody shares it.
 */

import Phaser from 'phaser';
import { GAME } from '@/game/config';
import { fogFactor, mixColor, shadeColor, type CameraState, type Projector } from '@/game/render/projection';
import type { Segment, TrackGenerator } from '@/game/world/TrackGenerator';
import type { Environment } from '@/data/progression';

export class RoadRenderer {
  private graphics: Phaser.GameObjects.Graphics;
  private offsets: Float32Array;
  private elevations: Float32Array;
  private screenYs: Float32Array;
  private scales: Float32Array;
  private firstDrawn = 0;
  private drawnCount = 0;
  private drawDistance: number;
  /** How far out lane dividers are drawn; shortened on the low tier. */
  private laneRange = 0.72;

  /** Screen Y of the furthest visible road point, for fog placement. */
  private vanishY = 0;

  constructor(
    scene: Phaser.Scene,
    private projector: Projector,
    private env: Environment,
    drawDistance: number,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setDepth(10);
    this.drawDistance = drawDistance;
    const capacity = GAME.camera.drawDistance + 8;
    this.offsets = new Float32Array(capacity);
    this.elevations = new Float32Array(capacity);
    this.screenYs = new Float32Array(capacity);
    this.scales = new Float32Array(capacity);
  }

  setEnvironment(env: Environment): void {
    this.env = env;
  }

  /**
   * `fullDetail` shortens how far lane dividers reach, it does not remove them.
   *
   * Lane markings are gameplay information — they are how a player reads which
   * lane the ball is in and which lane an obstacle occupies. Dropping them on
   * the low tier (the first version of this did) makes the game measurably
   * harder on exactly the devices that can least afford it. Cutting their draw
   * distance recovers nearly all of the cost and costs the player nothing,
   * because the near field is the only place they are actually read.
   */
  setQuality(drawDistance: number, fullDetail: boolean): void {
    this.drawDistance = Math.min(drawDistance, GAME.camera.drawDistance);
    this.laneRange = fullDetail ? 0.72 : 0.4;
  }

  get horizonY(): number {
    return this.vanishY;
  }

  /**
   * Renders the road and records per-segment geometry.
   *
   * Segments are drawn far-to-near so nearer road paints over the far road,
   * which removes the need for any depth sorting or clipping between them.
   */
  render(camera: CameraState, track: TrackGenerator): void {
    const g = this.graphics;
    g.clear();

    const segLength = GAME.world.segmentLength;
    const baseIndex = Math.floor(camera.z / segLength);
    this.firstDrawn = baseIndex;

    // First pass: integrate curvature forward and project every segment.
    let offset = 0;
    let delta = 0;
    let count = 0;

    for (let i = 0; i < this.drawDistance; i++) {
      const segment = track.segmentByIndex(baseIndex + i);
      if (!segment) break;

      offset += delta;
      delta += segment.curve * segLength;

      const projected = this.projector.project(camera, 0, segment.y, segment.z, offset);
      this.offsets[i] = offset;
      this.elevations[i] = segment.y;
      this.screenYs[i] = projected.visible ? projected.screenY : -1;
      this.scales[i] = projected.scale;
      count = i + 1;
    }
    this.drawnCount = count;

    // Second pass: fill trapezoids, far to near. Painting in that order means
    // nearer road covers the road behind a crest, so hill occlusion comes free
    // and no depth sorting or clipping is needed anywhere in the scene.
    this.vanishY = this.projector.horizon;

    const road = this.env.palette.road;
    const shoulder = this.env.palette.shoulder;
    const fog = this.env.palette.fog;

    for (let i = count - 1; i >= 1; i--) {
      const near = track.segmentByIndex(baseIndex + i - 1);
      const far = track.segmentByIndex(baseIndex + i);
      if (!near || !far) continue;
      if (this.screenYs[i] < 0 || this.screenYs[i - 1] < 0) continue;

      const yFar = this.screenYs[i];
      const yNear = this.screenYs[i - 1];
      // Degenerate or occluded slice.
      if (yNear <= yFar) continue;

      const scaleFar = this.scales[i];
      const scaleNear = this.scales[i - 1];
      const halfFar = GAME.world.roadHalfWidth * far.widthScale * scaleFar;
      const halfNear = GAME.world.roadHalfWidth * near.widthScale * scaleNear;
      const xFar = this.projector.width / 2 + (this.offsets[i] - camera.x) * scaleFar;
      const xNear = this.projector.width / 2 + (this.offsets[i - 1] - camera.x) * scaleNear;

      if (yFar < this.vanishY) this.vanishY = yFar;

      const fogT = fogFactor(i / this.drawDistance, 2.1);
      if (fogT > 0.985) continue;

      if (far.hole) {
        // A chasm: draw nothing but the shoulder rails so the hole reads as a
        // hole rather than as unrendered space.
        this.fillQuad(
          g,
          xFar - halfFar * 1.16,
          yFar,
          xFar - halfFar,
          yFar,
          xNear - halfNear,
          yNear,
          xNear - halfNear * 1.16,
          yNear,
          mixColor(shadeColor(this.env.palette.rumble, 0.5), fog, fogT),
        );
        this.fillQuad(
          g,
          xFar + halfFar,
          yFar,
          xFar + halfFar * 1.16,
          yFar,
          xNear + halfNear * 1.16,
          yNear,
          xNear + halfNear,
          yNear,
          mixColor(shadeColor(this.env.palette.rumble, 0.5), fog, fogT),
        );
        continue;
      }

      // Shoulder / rumble strip, drawn slightly wider than the road.
      const shoulderColor = mixColor(far.lit ? shoulder[0] : shoulder[1], fog, fogT);
      const wideFar = halfFar * (1 + GAME.world.shoulder);
      const wideNear = halfNear * (1 + GAME.world.shoulder);
      this.fillQuad(
        g,
        xFar - wideFar,
        yFar,
        xFar + wideFar,
        yFar,
        xNear + wideNear,
        yNear,
        xNear - wideNear,
        yNear,
        shoulderColor,
      );

      // Road surface.
      const surface = mixColor(far.boost ? shadeColor(road[0], 1.25) : far.lit ? road[0] : road[1], fog, fogT);
      this.fillQuad(g, xFar - halfFar, yFar, xFar + halfFar, yFar, xNear + halfNear, yNear, xNear - halfNear, yNear, surface);

      // Emissive edge rails. These are what give the track its shape at
      // distance, so they survive even on the low quality tier.
      const rail = mixColor(far.boost ? this.env.palette.accent : this.env.palette.rumble, fog, fogT * 0.8);
      const railFar = Math.max(1, halfFar * 0.045);
      const railNear = Math.max(1.5, halfNear * 0.045);
      this.fillQuad(
        g,
        xFar - halfFar - railFar,
        yFar,
        xFar - halfFar + railFar,
        yFar,
        xNear - halfNear + railNear,
        yNear,
        xNear - halfNear - railNear,
        yNear,
        rail,
      );
      this.fillQuad(
        g,
        xFar + halfFar - railFar,
        yFar,
        xFar + halfFar + railFar,
        yFar,
        xNear + halfNear + railNear,
        yNear,
        xNear + halfNear - railNear,
        yNear,
        rail,
      );

      // Lane dividers, drawn continuously rather than dashed.
      //
      // Dashing them by segment parity looks correct on paper and fails in
      // practice: perspective makes a single 6m band cover the entire bottom
      // third of the screen, so the near field — where the player is actually
      // looking — spends seconds at a time with no lane reference at all. The
      // motion cue lives in the surface banding and the roadside posts instead.
      if (fogT < this.laneRange) {
        const laneColor = mixColor(this.env.palette.lane, fog, fogT);
        const lanes = GAME.world.lanes;
        for (let l = 1; l < lanes; l++) {
          const t = l / lanes - 0.5;
          const markFar = Math.max(0.6, halfFar * 0.012);
          const markNear = Math.max(1, halfNear * 0.012);
          const cFar = xFar + t * halfFar * 2;
          const cNear = xNear + t * halfNear * 2;
          this.fillQuad(
            g,
            cFar - markFar,
            yFar,
            cFar + markFar,
            yFar,
            cNear + markNear,
            yNear,
            cNear - markNear,
            yNear,
            laneColor,
          );
        }
      }
    }
  }

  private fillQuad(
    g: Phaser.GameObjects.Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    x4: number,
    y4: number,
    color: number,
  ): void {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineTo(x3, y3);
    g.lineTo(x4, y4);
    g.closePath();
    g.fillPath();
  }

  /**
   * Accumulated curve offset at a world z, interpolated between segments.
   * Entities call this so they sit on the same curved road the player sees.
   */
  curveOffsetAt(z: number): number {
    const segLength = GAME.world.segmentLength;
    const index = Math.floor(z / segLength) - this.firstDrawn;
    if (index < 0) return this.drawnCount > 0 ? this.offsets[0] : 0;
    if (index >= this.drawnCount - 1) return this.drawnCount > 0 ? this.offsets[this.drawnCount - 1] : 0;
    const t = (z % segLength) / segLength;
    return this.offsets[index] + (this.offsets[index + 1] - this.offsets[index]) * t;
  }

  /** Road surface elevation at a world z. */
  elevationAt(z: number): number {
    const segLength = GAME.world.segmentLength;
    const index = Math.floor(z / segLength) - this.firstDrawn;
    if (index < 0 || this.drawnCount === 0) return 0;
    if (index >= this.drawnCount - 1) return this.elevations[Math.max(0, this.drawnCount - 1)];
    const t = (z % segLength) / segLength;
    return this.elevations[index] + (this.elevations[index + 1] - this.elevations[index]) * t;
  }

  /** True when there is no road under this point — used for chasm deaths. */
  static isHole(segment: Segment | undefined): boolean {
    return Boolean(segment?.hole);
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
