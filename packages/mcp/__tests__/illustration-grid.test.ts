import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { viewIllustrationGrid } from "../src/illustration-grid";

// Temp dirs live UNDER cwd (node_modules is gitignored) so they satisfy the
// working-directory confinement of the output path.
const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-grid-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

const GREY = 128;

/** A flat grey 550x825 picture: 1100x1650 on the canvas, each pixel 2x2. */
async function writePicture(dir: string): Promise<string> {
  const file = path.join(dir, "pic.png");
  await sharp({
    create: {
      width: 550,
      height: 825,
      channels: 3,
      background: { r: GREY, g: GREY, b: GREY },
    },
  })
    .png()
    .toFile(file);
  return file;
}

async function pixels(file: string) {
  const { data, info } = await sharp(file)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { width: info.width, height: info.height, at };
}

describe("viewIllustrationGrid", () => {
  it("defaults to the whole canvas at zoom 1 with a line every 50 px", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const outputPath = path.join(dir, "grid.png");
    const r = await viewIllustrationGrid({ imagePath, outputPath });
    expect(r).toEqual({
      ok: true,
      path: fs.realpathSync(outputPath),
      crop: { x: 0, y: 0, w: 1100, h: 1650 },
      zoom: 1,
      step: 50,
      canvas: { width: 1100, height: 1650 },
    });
    const img = await pixels(outputPath);
    expect([img.width, img.height]).toEqual([1100, 1650]);
    // Away from the labels: a line on column 500, plain picture beside it.
    expect(img.at(500, 777)).not.toEqual([GREY, GREY, GREY]);
    expect(img.at(501, 777)).toEqual([GREY, GREY, GREY]);
    expect(img.at(777, 1200)).not.toEqual([GREY, GREY, GREY]);
    expect(img.at(777, 1201)).toEqual([GREY, GREY, GREY]);
  });

  it("draws the crop at its zoom, the grid on canvas coordinates, labelled along the top", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const outputPath = path.join(dir, "zoom.png");
    const r = await viewIllustrationGrid({
      imagePath,
      outputPath,
      crop: { x: 330, y: 410, w: 100, h: 60 },
      zoom: 4,
      step: 25,
    });
    expect(r).toMatchObject({
      ok: true,
      crop: { x: 330, y: 410, w: 100, h: 60 },
      zoom: 4,
    });
    const img = await pixels(outputPath);
    expect([img.width, img.height]).toEqual([400, 240]);
    // Canvas column 350 is output column (350 - 330) * 4 = 80; row 425 is 60.
    expect(img.at(80, 200)).not.toEqual([GREY, GREY, GREY]);
    expect(img.at(81, 200)).toEqual([GREY, GREY, GREY]);
    expect(img.at(300, 60)).not.toEqual([GREY, GREY, GREY]);
    expect(img.at(300, 61)).toEqual([GREY, GREY, GREY]);
    // The label "350" draws yellow ink just right of its line, at the top.
    let ink = 0;
    for (let y = 0; y < 20; y++) {
      for (let x = 82; x < 120; x++) {
        const [cr, cg, cb] = img.at(x, y);
        if (cr > 200 && cg > 200 && cb < 80) ink++;
      }
    }
    expect(ink).toBeGreaterThan(20);
    // And "425" down the left edge, just under its row line.
    ink = 0;
    for (let y = 62; y < 80; y++) {
      for (let x = 0; x < 40; x++) {
        const [cr, cg, cb] = img.at(x, y);
        if (cr > 200 && cg > 200 && cb < 80) ink++;
      }
    }
    expect(ink).toBeGreaterThan(20);
  });

  it("clamps a crop that runs off the canvas", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const r = await viewIllustrationGrid({
      imagePath,
      outputPath: path.join(dir, "edge.png"),
      crop: { x: 1050.5, y: -20, w: 200, h: 80 },
      zoom: 2,
    });
    expect(r).toMatchObject({
      ok: true,
      crop: { x: 1050, y: 0, w: 50, h: 60 },
    });
    const img = await pixels(path.join(dir, "edge.png"));
    expect([img.width, img.height]).toEqual([100, 120]);
  });

  it("draws a landmark box through the centres of the pixels it names, and skips shapes it does not know", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const plain = path.join(dir, "plain.png");
    const marked = path.join(dir, "marked.png");
    const crop = { x: 300, y: 300, w: 200, h: 200 };
    await viewIllustrationGrid({ imagePath, outputPath: plain, crop, zoom: 2 });
    const r = await viewIllustrationGrid({
      imagePath,
      outputPath: marked,
      crop,
      zoom: 2,
      landmarks: {
        nose: [380, 420, 440, 470],
        unknown: "not a shape",
        nested: { odd: { a: 1 } },
      },
    });
    expect(r.ok).toBe(true);
    const a = await pixels(plain);
    const b = await pixels(marked);
    // The box's bottom edge runs through the centre of canvas row 470: output
    // row (470.5 - 300) * 2 = 341, in the key's colour, a dark stroke inside
    // it (row 340) and a light one outside (row 342); row 339 untouched.
    expect(b.at(221, 341).slice(0, 3)).toEqual([255, 64, 64]);
    expect(b.at(221, 340).slice(0, 3)).toEqual([0, 0, 0]);
    expect(b.at(221, 342).slice(0, 3)).toEqual([255, 255, 255]);
    expect(b.at(221, 339)).toEqual(a.at(221, 339));
    // Inside the box, off its edge and its label: untouched.
    const inside = [221, 2 * (450 - 300)] as const;
    expect(b.at(...inside)).toEqual(a.at(...inside));
  });

  it.each([
    ["light", 245],
    ["dark", 15],
  ] as const)(
    "draws every landmark so it reads over %s paint, at zoom 1 and 6",
    async (_name, level) => {
      const dir = tmpDir();
      const imagePath = path.join(dir, "flat.png");
      await sharp({
        create: {
          width: 550,
          height: 550,
          channels: 3,
          background: { r: level, g: level, b: level },
        },
      })
        .png()
        .toFile(imagePath);
      // One shape of each kind, under keys of every colour the cycle has.
      const landmarks: Record<string, unknown> = {
        box: [500, 500, 540, 530],
        iris: { cx: 600, cy: 520, rx: 12, ry: 15 },
        line: [
          [500, 560],
          [560, 575],
        ],
        skinSeeds: [[620, 570]],
        a: [0, 0, 1, 1],
        b: [0, 0, 1, 1],
        frontHair: [
          [640, 500],
          [680, 500],
          [680, 540],
        ],
      };
      const luma = (p: number[]) =>
        0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      for (const zoom of [1, 6]) {
        const crop = { x: 490, y: 490, w: 200, h: 100 };
        const out = path.join(dir, `z${zoom}.png`);
        const r = await viewIllustrationGrid({
          imagePath,
          outputPath: out,
          crop,
          zoom,
          step: 1000,
          landmarks,
        });
        expect(r.ok).toBe(true);
        const img = await pixels(out);
        // Each shape's own stretch of the view, clear of every label, holds
        // a px far from the paint.
        for (const [x0, y0, x1, y1] of [
          [500, 500, 540, 530],
          [588, 505, 612, 535],
          [554, 570, 560, 577],
          [678, 525, 682, 541],
        ]) {
          let best = 0;
          for (
            let y = (y0 - crop.y) * zoom;
            y <= (y1 - crop.y + 1) * zoom;
            y++
          ) {
            for (
              let x = (x0 - crop.x) * zoom;
              x <= (x1 - crop.x + 1) * zoom;
              x++
            ) {
              best = Math.max(best, Math.abs(luma(img.at(x, y)) - level));
            }
          }
          expect(best, `zoom ${zoom} [${x0}, ${y0}]`).toBeGreaterThan(160);
        }
      }
    },
  );

  it("draws ellipses, polylines and point markers by shape", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const plain = path.join(dir, "plain.png");
    const marked = path.join(dir, "marked.png");
    await viewIllustrationGrid({ imagePath, outputPath: plain });
    const r = await viewIllustrationGrid({
      imagePath,
      outputPath: marked,
      landmarks: {
        eyes: { L: { iris: { cx: 700, cy: 900, rx: 40, ry: 60 } } },
        skull: [
          [210, 1210],
          [290, 1210],
          [290, 1290],
        ],
        brow: [
          [410, 1210],
          [490, 1210],
          [490, 1290],
        ],
        bodyOnly: [
          [
            [210, 1410],
            [290, 1410],
            [290, 1490],
          ],
        ],
        sideHair: {
          L: [
            [410, 1410],
            [490, 1410],
            [490, 1490],
          ],
        },
        skinSeeds: [[820, 1420]],
        paintSeeds: [[920, 1420]],
        samples: { hair: { base: [[620, 1520]] } },
      },
    });
    expect(r.ok).toBe(true);
    const a = await pixels(plain);
    const b = await pixels(marked);
    const changed = (x: number, y: number) =>
      b.at(x, y).join() !== a.at(x, y).join();
    expect(changed(740, 900)).toBe(true); // the ellipse's right end
    expect(changed(700, 900)).toBe(false); // its centre
    expect(changed(250, 1210)).toBe(true); // the skull's top edge
    // Closed: the edge back from the last point to the first.
    expect(changed(250, 1250)).toBe(true);
    // Open under any other key: no edge back to the first point.
    expect(changed(490, 1250)).toBe(true);
    expect(changed(450, 1250)).toBe(false);
    // Each bodyOnly polygon closes too, and each side lock's.
    expect(changed(250, 1450)).toBe(true);
    expect(changed(450, 1450)).toBe(true);
    expect(changed(820, 1420)).toBe(true); // a seed marker
    expect(changed(920, 1420)).toBe(true); // a paint seed's marker
    expect(changed(620, 1520)).toBe(true); // a sample marker
  });

  it("labels a shape in view even when its label's anchor is off it", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const plain = path.join(dir, "plain.png");
    const marked = path.join(dir, "marked.png");
    // A step past the crop: no grid labels to cover the landmark's.
    const view = { crop: { x: 300, y: 300, w: 200, h: 200 }, step: 500 };
    await viewIllustrationGrid({ imagePath, outputPath: plain, ...view });
    await viewIllustrationGrid({
      imagePath,
      outputPath: marked,
      ...view,
      // Its top, and the label above it, lie above the view.
      landmarks: { nose: [350, 250, 450, 400] },
    });
    const a = await pixels(plain);
    const b = await pixels(marked);
    // The label is moved down to the view's top edge, at the box's left.
    expect(b.at(60, 10)).not.toEqual(a.at(60, 10));
    expect(b.at(60, 10)[0]).toBeLessThan(GREY);
  });

  it("refuses a bad zoom, step, crop and output path, writing nothing", async () => {
    const dir = tmpDir();
    const imagePath = await writePicture(dir);
    const outputPath = path.join(dir, "no.png");
    const refuse = async (extra: object, message: RegExp) => {
      const r = await viewIllustrationGrid({ imagePath, outputPath, ...extra });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(message);
    };
    await refuse({ zoom: 0 }, /zoom must be an integer in 1\.\.8, not 0/);
    await refuse({ zoom: 9 }, /zoom must be an integer in 1\.\.8/);
    await refuse({ zoom: 1.5 }, /zoom must be an integer/);
    await refuse({ step: 4 }, /step must be an integer of at least 5, not 4/);
    await refuse(
      { crop: { x: 2000, y: 0, w: 10, h: 10 } },
      /crop .* misses the 1100x1650 canvas/,
    );
    await refuse({ crop: { x: 0, y: 0, w: 0, h: 10 } }, /positive size/);
    await refuse({ zoom: 8 }, /the view would be 8800x13200 .* over/);
    await refuse(
      { outputPath: path.join(dir, "grid.jpg") },
      /output path must end in \.png/,
    );
    await refuse(
      { outputPath: path.join(os.tmpdir(), "grid.png") },
      /escapes the working directory/,
    );
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
