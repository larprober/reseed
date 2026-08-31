'use strict';
/*
 * The Reseed mark, as geometry.
 *
 * A spiral, not a ring: a feed loop whose ends do not meet, warming from a dead
 * grey at the inner end to the accent at the outer tip, where a separate seed
 * sits. Both apps and every icon size are generated from this one file, so the
 * Windows .ico, the Android launcher and the in-app SVG can never drift apart.
 */

const zlib = require('zlib');

const TURNS = 1.62;
const END_ANGLE = -50 * (Math.PI / 180); // outer tip points up-right
const R_INNER = 0.135;
const R_OUTER = 0.325;
const CENTER = [0.5, 0.515];
const STROKE = 0.082;
const SEED_R = 0.058;

const INK_TOP = [0x18, 0x1f, 0x2b];
const INK_BOTTOM = [0x0a, 0x0d, 0x12];
const COLD = [0x4e, 0x60, 0x7c];
const WARM = [0x7f, 0xe3, 0xc4];

function spiral(steps) {
  const pts = [];
  const sweep = TURNS * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = END_ANGLE - sweep * (1 - t);
    const r = R_INNER + (R_OUTER - R_INNER) * t;
    pts.push([CENTER[0] + Math.cos(a) * r, CENTER[1] + Math.sin(a) * r, t]);
  }
  return pts;
}

const FULL = spiral(360);
const TIP = FULL[FULL.length - 1];

// Pull the stroke back from the tip so the seed reads as its own element
// rather than a rounded line cap.
const PTS = (() => {
  const gap = SEED_R * 1.95;
  let walked = 0;
  for (let i = FULL.length - 1; i > 0; i--) {
    walked += Math.hypot(FULL[i][0] - FULL[i - 1][0], FULL[i][1] - FULL[i - 1][1]);
    if (walked >= gap) return FULL.slice(0, i);
  }
  return FULL;
})();

function segDistance(px, py) {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i < PTS.length - 1; i++) {
    const [ax, ay, at] = PTS[i];
    const [bx, by, bt] = PTS[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let u = ((px - ax) * dx + (py - ay) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
    if (d < best) {
      best = d;
      bestT = at + (bt - at) * u;
    }
  }
  return [best, bestT];
}

const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function roundedRect(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px - 0.5) - (halfW - radius);
  const qy = Math.abs(py - 0.5) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/*
 * shape: 'squircle' (Windows / legacy Android), 'circle' (Android round icon),
 * 'bleed' (adaptive-icon foreground — no plate, mark inset to the safe zone).
 */
function render(size, shape) {
  const px = 1 / size;
  const aa = px * 0.85;
  const rgba = Buffer.alloc(size * size * 4);
  // Thin strokes vanish at 16px, so fatten them as the canvas shrinks.
  const boost = size <= 20 ? 1.35 : size <= 32 ? 1.16 : 1;
  const stroke = STROKE * boost;
  const seed = SEED_R * boost;
  // The adaptive foreground is cropped to the middle ~66%, so the mark shrinks.
  const inset = shape === 'bleed' ? 0.62 : 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let u = (x + 0.5) * px;
      let v = (y + 0.5) * px;

      let plateA;
      if (shape === 'circle') {
        plateA = smooth(aa, -aa, Math.hypot(u - 0.5, v - 0.5) - 0.5);
      } else if (shape === 'bleed') {
        plateA = 0;
      } else {
        plateA = smooth(aa, -aa, roundedRect(u, v, 0.5, 0.5, 0.225));
      }

      // Scale about the centre for the inset variants.
      u = 0.5 + (u - 0.5) / inset;
      v = 0.5 + (v - 0.5) / inset;

      const [d, t] = segDistance(u, v);
      const halfW = (stroke * (0.72 + 0.28 * t)) / 2 / inset;
      const strokeA = smooth(halfW + aa, halfW - aa, d / inset);
      const strokeColor = mix(COLD, WARM, smooth(0.42, 0.98, t));
      const seedA = smooth(seed / inset + aa, seed / inset - aa,
        Math.hypot(u - TIP[0], v - TIP[1]) / inset);

      let col = mix(INK_TOP, INK_BOTTOM, smooth(0.05, 0.95, v));
      col = mix(col, strokeColor, strokeA);
      col = mix(col, WARM, seedA);

      const inkA = Math.max(strokeA, seedA);
      const alpha = shape === 'bleed' ? inkA : plateA;
      if (shape === 'bleed') col = mix(strokeColor, WARM, seedA);

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(col[0]);
      rgba[i + 1] = Math.round(col[1]);
      rgba[i + 2] = Math.round(col[2]);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ---------------- encoders ---------------- */

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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 32-bit BGRA DIB with a padded AND mask. The Windows shell reads these
// everywhere, where PNG-in-ICO entries are only honoured from Vista on.
function bmp(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows + mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4; // DIB rows run bottom-up
      const dst = (y * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

function ico(sizes) {
  const entries = sizes.map((size) => {
    const rgba = render(size, 'squircle');
    return { size, data: size >= 128 ? png(size, rgba) : bmp(size, rgba) };
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = entries.map((e) => {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    return d;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.data)]);
}

/* ---------------- vector output ---------------- */

// 32-unit viewBox, matching the SVG symbol and the Android vector drawable.
const VIEW = 32;

const pathData = (() => {
  const pts = PTS.filter((_, i) => i % 3 === 0 || i === PTS.length - 1)
    .map(([x, y]) => `${(x * VIEW).toFixed(2)} ${(y * VIEW).toFixed(2)}`);
  return 'M ' + pts[0] + ' L ' + pts.slice(1).join(' L ');
})();

module.exports = {
  VIEW,
  pathData,
  tip: [+(TIP[0] * VIEW).toFixed(2), +(TIP[1] * VIEW).toFixed(2)],
  seedRadius: +(SEED_R * VIEW).toFixed(2),
  strokeWidth: +(STROKE * VIEW).toFixed(2),
  render,
  png,
  ico
};
