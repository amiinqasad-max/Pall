/**
 * Generates the TARTAN PWA icon set as real PNGs.
 *
 * The marks are rasterised from signed-distance maths rather than shipped as
 * binaries, so the whole brand identity lives in ~200 lines of reviewable code
 * and regenerates at any size. Run with `node scripts/generate-icons.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const NAVY = [0x08, 0x13, 0x1a];
const NAVY_LIFT = [0x0d, 0x22, 0x2c];
const TEAL = [0x0f, 0x76, 0x6e];
const AMBER = [0xf5, 0x9e, 0x0b];
const WHITE = [0xff, 0xff, 0xff];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a line segment, used for the trail ribbon. */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * Shades one pixel of the icon in normalised coordinates (-1..1 on both axes).
 * `maskable` insets the artwork so Android's circular crop never clips it.
 */
function shade(u, v, aa, maskable) {
  const scale = maskable ? 0.72 : 1;
  const su = u / scale;
  const sv = v / scale;

  // Backplate ------------------------------------------------------------
  const plate = sdRoundRect(su, sv, 0.94, 0.94, 0.34);
  const plateAlpha = 1 - smoothstep(0, aa / scale, plate);
  if (plateAlpha <= 0.001) return [0, 0, 0, 0];

  // Vertical navy gradient with a teal bloom from the upper-left.
  let rgb = mix(NAVY_LIFT, NAVY, clamp01((sv + 1) / 2));
  const bloom = 1 - clamp01(Math.hypot(su + 0.45, sv + 0.55) / 1.5);
  rgb = mix(rgb, TEAL, bloom * bloom * 0.55);
  const ember = 1 - clamp01(Math.hypot(su - 0.55, sv - 0.75) / 1.3);
  rgb = mix(rgb, AMBER, ember * ember * 0.22);

  // Trail ribbon: three tapering strokes sweeping up-right behind the ball.
  const ballX = 0.3;
  const ballY = -0.16;
  const ballR = 0.34;
  const strokes = [
    { ax: -0.78, ay: 0.5, bx: ballX - 0.1, by: ballY + 0.06, w: 0.085, c: TEAL, a: 0.95 },
    { ax: -0.62, ay: 0.74, bx: ballX - 0.22, by: ballY + 0.3, w: 0.058, c: AMBER, a: 0.85 },
    { ax: -0.5, ay: 0.24, bx: ballX - 0.3, by: ballY - 0.14, w: 0.042, c: AMBER, a: 0.5 },
  ];
  for (const s of strokes) {
    const d = sdSegment(su, sv, s.ax, s.ay, s.bx, s.by);
    // Taper the stroke toward its tail for a motion-blur read.
    const along = clamp01((su - s.ax) / (s.bx - s.ax));
    const w = s.w * lerp(0.25, 1, along);
    const cover = (1 - smoothstep(w - aa, w + aa, d)) * s.a;
    if (cover > 0) rgb = mix(rgb, s.c, cover);
  }

  // The ball itself: white core, teal rim light, soft amber contact shadow.
  const dBall = Math.hypot(su - ballX, sv - ballY) - ballR;
  const glow = 1 - smoothstep(-ballR, ballR * 1.9, dBall);
  rgb = mix(rgb, TEAL, glow * 0.3);
  const ballCover = 1 - smoothstep(-aa, aa, dBall);
  if (ballCover > 0) {
    const shadeT = clamp01((sv - ballY) / (ballR * 1.6) + 0.35);
    let ball = mix(WHITE, mix(WHITE, TEAL, 0.75), shadeT);
    const spec = 1 - clamp01(Math.hypot(su - (ballX - 0.12), sv - (ballY - 0.13)) / (ballR * 0.75));
    ball = mix(ball, WHITE, spec * spec);
    rgb = mix(rgb, ball, ballCover);
  }

  // Inner hairline keeps the plate crisp against light wallpapers.
  const edge = Math.abs(plate + 0.035) - 0.012;
  const edgeCover = (1 - smoothstep(0, aa, edge)) * 0.16;
  if (edgeCover > 0) rgb = mix(rgb, WHITE, edgeCover);

  const alpha = maskable ? 1 : plateAlpha;
  return [rgb[0], rgb[1], rgb[2], alpha * 255];
}

function renderPixels(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1.6 / size; // ~1.6px of analytic antialiasing
  const ss = size <= 96 ? 3 : 2; // supersampling factor, heavier for small icons
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          const px = shade(u, v, aa, maskable);
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// --- Minimal PNG encoder (RGBA8, filter type 0) ------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no per-scanline filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Emit ---------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const targets = [
  { name: 'icon-64.png', size: 64, maskable: false },
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'maskable-192.png', size: 192, maskable: true },
  { name: 'maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: true },
];

for (const t of targets) {
  writeFileSync(join(OUT, t.name), encodePng(renderPixels(t.size, t.maskable), t.size));
  console.log('wrote', t.name, `${t.size}x${t.size}`);
}
