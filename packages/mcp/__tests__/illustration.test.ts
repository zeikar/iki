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
  pixelIndex,
  polygonMask,
  pushPull,
  readPictureOnCanvas,
  type CanvasSize,
  type Mask,
} from "../src/illustration";
import {
  BLACK_ON_PEACH,
  ORANGE_ON_WARM,
  PINK_ON_PEACH,
  writeCharacter,
  type CharacterColours,
} from "./helpers/illustration-character";

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
  it("polygonMask takes the pixels whose centres lie inside or on the outline through the vertices' pixels", () => {
    const size = { width: 7, height: 5 };
    const m = polygonMask(size, [
      [0, 0],
      [6, 0],
      [0, 6],
    ]);
    // The hypotenuse runs through the centres of (6 - y, y).
    expect(toArt(size, m)).toEqual([
      "#######",
      "######.",
      "#####..",
      "####...",
      "###....",
    ]);
  });

  it("polygonMask covers a square's columns x0..x1 and rows y0..y1", () => {
    const size = { width: 8, height: 7 };
    const m = polygonMask(size, [
      [2, 1],
      [6, 1],
      [6, 5],
      [2, 5],
    ]);
    expect(m.reduce((t, v) => t + v, 0)).toBe(25);
    expect(toArt(size, m)).toEqual([
      "........",
      "..#####.",
      "..#####.",
      "..#####.",
      "..#####.",
      "..#####.",
      "........",
    ]);
    // The same square as boxMask gives, both corners inside.
    expect([...m]).toEqual([...boxMask(size, [2, 1, 6, 5])]);
  });

  it("polygonMask keeps a polygon's lowest vertex and a sliver thinner than a row", () => {
    const size = { width: 7, height: 5 };
    const v = polygonMask(size, [
      [0, 0],
      [6, 0],
      [3, 3],
    ]);
    expect(toArt(size, v)).toEqual([
      "#######",
      ".#####.",
      "..###..",
      "...#...",
      ".......",
    ]);
    const sliver = polygonMask(size, [
      [1, 2],
      [5, 2],
      [3, 2.2],
    ]);
    expect(toArt(size, sliver)).toEqual([
      ".......",
      ".......",
      ".#####.",
      ".......",
      ".......",
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

  it("flood stays on its side of a line it cannot cross, and ignores seeds off the pass", () => {
    const { size, m } = fromArt(["..#..", "..#..", "..#..", "..#.."]);
    const pass = m.map((v) => (v ? 0 : 1));
    const left = flood(size, pass, [
      [0, 0],
      [2, 1],
    ]);
    expect(toArt(size, left)).toEqual(["##...", "##...", "##...", "##..."]);
    // A coordinate just under the width rounds past it: held on the edge.
    const right = flood(size, pass, [[4.6, 3.7]]);
    expect(toArt(size, right)).toEqual(["...##", "...##", "...##", "...##"]);
  });

  it("pixelIndex rounds a point and holds it on the canvas", () => {
    const size = { width: 5, height: 4 };
    expect(pixelIndex(size, [1.4, 2.6])).toBe(3 * 5 + 1);
    expect(pixelIndex(size, [4.9, 3.9])).toBe(3 * 5 + 4);
    expect(pixelIndex(size, [-0.4, 0])).toBe(0);
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

  it("keeps pale paint with no outline whole: the key does not flood into it", async () => {
    const PALE: RGB = [255, 235, 220];
    const file = path.join(tmpDir(), "pale.png");
    await writeOpaque(file, 1100, (x, y) => {
      const a = coverage(x, y, 550, 300);
      return [0, 1, 2].map((c) =>
        Math.round(PALE[c] * a + WHITE[c] * (1 - a)),
      ) as RGB;
    });
    const pic = await loadIllustration(file);
    expect(pic.background).toBe("flat");
    const at = (x: number, y: number) => y * pic.width + x;
    for (const [x, y] of [
      [550, 550],
      [550, 260],
      [290, 550],
      [800, 700],
    ]) {
      expect(pic.alpha[at(x, y)]).toBe(1);
    }
    expect(pic.alpha[at(20, 20)]).toBe(0);
  });

  it("keys a backdrop that drifts off its border's colour away from the figure, and still measures the figure's soft edge", async () => {
    const file = path.join(tmpDir(), "shade.png");
    // A soft shadow on the backdrop, about 21 from its colour at the
    // middle (between the noise floor and the flood's limit), away from the
    // disc.
    await writeOpaque(file, 1100, (x, y) => {
      const shade = 12 * Math.max(0, 1 - Math.hypot(x - 180, y - 900) / 120);
      return x > 300 && x < 800 && y > 200 && y < 800
        ? discAt(x, y)
        : (BACKDROP.map((v) => Math.round(v - shade)) as RGB);
    });
    const pic = await loadIllustration(file);
    const at = (x: number, y: number) => y * pic.width + x;
    expect(pic.alpha[at(180, 900)]).toBe(0);
    expect(pic.alpha[at(150, 880)]).toBe(0);
    expect(pic.alpha[at(550, 550)]).toBe(1);
    // The disc's rim keeps its coverage.
    let rimPixels = 0;
    for (let x = 520; x < 580; x++) {
      for (let y = 245; y < 255; y++) {
        const c = coverage(x, y, 550, 300);
        if (c <= 0.2 || c >= 0.8) continue;
        rimPixels++;
        expect(Math.abs(pic.alpha[at(x, y)] - c)).toBeLessThan(0.02);
      }
    }
    expect(rimPixels).toBeGreaterThan(0);
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
      /backgroundSeeds\[1\] \(550, 385\) is on paint, not backdrop: its colour is 373 from the backdrop rgb\(255, 255, 255\), and a seed must be under 32/,
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

/**
 * The matte's edge, case by case, against the same picture drawn on
 * transparency and scaled the same way: its alpha is the true coverage.
 */
describe("loadIllustration's edge, against the picture drawn on transparency", () => {
  /** The keyed picture beside the source on the canvas and the truth. */
  async function keyedBeside(file: string, truthFile: string) {
    const pic = await loadIllustration(file);
    const source = await readPictureOnCanvas(file);
    const truth = await readPictureOnCanvas(truthFile);
    const n = pic.width * pic.height;
    const ground = pic.backdrop!;
    // Over its backdrop, how far each gives a source channel back.
    const off = (i: number, rgb: ArrayLike<number>, at: number, a: number) =>
      Math.max(
        ...[0, 1, 2].map((c) =>
          Math.abs(
            rgb[at + c] * a + ground[c] * (1 - a) - source.rgba[i * 4 + c],
          ),
        ),
      );
    let ring = 0;
    let worse = 0;
    for (let i = 0; i < n; i++) {
      const t = truth.rgba[i * 4 + 3] / 255;
      const a = pic.alpha[i];
      if (t < 0.05 && a >= 0.5) ring++;
      // The truth cannot give back the resize's overshoot past an edge
      // either (clipped to clear, or into 0..255): only past what it
      // misses by is the matte's own.
      worse = Math.max(
        worse,
        off(i, pic.rgb, i * 3, a) - off(i, truth.rgba, i * 4, t),
      );
    }
    return { pic, truth, ring, worse };
  }

  /** Each canvas px of true coverage 1 more than 3 px inside the edge. */
  function deepInside(truth: { width: number; height: number; rgba: Buffer }) {
    const full = new Uint8Array(truth.width * truth.height);
    for (let i = 0; i < full.length; i++) {
      full[i] = truth.rgba[i * 4 + 3] === 255 ? 1 : 0;
    }
    return erode(truth, full, 3);
  }

  /** At half size, supersampled: `paint` gives each point's colour and
   *  coverage in picture px; the opaque picture over `ground` and the same
   *  paint on transparency. */
  async function writePair(
    ground: RGB,
    paint: (x: number, y: number) => [RGB, number],
  ): Promise<[string, string]> {
    const S = 550;
    const opaque = Buffer.alloc(S * S * 3);
    const clear = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const sum = [0, 0, 0];
        let cov = 0;
        for (let k = 0; k < 16; k++) {
          const [col, a] = paint(
            x + ((k % 4) + 0.5) / 4,
            y + ((k >> 2) + 0.5) / 4,
          );
          for (let c = 0; c < 3; c++) sum[c] += (col[c] * a) / 16;
          cov += a / 16;
        }
        const i = y * S + x;
        for (let c = 0; c < 3; c++) {
          opaque[i * 3 + c] = Math.round(sum[c] + ground[c] * (1 - cov));
          if (cov > 0) clear[i * 4 + c] = Math.round(sum[c] / cov);
        }
        clear[i * 4 + 3] = Math.round(cov * 255);
      }
    }
    const dir = tmpDir();
    const files: [string, string] = [
      path.join(dir, "opaque.png"),
      path.join(dir, "clear.png"),
    ];
    await sharp(opaque, { raw: { width: S, height: S, channels: 3 } })
      .png()
      .toFile(files[0]);
    await sharp(clear, { raw: { width: S, height: S, channels: 4 } })
      .png()
      .toFile(files[1]);
    return files;
  }

  const DARK_GROUND: CharacterColours = {
    backdrop: [30, 32, 45],
    ink: [10, 8, 15],
    hair: [235, 235, 245],
    hairShadow: [200, 200, 220],
    hairHighlight: [255, 255, 255],
    skin: [255, 235, 220],
    skinShadow: [240, 210, 195],
    torso: [220, 225, 240],
    ribbon: [210, 40, 60],
  };
  const colourings: [string, CharacterColours][] = [
    ["light ground, dark ink, pink hair", PINK_ON_PEACH],
    ["light ground, dark ink, orange hair", ORANGE_ON_WARM],
    ["light ground, dark ink, near-black hair", BLACK_ON_PEACH],
    [
      "mid-tone ground 150, black ink",
      { ...PINK_ON_PEACH, backdrop: [150, 150, 160], ink: [20, 15, 25] },
    ],
    [
      "mid-tone ground 200, black ink",
      { ...PINK_ON_PEACH, backdrop: [200, 200, 200], ink: [10, 10, 10] },
    ],
    ["dark ground, pale figure, dark lines", DARK_GROUND],
    // Its "line" is as pale as the hair: no line.
    [
      "dark ground, pale figure, no line",
      { ...DARK_GROUND, ink: [250, 240, 230] },
    ],
    [
      "light ground, dark figure, no line",
      {
        ...BLACK_ON_PEACH,
        ink: [40, 35, 45],
        skin: [120, 80, 70],
        skinShadow: [100, 65, 55],
      },
    ],
  ];

  it.each(colourings)(
    "on the character (%s): no ring past the silhouette, opaque inside, and it stacks back",
    async (_what, colours) => {
      const dir = tmpDir();
      const file = path.join(dir, "character.png");
      const truthFile = path.join(dir, "character-clear.png");
      await writeCharacter(file, colours);
      await writeCharacter(truthFile, colours, { transparent: true });
      const { pic, truth, ring, worse } = await keyedBeside(file, truthFile);
      expect(ring).toBe(0);
      const deep = deepInside(truth);
      let deepPx = 0;
      let notOpaque = 0;
      for (let i = 0; i < deep.length; i++) {
        if (!deep[i]) continue;
        deepPx++;
        if (pic.alpha[i] < 1) notOpaque++;
      }
      expect(deepPx).toBeGreaterThan(300000);
      expect(notOpaque).toBe(0);
      expect(worse).toBeLessThan(5);
    },
  );

  it.each([
    ["a light ground", [245, 245, 245], [200, 120, 140]],
    ["a dark ground", [30, 32, 45], [240, 220, 200]],
    ["a light ground, pale paint", [245, 245, 245], [255, 215, 190]],
  ] as [string, RGB, RGB][])(
    "reads a soft-shaded lineless edge (a 6 px ramp) on %s as its coverage",
    async (_what, ground, fill) => {
      const [file, truthFile] = await writePair(ground, (x, y) => [
        fill,
        Math.max(0, Math.min(1, (160 - Math.hypot(x - 275, y - 275)) / 6)),
      ]);
      const { pic, truth, ring, worse } = await keyedBeside(file, truthFile);
      let ramp = 0;
      let wrong = 0;
      for (let i = 0; i < pic.width * pic.height; i++) {
        const t = truth.rgba[i * 4 + 3] / 255;
        if (t <= 0 || t >= 1) continue;
        ramp++;
        if (Math.abs(pic.alpha[i] - t) > 0.15) wrong++;
      }
      expect(ramp).toBeGreaterThan(20000);
      expect(wrong).toBe(0);
      expect(ring).toBe(0);
      expect(worse).toBeLessThan(5);
    },
  );

  it("keeps a thin dark line opaque to where it runs into a lineless pale edge", async () => {
    // A line one picture px (two canvas px) wide down a peach disc with no
    // outline, on white, to the disc's edge at both ends.
    const [file, truthFile] = await writePair([245, 245, 245], (x, y) => [
      x >= 275 && x < 276 ? [20, 20, 30] : [255, 215, 190],
      Math.hypot(x - 275, y - 275) < 160 ? 1 : 0,
    ]);
    const { pic, truth, ring, worse } = await keyedBeside(file, truthFile);
    let line = 0;
    let least = 1;
    let lastRow = 0;
    for (let y = 0; y < pic.height; y++) {
      for (const x of [550, 551]) {
        const i = y * pic.width + x;
        if (truth.rgba[i * 4 + 3] < 255) continue;
        line++;
        lastRow = Math.max(lastRow, y);
        least = Math.min(least, pic.alpha[i]);
      }
    }
    expect(line).toBeGreaterThan(1200);
    // Right to the edge (it ends at canvas row 870).
    expect(lastRow).toBeGreaterThan(865);
    expect(least).toBeGreaterThanOrEqual(0.9);
    expect(ring).toBe(0);
    expect(worse).toBeLessThan(5);
  });

  it.each([1, 1.5, 2])(
    "keeps a dark outline %s picture px wide round pale paint on a mid-tone ground opaque",
    async (width) => {
      // The paint lighter and the line darker than the ground: the line
      // lies on the far side of the ground from the paint.
      const MID: RGB = [143, 158, 180];
      const [file, truthFile] = await writePair(MID, (x, y) => {
        const d = Math.hypot(x - 275, y - 275);
        return [
          d < 146 ? [245, 180, 185] : [20, 15, 25],
          d < 146 + width ? 1 : 0,
        ];
      });
      const { pic, truth, ring, worse } = await keyedBeside(file, truthFile);
      let line = 0;
      let least = 1;
      for (let y = 0; y < pic.height; y++) {
        for (let x = 0; x < pic.width; x++) {
          const i = y * pic.width + x;
          const d = Math.hypot((x + 0.5) / 2 - 275, (y + 0.5) / 2 - 275);
          if (d < 146 || d >= 146 + width || truth.rgba[i * 4 + 3] < 255) {
            continue;
          }
          line++;
          least = Math.min(least, pic.alpha[i]);
        }
      }
      expect(line).toBeGreaterThan(1000);
      expect(least).toBeGreaterThanOrEqual(0.9);
      expect(ring).toBe(0);
      expect(worse).toBeLessThan(5);
    },
  );
});
