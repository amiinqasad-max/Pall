/**
 * Procedural texture generation.
 *
 * There is no sprite atlas to download. Every texture the game uses is drawn
 * into an offscreen canvas at boot and uploaded once. This costs about 40ms on
 * a slow phone — hidden behind the splash — and in exchange the whole art
 * pipeline ships as code: no atlas packing step, no cache-busting, no
 * resolution variants, and a new ball skin is nine numbers in a data file.
 *
 * Textures are generated at a fixed high resolution and scaled down by the
 * renderer, so they stay crisp on a 3x display without shipping 3x assets.
 */

import Phaser from 'phaser';
import type { BallSkin, Trail } from '@/types';

type Ctx = CanvasRenderingContext2D;

const hex = (color: number, alpha = 1): string => {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
};

function makeCanvas(scene: Phaser.Scene, key: string, size: number, height = size): { canvas: HTMLCanvasElement; ctx: Ctx } {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const texture = scene.textures.createCanvas(key, size, height);
  if (!texture) throw new Error(`could not create canvas texture "${key}"`);
  const canvas = texture.getCanvas();
  const ctx = texture.getContext();
  ctx.clearRect(0, 0, size, height);
  return { canvas, ctx };
}

function commit(scene: Phaser.Scene, key: string): void {
  (scene.textures.get(key) as Phaser.Textures.CanvasTexture).refresh();
}

// --- Ball ---------------------------------------------------------------------

export const BALL_TEXTURE_SIZE = 160;

/**
 * The ball. Drawn as a shaded sphere: a radial base for the body, a rim light
 * on the lower edge (bounced light off the track), a specular highlight upper
 * left, and a faint equator band so rotation is legible when it rolls.
 */
