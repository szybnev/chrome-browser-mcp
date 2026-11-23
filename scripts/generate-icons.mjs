import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function sampleCubic(p0, p1, p2, p3, steps = 32) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0[0] +
      3 * mt * mt * t * p1[0] +
      3 * mt * t * t * p2[0] +
      t * t * t * p3[0];
    const y =
      mt * mt * mt * p0[1] +
      3 * mt * mt * t * p1[1] +
      3 * mt * t * t * p2[1] +
      t * t * t * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function distToPolyline(px, py, pts) {
  let minD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < minD) minD = d;
  }
  return minD;
}

function blendOver(dst, srcR, srcG, srcB, srcA) {
  if (srcA <= 0) return;
  const outA = srcA + dst[3] * (1 - srcA);
  if (outA <= 0) return;
  dst[0] = (srcR * srcA + dst[0] * dst[3] * (1 - srcA)) / outA;
  dst[1] = (srcG * srcA + dst[1] * dst[3] * (1 - srcA)) / outA;
  dst[2] = (srcB * srcA + dst[2] * dst[3] * (1 - srcA)) / outA;
  dst[3] = outA;
}

// Concept 2 — "Bridge Aperture" geometry in 128x128 space
const TOP_ARC = [...sampleCubic([34, 52], [34, 35], [52, 28], [68, 34], 36), [82, 40]];
const BOT_ARC = [...sampleCubic([94, 76], [94, 93], [76, 100], [60, 94], 36), [46, 88]];
const BRIDGE_BAR = [
  [36, 74],
  [92, 54],
];

function renderBridgeApertureRgba(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4; // 4x4 supersampling = 16 subpixel samples per pixel
  const scale = 128 / size;
  const aaWidth = scale * 0.75;

  function cov(sdf) {
    return Math.max(0, Math.min(1, 0.5 - sdf / aaWidth));
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) * scale;
          const v = (y + (sy + 0.5) / ss) * scale;

          // Rounded square background: x=4..124, y=4..124, rx=28 (half-extent 60)
          const qx = Math.abs(u - 64) - (60 - 28);
          const qy = Math.abs(v - 64) - (60 - 28);
          const rectSdf =
            Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 28;
          const bgA = cov(rectSdf);
          if (bgA <= 0) continue;

          // Diagonal gradient: #2563eb (37, 99, 235) -> #0f172a (15, 23, 42)
          const t = Math.max(0, Math.min(1, (u + v - 8) / 240));
          const bgR = 37 + (15 - 37) * t;
          const bgG = 99 + (23 - 99) * t;
          const bgB = 235 + (42 - 235) * t;

          const px = [bgR, bgG, bgB, bgA];

          // Upper white arc (stroke-width 10 -> radius 5)
          const topA = cov(distToPolyline(u, v, TOP_ARC) - 5.0) * bgA;
          blendOver(px, 255, 255, 255, topA);

          // Lower ice-blue arc (#93c5fd -> 147, 197, 253)
          const botA = cov(distToPolyline(u, v, BOT_ARC) - 5.0) * bgA;
          blendOver(px, 147, 197, 253, botA);

          // Connecting diagonal bridge bar (stroke-width 7 -> radius 3.5, opacity 0.9)
          const barA = cov(distToPolyline(u, v, BRIDGE_BAR) - 3.5) * 0.9 * bgA;
          blendOver(px, 255, 255, 255, barA);

          // Central MCP node: outer white circle r=11, inner cobalt core r=5 (#1d4ed8)
          const dCenter = Math.hypot(u - 64, v - 64);
          const outerA = cov(dCenter - 11.0) * bgA;
          blendOver(px, 255, 255, 255, outerA);

          const innerA = cov(dCenter - 5.0) * bgA;
          blendOver(px, 29, 78, 216, innerA);

          // Premultiplied accumulation for clean alpha averaging
          accR += px[0] * px[3];
          accG += px[1] * px[3];
          accB += px[2] * px[3];
          accA += px[3];
        }
      }

      const samples = ss * ss;
      const finalA = accA / samples;
      const idx = (y * size + x) * 4;
      if (finalA > 0) {
        rgba[idx] = Math.round(accR / accA);
        rgba[idx + 1] = Math.round(accG / accA);
        rgba[idx + 2] = Math.round(accB / accA);
        rgba[idx + 3] = Math.round(finalA * 255);
      } else {
        rgba[idx + 3] = 0;
      }
    }
  }
  return rgba;
}

function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawRows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    rawRows[rowStart] = 0; // filter None
    rgba.copy(rawRows, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const compressed = deflateSync(rawRows, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const BRIDGE_APERTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#bg)"/>
  <path d="M34 52 C34 35, 52 28, 68 34 L82 40" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>
  <path d="M94 76 C94 93, 76 100, 60 94 L46 88" stroke="#93c5fd" stroke-width="10" stroke-linecap="round"/>
  <path d="M36 74 L92 54" stroke="#ffffff" stroke-width="7" stroke-linecap="round" opacity="0.9"/>
  <circle cx="64" cy="64" r="11" fill="#ffffff"/>
  <circle cx="64" cy="64" r="5" fill="#1d4ed8"/>
</svg>
`;

const iconDir = resolve(rootDir, 'packages/extension/public/icons');
mkdirSync(iconDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = encodePng(size, renderBridgeApertureRgba(size));
  const out = resolve(iconDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`Generated ${out} (${size}x${size}, ${png.length} bytes)`);
}
writeFileSync(resolve(iconDir, 'icon.svg'), BRIDGE_APERTURE_SVG);

const pluginAssetsDir = resolve(rootDir, 'plugins/antigravity/assets');
mkdirSync(pluginAssetsDir, { recursive: true });
writeFileSync(resolve(pluginAssetsDir, 'logo.svg'), BRIDGE_APERTURE_SVG);
console.log('Generated Bridge Aperture SVG -> packages/extension/public/icons/icon.svg & plugins/antigravity/assets/logo.svg');
