// Generates the named-PNG layer-set fixture for the auto-rig e2e (Task 8).
// Pure Node (zlib only) — no canvas/asset deps. Each layer is a 256x256 RGBA
// PNG, transparent background, with one solid shape baked at its on-canvas
// position so alpha-bbox detection + placement have something real to chew on.
// Filenames are the canonical roles the importer parses.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 256;
const H = 256;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  // raw: per row a filter byte (0) then RGBA scanline
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Draw a filled ellipse (cx,cy,rx,ry) of [r,g,b,a] into an RGBA buffer.
function ellipse(rgba, cx, cy, rx, ry, [r, g, b, a]) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const i = (y * W + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = a;
      }
    }
  }
}

function layer(shapes) {
  const rgba = Buffer.alloc(W * H * 4); // transparent
  for (const s of shapes) ellipse(rgba, ...s);
  return encodePng(rgba);
}

// Role layers. NOTE: eye_L = character's LEFT eye = screen RIGHT (x > 128).
const layers = {
  // big hair mass behind (static, headDeformer)
  hair_back: [[128, 116, 116, 124, [122, 84, 70, 255]]],
  // face skin
  face: [[128, 132, 92, 110, [255, 224, 196, 255]]],
  // eyes (dark blue)
  eye_L: [[162, 116, 17, 21, [44, 92, 150, 255]]],
  eye_R: [[94, 116, 17, 21, [44, 92, 150, 255]]],
  // mouth
  mouth: [[128, 182, 24, 11, [200, 84, 92, 255]]],
};

for (const [role, shapes] of Object.entries(layers)) {
  const png = layer(shapes);
  const path = new URL(`./${role}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`wrote ${role}.png (${png.length} bytes)`);
}
