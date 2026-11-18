import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  boxMask,
  dilate,
  erode,
  fillHoles,
  flood,
  loadIllustration,
  majority,
  polygonMask,
  pushPull,
  readPictureOnCanvas,
  type CanvasSize,
  type Mask,
} from "../src/illustration";

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-illustration-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A mask from rows of `#` (on) and `.` (off). */
function fromArt(rows: string[]): { size: CanvasSize; m: Mask } {
  const size = { width: rows[0].length, height: rows.length };
  const m = new Uint8Array(size.width * size.height);
  rows.forEach((r, y) =>
    [...r].forEach((ch, x) => (m[y * size.width + x] = ch === "#" ? 1 : 0)),
  );
  return { size, m };
}

function toArt(size: CanvasSize, m: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size.height; y++) {
    let r = "";
    for (let x = 0; x < size.width; x++) r += m[y * size.width + x] ? "#" : ".";
    rows.push(r);
  }
  return rows;
}

describe("raster helpers", () => {
  it("polygonMask takes the pixels whose centres lie inside", () => {
    const size = { width: 7, height: 5 };
    const m = polygonMask(size, [
      [0, 0],
      [6, 0],
      [0, 6],
    ]);
    // Row y's centre crosses the hypotenuse at x = 5.5 - y.
    expect(toArt(size, m)).toEqual([
      "#####..",
      "####...",
      "###....",
      "##.....",
      "#......",
    ]);
  });

  it("polygonMask covers a square's columns x0..x1-1 and rows y0..y1-1", () => {
    const size = { width: 8, height: 7 };
    const m = polygonMask(size, [
      [2, 1],
      [6, 1],
      [6, 5],
      [2, 5],
    ]);
    expect(m.reduce((t, v) => t + v, 0)).toBe(16);
    expect(toArt(size, m)).toEqual([
      "........",
      "..####..",
      "..####..",
      "..####..",
      "..####..",
      "........",
      "........",
    ]);
  });

  it("boxMask covers both corners and clips to the canvas", () => {
    const size = { width: 5, height: 4 };
    expect(toArt(size, boxMask(size, [1, 1, 3, 2]))).toEqual([
      ".....",
      ".###.",
      ".###.",
      ".....",
    ]);
    expect(toArt(size, boxMask(size, [-3, 2, 9, 9]))).toEqual([
      ".....",
      ".....",
      "#####",
      "#####",
    ]);
  });

  it("dilate grows by a Chebyshev radius and erode shrinks back", () => {
    const { size, m } = fromArt([
      ".......",
      ".......",
      ".......",
      "...#...",
      ".......",
      ".......",
      ".......",
    ]);
    const grown = dilate(size, m, 2);
    expect(toArt(size, grown)).toEqual([
      ".......",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".......",
    ]);
    expect(toArt(size, erode(size, grown, 2))).toEqual(toArt(size, m));
    expect(toArt(size, erode(size, grown, 3)).join("")).not.toContain("#");
  });

  it("erode counts off the canvas as on: a full mask stays full", () => {
    const size = { width: 4, height: 3 };
    const full = new Uint8Array(12).fill(1);
    expect([...erode(size, full, 1)]).toEqual([...full]);
  });

  it("flood stays on its side of a line it cannot cross, and ignores seeds off the pass or the canvas", () => {
    const { size, m } = fromArt(["..#..", "..#..", "..#..", "..#.."]);
    const pass = m.map((v) => (v ? 0 : 1));
    const left = flood(size, pass, [
      [0, 0],
      [2, 1],
      [-4, 0],
      [9, 9],
    ]);
    expect(toArt(size, left)).toEqual(["##...", "##...", "##...", "##..."]);
  });

  it("fillHoles closes enclosed holes but not a gap open to the edge", () => {
    const { size, m } = fromArt([
      ".......",
      ".###.##",
      ".#.#.#.",
      ".###.##",
      ".......",
    ]);
    expect(toArt(size, fillHoles(size, m))).toEqual([
      ".......",
      ".###.##",
      ".###.#.",
      ".###.##",
      ".......",
    ]);
  });

  it("majority clears speckle and fills a pinhole", () => {
    const { size, m } = fromArt([
      "#........",
      "......###",
      "..#...#.#",
      "......###",
      ".........",
    ]);
    // The window is cut at the canvas's edge; the block's edge column ties
    // there (3 of 6) and a tie is off.
    expect(toArt(size, majority(size, m, 1))).toEqual([
      ".........",
      ".......#.",
      "......###",
      ".......#.",
      ".........",
    ]);
  });

  it("pushPull keeps the known pixels and fills a hole with the colour around it", () => {
    const size = { width: 16, height: 16 };
    const rgb = new Float32Array(16 * 16 * 3);
    const known = new Float32Array(16 * 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = y * 16 + x;
        const hole = x >= 5 && x <= 10 && y >= 5 && y <= 10;
        // The hole holds a colour that must not leak into the fill.
        const c = hole ? [0, 0, 255] : x < 8 ? [200, 40, 40] : [210, 50, 30];
        rgb.set(c, i * 3);
        known[i] = hole ? 0 : 1;
      }
    }
    const out = pushPull(size, rgb, known);
    for (let i = 0; i < 16 * 16; i++) {
      if (known[i]) {
        expect([...out.subarray(i * 3, i * 3 + 3)]).toEqual([
          ...rgb.subarray(i * 3, i * 3 + 3),
        ]);
      } else {
        const [r, g, b] = out.subarray(i * 3, i * 3 + 3);
        expect(r).toBeGreaterThanOrEqual(199);
        expect(r).toBeLessThanOrEqual(211);
        expect(g).toBeGreaterThanOrEqual(39);
        expect(g).toBeLessThanOrEqual(51);
        expect(b).toBeGreaterThanOrEqual(29);
        expect(b).toBeLessThanOrEqual(41);
      }
    }
  });

  it("pushPull with no known pixel gives the input back", () => {
    const size = { width: 9, height: 7 };
    const rgb = new Float32Array(9 * 7 * 3).map((_, i) => (i * 37) % 251);
    const out = pushPull(size, rgb, new Float32Array(9 * 7));
    expect([...out]).toEqual([...rgb]);
    expect(out).not.toBe(rgb);
  });

  it("pushPull's coarsest level fills an unknown pixel with the known pixels' mean", () => {
    const size = { width: 2, height: 2 };
    const rgb = Float32Array.from([
      ...[10, 20, 30],
      ...[0, 0, 0],
      ...[40, 50, 60],
      ...[70, 80, 90],
    ]);
    const out = pushPull(size, rgb, [1, 0, 1, 1]);
    expect([...out.subarray(3, 6)]).toEqual([40, 50, 60]);
    expect([...out.subarray(0, 3)]).toEqual([10, 20, 30]);
  });
});

