// Membuat ikon PNG (192, 512, maskable, apple-touch) dari desain yang sama dengan public/icons/icon.svg.
// Jalankan: node tools/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [0x0f, 0x76, 0x6e];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Koordinat dalam ruang 512 x 512 (sama dengan SVG)
function sample(x, y, { rounded, scale }) {
  const inBg = rounded
    ? (() => {
        const r = 112, cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
        return Math.hypot(x - cx, y - cy) <= r;
      })()
    : x >= 0 && x <= 512 && y >= 0 && y <= 512;
  if (!inBg) return null;
  // konten diperkecil di sekitar titik tengah (untuk ikon maskable)
  const u = 256 + (x - 256) / scale, v = 256 + (y - 256) / scale;
  const w = 18;
  const fg = Math.abs(Math.hypot(u - 256, v - 232) - 132) <= w
    || segDist(u, v, 256, 160, 256, 236) <= w
    || segDist(u, v, 256, 236, 308, 268) <= w
    || segDist(u, v, 168, 408, 344, 408) <= w;
  return fg ? [255, 255, 255] : BG;
}

function render(size, opts) {
  const ss = 4, buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((px + (sx + 0.5) / ss) / size) * 512, ((py + (sy + 0.5) / ss) / size) * 512, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = (a / (ss * ss)) * 255; }
    }
  }
  return png(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, { rounded: true, scale: 1 }));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, { rounded: true, scale: 1 }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, { rounded: false, scale: 0.78 }));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), render(180, { rounded: false, scale: 0.9 }));
console.log('Ikon dibuat di', OUT);
