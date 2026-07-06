// Generates desktop/build/icon.png (512×512) — a simple branded VisualZPL icon
// (slate ground + label plate + barcode + blue accent). Pure Node (zlib), no
// deps. electron-builder derives .ico / .icns / linux icons from this PNG.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;
const buf = Buffer.alloc(S * S * 4);

const set = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
};
const rect = (x0, y0, w, h, r, g, b) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b);
};

// slate ground
rect(0, 0, S, S, 15, 23, 42);
// top sheen
for (let y = 0; y < S; y++) {
  const a = Math.max(0, 0.10 * (1 - y / (S * 0.5)));
  if (a <= 0) break;
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    buf[i] = Math.min(255, buf[i] + 255 * a);
    buf[i + 1] = Math.min(255, buf[i + 1] + 255 * a);
    buf[i + 2] = Math.min(255, buf[i + 2] + 255 * a);
  }
}
// label plate
rect(104, 150, 304, 212, 248, 250, 252);
// barcode bars
let px = 136;
const w = [10, 6, 16, 6, 8, 18, 6, 10, 6, 14, 8, 6, 16, 6, 10, 6, 12];
for (let i = 0; i < w.length && px < 400; i++) {
  if (i % 2 === 0) rect(px, 182, w[i], 104, 15, 23, 42);
  px += w[i] + 6;
}
// blue accent + short line
rect(136, 312, 240, 14, 37, 99, 235);
rect(136, 336, 150, 8, 15, 23, 42);

// ── PNG encode ──
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'icon.png');
fs.writeFileSync(out, png);
console.log(`[gen-icon] wrote ${out} (${png.length} bytes, ${S}x${S})`);
