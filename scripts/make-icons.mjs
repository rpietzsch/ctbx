/**
 * Generates the PWA icon set as real PNGs, with no image dependency.
 *
 * The mark is a terminal chevron and caret on the app's dark surface colour —
 * legible at 48px, and flat enough that iOS masking it into a squircle cannot
 * clip anything meaningful.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [11, 13, 16, 255]; // --color-surface, dark
const FG = [122, 162, 247, 255]; // --color-accent, dark

/**
 * @param size    pixel dimensions
 * @param inset   fraction of the canvas kept clear of the mark. Maskable icons
 *                need the content inside the inner 80% so a circular or
 *                squircle mask cannot cut it.
 */
function drawIcon(size, inset) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG);

  const pad = size * inset;
  const box = size - pad * 2;
  const stroke = Math.max(2, Math.round(box * 0.1));

  const disc = (x, y) => {
    for (let dy = -stroke / 2; dy <= stroke / 2; dy += 0.4) {
      for (let dx = -stroke / 2; dx <= stroke / 2; dx += 0.4) {
        put(Math.round(x + dx), Math.round(y + dy), FG);
      }
    }
  };

  // Chevron ">": both arms converge on an apex to the right, as a shell prompt
  // is written. The caret then sits clear of it, further right and on the
  // baseline, so the two never touch at small sizes.
  const cy = size / 2;
  const arm = box * 0.28;
  const tailX = pad + box * 0.14;
  const apexX = tailX + arm;
  for (let t = 0; t <= 1; t += 0.002) {
    disc(tailX + arm * t, cy - arm * (1 - t));
    disc(tailX + arm * t, cy + arm * (1 - t));
  }

  // Caret: the underscore the prompt blinks on, aligned to the chevron's feet.
  const barY = cy + arm - stroke / 2;
  for (let x = apexX + stroke * 1.4; x <= pad + box * 0.95; x += 0.4) {
    for (let dy = 0; dy < stroke; dy++) put(Math.round(x), Math.round(barY + dy), FG);
  }

  return encodePng(size, size, px);
}

const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });

const files = [
  ['icon-192.png', drawIcon(192, 0.18)],
  ['icon-512.png', drawIcon(512, 0.18)],
  // Maskable art must survive an aggressive crop, so it sits further in.
  ['icon-maskable-512.png', drawIcon(512, 0.28)],
  // iOS applies its own squircle and never honours transparency.
  ['apple-touch-icon.png', drawIcon(180, 0.2)],
];

for (const [name, data] of files) {
  writeFileSync(`${outDir}/${name}`, data);
  console.log(name, data.length, 'bytes');
}
