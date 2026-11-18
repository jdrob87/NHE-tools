// Draws the NHE home-screen icons. Not used at runtime.
const fs = require('fs');
const zlib = require('zlib');

const GLYPHS = {
  N: [
    '10001',
    '11001',
    '10101',
    '10011',
    '10001',
    '10001',
    '10001',
  ],
  H: [
    '10001',
    '10001',
    '10001',
    '11111',
    '10001',
    '10001',
    '10001',
  ],
  E: [
    '11111',
    '10000',
    '10000',
    '11110',
    '10000',
    '10000',
    '11111',
  ],
};

const INK = [11, 13, 16];
const PANEL = [28, 36, 48];
const AMBER = [255, 181, 71];

function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function insideRoundRect(x, y, size, radius) {
  const right = size - 1;
  const bottom = size - 1;
  let cx = x;
  let cy = y;
  if (x < radius && y < radius) {
    cx = radius;
    cy = radius;
  } else if (x > right - radius && y < radius) {
    cx = right - radius;
    cy = radius;
  } else if (x < radius && y > bottom - radius) {
    cx = radius;
    cy = bottom - radius;
  } else if (x > right - radius && y > bottom - radius) {
    cx = right - radius;
    cy = bottom - radius;
  } else {
    return true;
  }
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function rgb(x, y, size) {
  const radius = Math.round(size * 0.22);
  if (!insideRoundRect(x, y, size, radius)) return INK;

  const text = 'NHE';
  const cols = 5;
  const rows = 7;
  const gap = 1;
  const unitsW = text.length * cols + (text.length - 1) * gap;
  const scale = Math.max(1, Math.min(
    Math.floor((size * 0.78) / unitsW),
    Math.floor((size * 0.46) / rows),
  ));
  const pixW = unitsW * scale;
  const pixH = rows * scale;
  const x0 = Math.floor((size - pixW) / 2);
  const y0 = Math.floor((size - pixH) / 2) - Math.floor(scale * 0.15);
  const lx = x - x0;
  const ly = y - y0;
  if (lx < 0 || ly < 0 || lx >= pixW || ly >= pixH) return PANEL;

  const ux = Math.floor(lx / scale);
  const uy = Math.floor(ly / scale);
  let cursor = 0;
  for (const ch of text) {
    if (ux >= cursor && ux < cursor + cols) {
      return GLYPHS[ch][uy][ux - cursor] === '1' ? AMBER : PANEL;
    }
    cursor += cols + gap;
  }
  return PANEL;
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = rgb(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(`${__dirname}/public`, { recursive: true });
fs.writeFileSync(`${__dirname}/public/apple-touch-icon.png`, png(180));
fs.writeFileSync(`${__dirname}/public/icon-192.png`, png(192));
fs.writeFileSync(`${__dirname}/public/icon-512.png`, png(512));
console.log('wrote apple-touch-icon.png, icon-192.png, icon-512.png');
