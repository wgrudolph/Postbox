// Generates the PWA icons (an envelope-slot mark in --ink on --paper) with no dependencies.
// Run: npm run icons
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const PAPER = [0xfa, 0xf8, 0xf4];
const INK = [0x1c, 0x1b, 0x19];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** scale: fraction of the canvas the mark spans (smaller for maskable safe zone). */
function draw(size, scale) {
  const SS = 4; // supersampling
  const out = Buffer.alloc(size * size * 3);
  const u = size * scale; // mark box size
  const c = size / 2;
  // A letter going into a slot: the slot is a thick rounded bar; above it the
  // upper part of an envelope (outline plus V flap) is visible.
  const slotHW = u * 0.44, slotHH = u * 0.045, slotCY = c + u * 0.2;
  const envHW = u * 0.3, envTop = c - u * 0.32, envBottom = slotCY, stroke = u * 0.05, envR = u * 0.05;
  const envCY = (envTop + envBottom) / 2, envHH = (envBottom - envTop) / 2;
  const flapY = c - u * 0.02;
  const segDist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
        const inSlot = sdRoundRect(x, y, c, slotCY, slotHW, slotHH, slotHH) <= 0;
        let inEnv = false;
        if (y < slotCY - slotHH - stroke * 0.9) {
          const d = sdRoundRect(x, y, c, envCY, envHW, envHH, envR);
          const inOutline = Math.abs(d + stroke / 2) <= stroke / 2;
          const inFlap =
            segDist(x, y, c - envHW + stroke, envTop + stroke, c, flapY) <= stroke / 2 ||
            segDist(x, y, c + envHW - stroke, envTop + stroke, c, flapY) <= stroke / 2;
          inEnv = inOutline || inFlap;
        }
        if (inSlot || inEnv) hits++;
      }
      const a = hits / (SS * SS);
      const i = (py * size + px) * 3;
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(PAPER[k] * (1 - a) + INK[k] * a);
    }
  }
  return png(size, out);
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
const files = {
  "icon-192.png": draw(192, 0.78),
  "icon-512.png": draw(512, 0.78),
  "apple-touch-icon.png": draw(180, 0.72),
  "maskable-192.png": draw(192, 0.58), // inside the 80% safe zone
  "maskable-512.png": draw(512, 0.58),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(new URL(name, dir), buf);
console.log("wrote", Object.keys(files).join(", "));