const BACKDROP: [number, number, number] = [235, 240, 250];
const DISC: [number, number, number] = [200, 60, 90];

type RGB = [number, number, number];

/** A square RGB picture `side` px wide, `fill` per pixel. */
async function writeOpaque(
  file: string,
  side: number,
  fill: (x: number, y: number) => RGB,
  format: "png" | "jpeg" = "png",
): Promise<void> {
  const buf = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) buf.set(fill(x, y), (y * side + x) * 3);
  }
  const img = sharp(buf, { raw: { width: side, height: side, channels: 3 } });
  await (format === "png" ? img.png() : img.jpeg({ quality: 92 })).toFile(file);
}

/** How much of pixel (x, y) a disc covers: its rim antialiased over 1 px. */
function coverage(x: number, y: number, cx: number, r: number): number {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cx) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

/** The disc (radius 300 on the 1100 canvas, centred) over the backdrop. */
function discAt(x: number, y: number): RGB {
  const a = coverage(x, y, 550, 300);
  return [0, 1, 2].map((c) =>
    Math.round(DISC[c] * a + BACKDROP[c] * (1 - a)),
  ) as RGB;
}

const WHITE: RGB = [255, 255, 255];
const WHITE_BG = { r: 255, g: 255, b: 255 };
const INK: RGB = [40, 30, 50];

/** White ground, a dark ring (radius 150..180) round a white pocket. */
function ringAt(x: number, y: number): RGB {
  const d = Math.hypot(x + 0.5 - 550, y + 0.5 - 550);
  return d >= 150 && d < 180 ? INK : WHITE;
}

