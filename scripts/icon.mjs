// Draws media/icon.png: three overlapping discs (three models) blending into one, on a dark tile.
// No dependencies: rasterizes with 4x supersampling and writes the PNG by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4;
const R = 30;
const discs = [
  { x: 64, y: 49, color: [255, 176, 74] }, // amber
  { x: 49, y: 75, color: [124, 140, 255] }, // violet
  { x: 79, y: 75, color: [56, 214, 190] }, // teal
];

function inRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (!inRoundedSquare(x, y, SIZE, 26)) continue;
        // Background: a deep vertical gradient.
        let cr = 22 + (y / SIZE) * 10, cg = 24 + (y / SIZE) * 8, cb = 38 + (y / SIZE) * 20;
        // Screen-blend each disc that covers this sample, so overlaps glow toward white.
        for (const d of discs) {
          if ((x - d.x) ** 2 + (y - d.y) ** 2 <= R * R) {
            cr = 255 - ((255 - cr) * (255 - d.color[0] * 0.85)) / 255;
            cg = 255 - ((255 - cg) * (255 - d.color[1] * 0.85)) / 255;
            cb = 255 - ((255 - cb) * (255 - d.color[2] * 0.85)) / 255;
          }
        }
        r += cr; g += cg; b += cb; a += 255;
      }
    }
    const n = SS * SS;
    const i = (py * SIZE + px) * 4;
    const covered = a / 255;
    pixels[i] = covered ? Math.round(r / covered) : 0;
    pixels[i + 1] = covered ? Math.round(g / covered) : 0;
    pixels[i + 2] = covered ? Math.round(b / covered) : 0;
    pixels[i + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

mkdirSync('media', { recursive: true });
writeFileSync(
  'media/icon.png',
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]),
);
console.log('wrote media/icon.png');