export function generateBallTexture(scene: Phaser.Scene, skin: BallSkin, key = 'ball'): string {
  const size = BALL_TEXTURE_SIZE;
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  const r = size / 2 - 6;

  // Outer glow, sitting outside the sphere silhouette.
  const glow = ctx.createRadialGradient(c, c, r * 0.7, c, c, r + 6);
  glow.addColorStop(0, hex(skin.palette.glow, 0.5));
  glow.addColorStop(1, hex(skin.palette.glow, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Body.
  const body = ctx.createRadialGradient(c - r * 0.32, c - r * 0.36, r * 0.1, c, c, r);
  body.addColorStop(0, hex(skin.palette.core));
  body.addColorStop(0.55, hex(skin.palette.glow));
  body.addColorStop(1, hex(skin.palette.rim));
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();

  // Rim light: a crescent along the bottom-right, as if lit by the track.
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.clip();
  const rim = ctx.createRadialGradient(c + r * 0.45, c + r * 0.5, r * 0.15, c + r * 0.4, c + r * 0.45, r * 1.1);
  rim.addColorStop(0, hex(skin.palette.glow, 0.75));
  rim.addColorStop(1, hex(skin.palette.glow, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  // Equator band — the visual cue that makes the roll read at speed. Kept
  // faint: at full strength it reads as a ring around the ball rather than a
  // marking on it.
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = hex(skin.palette.spec);
  ctx.lineWidth = size * 0.04;
  ctx.beginPath();
  ctx.ellipse(c, c, r * 0.72, r * 0.24, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Specular highlight.
  const spec = ctx.createRadialGradient(c - r * 0.34, c - r * 0.4, 0, c - r * 0.34, c - r * 0.4, r * 0.52);
  spec.addColorStop(0, hex(skin.palette.spec, 0.95));
  spec.addColorStop(0.5, hex(skin.palette.spec, 0.25));
  spec.addColorStop(1, hex(skin.palette.spec, 0));
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = spec;
  ctx.fill();

  commit(scene, key);
  return key;
}

// --- Particles ----------------------------------------------------------------

/** Soft round particle. One texture, tinted per trail — no per-skin uploads. */
export function generateParticleTexture(scene: Phaser.Scene, key = 'particle', size = 48): string {
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  commit(scene, key);
  return key;
}

/** Hard four-point star, for spark trails and impact bursts. */
export function generateSparkTexture(scene: Phaser.Scene, key = 'spark', size = 48): string {
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  ctx.translate(c, c);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(c * 0.18, -c * 0.35, 0, -c);
    ctx.quadraticCurveTo(-c * 0.18, -c * 0.35, 0, 0);
    ctx.fill();
  }
  commit(scene, key);
  return key;
}

/** Soft elliptical blob used as the ball's contact shadow. */
export function generateShadowTexture(scene: Phaser.Scene, key = 'shadow', size = 96): string {
  const { ctx } = makeCanvas(scene, key, size, size / 2);
  const g = ctx.createRadialGradient(size / 2, size / 4, 0, size / 2, size / 4, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(size / 2, size / 4);
  ctx.scale(1, 0.5);
  ctx.translate(-size / 2, -size / 4);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size / 2);
  ctx.restore();
  commit(scene, key);
  return key;
}

// --- Collectables -------------------------------------------------------------

/** The score prism: a faceted octahedron seen head-on. */
export function generatePrismTexture(scene: Phaser.Scene, key = 'prism', size = 96): string {
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  const r = size * 0.38;

  const glow = ctx.createRadialGradient(c, c, r * 0.3, c, c, size / 2);
  glow.addColorStop(0, 'rgba(245,158,11,0.5)');
  glow.addColorStop(1, 'rgba(245,158,11,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Left facet, darker; right facet, lit. The seam down the middle is what
  // makes a flat shape read as a solid.
  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c - r * 0.68, c);
  ctx.lineTo(c, c + r);
  ctx.closePath();
  ctx.fillStyle = '#b45309';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c + r * 0.68, c);
  ctx.lineTo(c, c + r);
  ctx.closePath();
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(c, c - r);
  ctx.lineTo(c - r * 0.68, c);
  ctx.lineTo(c + r * 0.68, c);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,251,235,0.85)';
  ctx.fill();

  commit(scene, key);
  return key;
}

// --- Obstacles ----------------------------------------------------------------

/**
 * A slab: the base shape for blocks, sliding walls and falling platforms.
 * Drawn with a lit top edge and a dark base so it reads as a solid volume once
 * the projection scales it.
 */
export function generateSlabTexture(
  scene: Phaser.Scene,
  key: string,
  opts: { top: number; body: number; accent: number; stripes?: boolean },
  width = 128,
  height = 128,
): string {
  const { ctx } = makeCanvas(scene, key, width, height);
  const inset = 4;

  const body = ctx.createLinearGradient(0, 0, 0, height);
  body.addColorStop(0, hex(opts.top));
  body.addColorStop(0.35, hex(opts.body));
  body.addColorStop(1, hex(opts.body, 0.82));
  ctx.fillStyle = body;
  roundRect(ctx, inset, inset, width - inset * 2, height - inset * 2, 10);
  ctx.fill();

  // Hazard chevrons, angled so they read as motion even when static.
  if (opts.stripes) {
    ctx.save();
    roundRect(ctx, inset, inset, width - inset * 2, height - inset * 2, 10);
    ctx.clip();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = hex(opts.accent);
    const step = width / 6;
    for (let x = -height; x < width + height; x += step * 2) {
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x + step, height);
      ctx.lineTo(x + step + height, 0);
      ctx.lineTo(x + height, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Emissive top edge — the part that catches the eye at distance.
  ctx.fillStyle = hex(opts.accent, 0.95);
  roundRect(ctx, inset + 2, inset + 2, width - inset * 2 - 4, height * 0.07, 4);
  ctx.fill();

  ctx.strokeStyle = hex(opts.accent, 0.35);
  ctx.lineWidth = 2;
  roundRect(ctx, inset, inset, width - inset * 2, height - inset * 2, 10);
  ctx.stroke();

  commit(scene, key);
  return key;
}

/** Rotating barrier / spinner arm: a long bar with lit caps. */
export function generateBarTexture(scene: Phaser.Scene, key: string, color: number, accent: number): string {
  const width = 256;
  const height = 48;
  const { ctx } = makeCanvas(scene, key, width, height);

  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, hex(accent, 0.9));
  g.addColorStop(0.3, hex(color));
  g.addColorStop(1, hex(color, 0.7));
  ctx.fillStyle = g;
  roundRect(ctx, 2, 6, width - 4, height - 12, height / 3);
  ctx.fill();

  ctx.fillStyle = hex(accent);
  for (const x of [10, width - 34]) {
    roundRect(ctx, x, 10, 24, height - 20, 6);
    ctx.fill();
  }

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = hex(accent);
  roundRect(ctx, 2, 6, width - 4, 4, 2);
  ctx.fill();

  commit(scene, key);
  return key;
}

/** One vertex of a hexagon centred at (cx, cy), flat side up. */
function hexPoint(cx: number, cy: number, r: number, rotation: number, i: number): [number, number] {
  const angle = rotation + (Math.PI / 3) * i - Math.PI / 2;
  return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
}

/**
 * A hexagon ring built from six independently-coloured edges rather than one
 * stroke, so the palette visibly sweeps around it — the "holographic" read a
 * single-colour ring can't give you. Each edge fades between two accent
 * colours from the shared energy palette.
 */
function strokeHoloHex(ctx: Ctx, cx: number, cy: number, r: number, rotation: number, thickness: number, colors: number[]): void {
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const [x1, y1] = hexPoint(cx, cy, r, rotation, i);
    const [x2, y2] = hexPoint(cx, cy, r, rotation, i + 1);
    const c1 = colors[i % colors.length];
    const c2 = colors[(i + 1) % colors.length];
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, hex(c1, 0.95));
    g.addColorStop(1, hex(c2, 0.95));
    ctx.strokeStyle = g;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

/** The energy palette every gate texture draws from: cyan, electric blue, violet, magenta. */
const ENERGY_RING_COLORS = [0x67e8f9, 0x22d3ee, 0x7c3aed, 0xd946ef];

/**
 * Energy gate arch: the decorative marker spanning the whole road above a
 * gate obstacle. Three concentric holographic hex rings, nodes at every
 * vertex, and a scatter of drifting sparks — additive-blended in the scene so
 * the dark canvas background contributes nothing and only the rings glow.
 */
export function generateEnergyGateTexture(scene: Phaser.Scene, key: string): string {
  const size = 320;
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  const colors = ENERGY_RING_COLORS;

  // Ambient bloom behind the rings — under additive blending this is what
  // reads as the gate casting light onto the road around it.
  const bloom = ctx.createRadialGradient(c, c, size * 0.08, c, c, size * 0.5);
  bloom.addColorStop(0, 'rgba(34,211,238,0.16)');
  bloom.addColorStop(0.55, 'rgba(124,58,237,0.09)');
  bloom.addColorStop(1, 'rgba(124,58,237,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, size, size);

  const rings: [number, number, number, number[]][] = [
    [size * 0.46, 0, size * 0.022, colors],
    [size * 0.34, Math.PI / 6, size * 0.018, [...colors].reverse()],
    [size * 0.22, 0, size * 0.014, colors],
  ];
  for (const [r, rotation, thickness, ringColors] of rings) {
    strokeHoloHex(ctx, c, c, r, rotation, thickness, ringColors);
    // A bright emitter node at every vertex, like the ring is machinery
    // rather than a painted line.
    for (let i = 0; i < 6; i++) {
      const [x, y] = hexPoint(c, c, r, rotation, i);
      const node = ctx.createRadialGradient(x, y, 0, x, y, size * 0.035);
      const color = ringColors[i % ringColors.length];
      node.addColorStop(0, 'rgba(255,255,255,0.9)');
      node.addColorStop(0.4, hex(color, 0.7));
      node.addColorStop(1, hex(color, 0));
      ctx.fillStyle = node;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Loose sparks drifting between the rings.
  const sparkAngles = [0.4, 1.3, 2.1, 3.0, 3.7, 4.6, 5.4, 6.0];
  for (let i = 0; i < sparkAngles.length; i++) {
    const radius = size * (0.26 + (i % 3) * 0.07);
    const x = c + Math.cos(sparkAngles[i]) * radius;
    const y = c + Math.sin(sparkAngles[i]) * radius;
    const color = colors[i % colors.length];
    const spark = ctx.createRadialGradient(x, y, 0, x, y, size * 0.022);
    spark.addColorStop(0, 'rgba(255,255,255,0.95)');
    spark.addColorStop(1, hex(color, 0));
    ctx.fillStyle = spark;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.022, 0, Math.PI * 2);
    ctx.fill();
  }

  commit(scene, key);
  return key;
}

/**
 * Energy gate hazard panel: the solid, lethal span drawn over every blocked
 * lane. Unlike the arch, this stays opaque and dense — a slab of dark energy
 * with a magenta containment field along its edges — because this is the
 * part a player dies against, and it must never read as decoration.
 */
export function generateEnergyHazardTexture(scene: Phaser.Scene, key: string): string {
  const size = 192;
  const { ctx } = makeCanvas(scene, key, size);
  const inset = size * 0.07;

  // The dark core. Opaque enough that it reads as solid at a glance.
  const core = ctx.createLinearGradient(0, 0, 0, size);
  core.addColorStop(0, 'rgba(32,10,44,0.92)');
  core.addColorStop(0.5, 'rgba(10,6,20,0.95)');
  core.addColorStop(1, 'rgba(32,10,44,0.92)');
  ctx.fillStyle = core;
  roundRect(ctx, inset, inset, size - inset * 2, size - inset * 2, size * 0.06);
  ctx.fill();

  // Cyan circuit traces — the holographic detail that ties it to the rest of
  // the gate without competing with the hazard colour.
  ctx.save();
  roundRect(ctx, inset, inset, size - inset * 2, size - inset * 2, size * 0.06);
  ctx.clip();
  ctx.strokeStyle = 'rgba(103,232,249,0.32)';
  ctx.lineWidth = size * 0.008;
  for (const t of [0.28, 0.5, 0.72]) {
    ctx.beginPath();
    ctx.moveTo(inset, size * t);
    ctx.lineTo(size - inset, size * t);
    ctx.stroke();
  }
  ctx.restore();

  // The containment field: a hot magenta glow down each edge. This is the
  // one colour reserved for "this will end your run" — nothing else in the
  // gate uses it this saturated.
  for (const side of [inset, size - inset]) {
    const edge = ctx.createLinearGradient(side - size * 0.16, 0, side + size * 0.16, 0);
    edge.addColorStop(0, 'rgba(217,70,239,0)');
    edge.addColorStop(0.5, 'rgba(232,121,249,0.95)');
    edge.addColorStop(1, 'rgba(217,70,239,0)');
    ctx.fillStyle = edge;
    ctx.fillRect(side - size * 0.16, 0, size * 0.32, size);
  }

  // Hazard brackets top and bottom — the "this is armed" tell, echoed from
  // the machined-corner language the rest of the obstacle set already uses.
  ctx.fillStyle = 'rgba(232,121,249,0.9)';
  const b = size * 0.12;
  const brackets: [number, number][] = [
    [inset, inset],
    [size - inset - b, inset],
    [inset, size - inset - size * 0.05],
    [size - inset - b, size - inset - size * 0.05],
  ];
  for (const [x, y] of brackets) {
    roundRect(ctx, x, y, b, size * 0.05, 3);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(103,232,249,0.5)';
  ctx.lineWidth = size * 0.018;
  roundRect(ctx, inset, inset, size - inset * 2, size - inset * 2, size * 0.06);
  ctx.stroke();

  commit(scene, key);
  return key;
}

/** Laser beam: a horizontal bar with a hot white core. */
export function generateLaserTexture(scene: Phaser.Scene, key: string, color: number): string {
  const width = 256;
  const height = 64;
  const { ctx } = makeCanvas(scene, key, width, height);
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, hex(color, 0));
  g.addColorStop(0.32, hex(color, 0.65));
  g.addColorStop(0.5, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.68, hex(color, 0.65));
  g.addColorStop(1, hex(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Fade the ends so the beam does not terminate in a hard edge.
  const ends = ctx.createLinearGradient(0, 0, width, 0);
  ends.addColorStop(0, 'rgba(0,0,0,1)');
  ends.addColorStop(0.08, 'rgba(0,0,0,0)');
  ends.addColorStop(0.92, 'rgba(0,0,0,0)');
  ends.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = ends;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  commit(scene, key);
  return key;
}

/** Radial glow, used for gate auras, boost pads and the pickup shine. */
export function generateGlowTexture(scene: Phaser.Scene, key = 'glow', size = 128): string {
  const { ctx } = makeCanvas(scene, key, size);
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  commit(scene, key);
  return key;
}

/**
 * Roadside marker post. These are pure set dressing, but they are the single
 * most effective depth cue in a pseudo-3D track: a row of verticals streaming
 * past the edge of frame reads as speed in a way the road surface never does
 * on its own.
 */
export function generatePostTexture(scene: Phaser.Scene, key: string, color: number, accent: number): string {
  const width = 32;
  const height = 128;
  const { ctx } = makeCanvas(scene, key, width, height);

  const body = ctx.createLinearGradient(0, 0, width, 0);
  body.addColorStop(0, hex(color, 0.25));
  body.addColorStop(0.5, hex(color, 0.95));
  body.addColorStop(1, hex(color, 0.25));
  ctx.fillStyle = body;
  ctx.fillRect(width * 0.34, 0, width * 0.32, height);

  // Emissive cap: the part that stays visible once the post is a few pixels
  // tall in the distance.
  const cap = ctx.createRadialGradient(width / 2, height * 0.09, 0, width / 2, height * 0.09, width * 0.5);
  cap.addColorStop(0, hex(accent, 1));
  cap.addColorStop(0.5, hex(accent, 0.55));
  cap.addColorStop(1, hex(accent, 0));
  ctx.fillStyle = cap;
  ctx.fillRect(0, 0, width, height * 0.32);

  commit(scene, key);
  return key;
}

/** Chevron used for boost zone arrows painted on the road. */
export function generateChevronTexture(scene: Phaser.Scene, key = 'chevron', size = 128): string {
  const { ctx } = makeCanvas(scene, key, size, size * 0.6);
  const h = size * 0.6;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size, h * 0.62);
  ctx.lineTo(size * 0.82, h);
  ctx.lineTo(size * 0.5, h * 0.4);
  ctx.lineTo(size * 0.18, h);
  ctx.lineTo(0, h * 0.62);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  commit(scene, key);
  return key;
}

// --- Trail palette ------------------------------------------------------------

/** The particle texture a trail style should emit. */
export function textureForTrail(trail: Trail): string {
  switch (trail.style) {
    case 'spark':
      return 'spark';
    case 'ribbon':
    case 'bloom':
    case 'stream':
    default:
      return 'particle';
  }
}

// --- helpers ------------------------------------------------------------------

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Builds every texture that does not depend on the equipped loadout. */
export function generateSharedTextures(scene: Phaser.Scene): void {
  generateParticleTexture(scene);
  generateSparkTexture(scene);
  generateShadowTexture(scene);
  generatePrismTexture(scene);
  generateGlowTexture(scene);
  generateChevronTexture(scene);
  generatePostTexture(scene, 'decor.post', 0x0b3b3a, 0x2dd4bf);

  generateSlabTexture(scene, 'obstacle.block', { top: 0x1f4b4a, body: 0x0f2f33, accent: 0x2dd4bf, stripes: true });
  generateSlabTexture(scene, 'obstacle.wall', { top: 0x4a2f1f, body: 0x33200f, accent: 0xf59e0b, stripes: true });
  generateSlabTexture(scene, 'obstacle.platform', { top: 0x2a3550, body: 0x18203a, accent: 0x818cf8, stripes: false });
  generateBarTexture(scene, 'obstacle.bar', 0x1b3a4a, 0x38bdf8);
  generateBarTexture(scene, 'obstacle.spinner', 0x3a1b4a, 0xe879f9);
  generateEnergyGateTexture(scene, 'obstacle.gate');
  generateEnergyHazardTexture(scene, 'obstacle.gate.hazard');
  generateLaserTexture(scene, 'obstacle.laser', 0xf43f5e);
}
