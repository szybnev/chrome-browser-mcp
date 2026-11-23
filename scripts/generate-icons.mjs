import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

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

function renderIconRgba(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.44;
  const corner = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded square SDF
      const dx = Math.max(Math.abs(x - cx) - (size * 0.46 - corner), 0);
      const dy = Math.max(Math.abs(y - cy) - (size * 0.46 - corner), 0);
      const distRect = Math.hypot(dx, dy) - corner;

      if (distRect > 0.7) {
        rgba[idx + 3] = 0;
        continue;
      }

      const alphaBg = distRect > -0.7 ? Math.max(0, Math.min(1, 0.5 - distRect / 1.4)) : 1;

      // Deep indigo -> electric cyan gradient
      const t = (x + y) / (2 * size);
      let r = Math.round(18 + t * 14);
      let g = Math.round(28 + t * 52);
      let b = Math.round(78 + t * 94);

      // Outer browser ring + agent cursor / node reticle
      const distC = Math.hypot(x - cx, y - cy);
      const ringOuter = radius * 0.78;
      const ringInner = radius * 0.56;
      const coreR = radius * 0.24;

      // Highlight ring (cyan-teal)
      if (distC >= ringInner && distC <= ringOuter) {
        const angle = Math.atan2(y - cy, x - cx);
        // Leave a crisp directional notch on the bottom-right for cursor arrow feel
        if (!(angle > 0.25 && angle < 1.15)) {
          r = 56;
          g = 228;
          b = 212;
        }
      }

      // Inner AI core pulse dot
      if (distC <= coreR) {
        r = 255;
        g = 255;
        b = 255;
      }

      // Diagonal pointer spark at bottom-right
      const px = (x - cx) / radius;
      const py = (y - cy) / radius;
      if (px > 0.12 && py > 0.12 && px < 0.82 && py < 0.82 && Math.abs(px - py) < 0.16) {
        r = 140;
        g = 248;
        b = 255;
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(alphaBg * 255);
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

const iconDir = resolve(rootDir, 'packages/extension/public/icons');
mkdirSync(iconDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = encodePng(size, renderIconRgba(size));
  const out = resolve(iconDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`Generated ${out} (${size}x${size}, ${png.length} bytes)`);
}

const pluginAssetsDir = resolve(rootDir, 'plugins/antigravity/assets');
mkdirSync(pluginAssetsDir, { recursive: true });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#121c4e"/>
      <stop offset="100%" stop-color="#2050ac"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="28" fill="url(#bg)"/>
  <path d="M98 76 A38 38 0 1 1 76 98" stroke="#38e4d4" stroke-width="11" stroke-linecap="round"/>
  <circle cx="64" cy="64" r="14" fill="#ffffff"/>
  <path d="M76 76 L100 100" stroke="#8cf8ff" stroke-width="11" stroke-linecap="round"/>
</svg>
`;
writeFileSync(resolve(pluginAssetsDir, 'logo.svg'), svg);
console.log('Generated plugins/antigravity/assets/logo.svg');