describe("loadIllustration", () => {
  it("keys a flat backdrop: alpha 1 inside the disc, 0 outside, and its soft edge cleaned back to the disc's colour", async () => {
    const file = path.join(tmpDir(), "disc.png");
    await writeOpaque(file, 1100, discAt);
    const pic = await loadIllustration(file);
    expect(pic.background).toBe("flat");
    expect([pic.width, pic.height]).toEqual([1100, 1100]);
    expect(pic.backdrop).toEqual(BACKDROP);

    const at = (x: number, y: number) => y * pic.width + x;
    expect(pic.alpha[at(550, 550)]).toBe(1);
    expect(pic.alpha[at(550, 260)]).toBe(1);
    expect(pic.alpha[at(20, 20)]).toBe(0);
    expect(pic.alpha[at(550, 1000)]).toBe(0);

    let soft = 0;
    for (let y = 0; y < pic.height; y++) {
      for (let x = 0; x < pic.width; x++) {
        const i = at(x, y);
        const a = pic.alpha[i];
        const off = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(pic.rgb[i * 3 + c] - DISC[c])),
        );
        if (a >= 0.99) {
          // No opaque pixel keeps the backdrop blended in.
          expect(off).toBeLessThan(4);
        } else if (a > 0.05) {
          soft++;
          // Alpha is the pixel's coverage, and the colour the disc's; the
          // source's integer rounding, scaled up by 1 / a, is all that is off.
          expect(Math.abs(a - coverage(x, y, 550, 300))).toBeLessThan(0.02);
          expect(off * a).toBeLessThan(2);
          if (a > 0.25) expect(off).toBeLessThan(4);
        }
      }
    }
    expect(soft).toBeGreaterThan(500);
  });

  it("takes a JPEG's noisy flat backdrop as one colour", async () => {
    const file = path.join(tmpDir(), "disc.jpg");
    await writeOpaque(file, 550, (x, y) => discAt(2 * x, 2 * y), "jpeg");
    const pic = await loadIllustration(file);
    expect(pic.background).toBe("flat");
    expect(pic.alpha[550 * 1100 + 550]).toBe(1);
    expect(pic.alpha[20 * 1100 + 20]).toBe(0);
  });

  it("keys only the backdrop the border reaches: a pocket of its colour inside the figure stays, until a seed keys it", async () => {
    const file = path.join(tmpDir(), "ring.png");
    await writeOpaque(file, 1100, ringAt);
    const centre = 550 * 1100 + 550;

    const kept = await loadIllustration(file);
    expect(kept.backdrop).toEqual(WHITE);
    expect(kept.alpha[centre]).toBe(1);
    expect([...kept.rgb.subarray(centre * 3, centre * 3 + 3)]).toEqual(WHITE);
    expect(kept.alpha[550 * 1100 + 550 - 165]).toBe(1); // the ring
    expect(kept.alpha[20 * 1100 + 20]).toBe(0);

    const keyed = await loadIllustration(file, {
      backgroundSeeds: [[550, 550]],
    });
    expect(keyed.alpha[centre]).toBe(0);
    expect(keyed.alpha[550 * 1100 + 550 - 165]).toBe(1);
  });

  it("refuses a background seed on paint, naming it and the distance it measured", async () => {
    const file = path.join(tmpDir(), "ring.png");
    await writeOpaque(file, 1100, ringAt);
    await expect(
      loadIllustration(file, {
        backgroundSeeds: [
          [550, 550],
          [550, 385],
        ],
      }),
    ).rejects.toThrow(
      /backgroundSeeds\[1\] \(550, 385\) is on paint, not backdrop: its colour is 373 from the backdrop rgb\(255, 255, 255\), and a seed must be under 50/,
    );
    await expect(
      loadIllustration(file, { backgroundSeeds: [[-5, 10]] }),
    ).rejects.toThrow(/backgroundSeeds\[0\] \(-5, 10\) is off the 1100x1100/);
  });

  it("passes a picture with real transparency through, even framed so tight its figure fills most of the border", async () => {
    const file = path.join(tmpDir(), "tight.png");
    const W = 220;
    const buf = Buffer.alloc(W * W * 4);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        // Clear only above the shoulders, at the two top corners.
        const clear = y < 12 && (x < 40 || x >= 180);
        const paint = x < 110 ? [30, 120, 200] : [200, 120, 30];
        buf.set([...paint, clear ? 0 : 255], (y * W + x) * 4);
      }
    }
    await sharp(buf, { raw: { width: W, height: W, channels: 4 } })
      .png()
      .toFile(file);
    const pic = await loadIllustration(file);
    expect(pic.background).toBe("transparent");
    expect(pic.backdrop).toBeUndefined();
    // (55, 110) in the file, scaled 5x.
    const i = 550 * 1100 + 275;
    expect(pic.alpha[i]).toBe(1);
    expect([...pic.rgb.subarray(i * 3, i * 3 + 3)]).toEqual([30, 120, 200]);
    expect(pic.alpha[10 * 1100 + 10]).toBe(0);
  });

  it("keys a flat backdrop on a picture with a speck of transparency, keeping the speck clear", async () => {
    const file = path.join(tmpDir(), "speck.png");
    const W = 1100;
    const buf = Buffer.alloc(W * W * 4);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const speck = x >= 600 && x < 610 && y >= 20 && y < 30;
        buf.set([...discAt(x, y), speck ? 0 : 255], (y * W + x) * 4);
      }
    }
    await sharp(buf, { raw: { width: W, height: W, channels: 4 } })
      .png()
      .toFile(file);
    const pic = await loadIllustration(file);
    expect(pic.background).toBe("flat");
    expect(pic.backdrop).toEqual(BACKDROP);
    expect(pic.alpha[25 * 1100 + 605]).toBe(0);
    expect(pic.alpha[550 * 1100 + 550]).toBe(1);
  });

  it("turns a picture upright by its EXIF orientation", async () => {
    const file = path.join(tmpDir(), "turned.jpg");
    const buf = Buffer.alloc(200 * 100 * 3);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 200; x++) {
        buf.set(x < 100 ? [220, 30, 30] : [30, 30, 220], (y * 200 + x) * 3);
      }
    }
    // Stored 200x100, red on the left; orientation 6 shows it turned a
    // quarter clockwise: 100x200, red on top.
    await sharp(buf, { raw: { width: 200, height: 100, channels: 3 } })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toFile(file);
    const pic = await readPictureOnCanvas(file);
    expect([pic.width, pic.height]).toEqual([1100, 2200]);
    const red = (x: number, y: number) => pic.rgba[(y * 1100 + x) * 4];
    expect(red(550, 300)).toBeGreaterThan(180);
    expect(red(550, 1900)).toBeLessThan(80);
  });

  it("refuses a border of two colours, naming what it measured", async () => {
    const file = path.join(tmpDir(), "split.png");
    await writeOpaque(file, 550, (x) =>
      x < 275 ? [240, 240, 240] : [40, 40, 60],
    );
    await expect(loadIllustration(file)).rejects.toThrow(
      /backdrop is not one flat colour: \d+% of its 4 px border ring is within 12 of its median colour rgb\(\d+, \d+, \d+\), and at least 60% must be/,
    );
  });

  it("refuses a missing, unsupported, corrupt, oversized or too tall picture", async () => {
    const dir = tmpDir();
    await expect(loadIllustration(path.join(dir, "none.png"))).rejects.toThrow(
      /picture file not found/,
    );

    const gif = path.join(dir, "pic.gif");
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: WHITE_BG },
    })
      .gif()
      .toFile(gif);
    await expect(loadIllustration(gif)).rejects.toThrow(
      /picture must be a PNG, JPEG or WebP, not gif/,
    );

    const corrupt = path.join(dir, "corrupt.png");
    fs.writeFileSync(corrupt, "not a picture at all");
    await expect(loadIllustration(corrupt)).rejects.toThrow(
      /failed to read picture .*corrupt\.png/,
    );

    const big = path.join(dir, "big.png");
    await sharp({
      create: { width: 5000, height: 3400, channels: 3, background: WHITE_BG },
    })
      .png()
      .toFile(big);
    await expect(loadIllustration(big)).rejects.toThrow(
      /picture is 5000x3400 = 17000000 px, over the 16777216 px limit/,
    );

    const tall = path.join(dir, "tall.png");
    await sharp({
      create: { width: 100, height: 400, channels: 3, background: WHITE_BG },
    })
      .png()
      .toFile(tall);
    await expect(loadIllustration(tall)).rejects.toThrow(
      /picture is 100x400; at 1100 px wide its canvas would be 4400 px tall, over 4096/,
    );
  });
});
