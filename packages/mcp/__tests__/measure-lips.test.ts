import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { formatMeasureReport, measureLayers } from "../src/measure";
import { CAVITY, KEY_GREEN } from "./helpers/parts";
import { UPPER_THIN } from "../../editor/src/auto-rig/mouth";

/**
 * The lip set's layers painted by hand on a 200 canvas: the contract set is
 * the smallest drawing the rig folds, and each case breaks one thing in it.
 * Measuring is read-only, so the fixtures live in the system temp dir.
 */

const CANVAS = 200;
type RGB = [number, number, number];
type SetPixel = (x: number, y: number, rgb: RGB, alpha?: number) => void;

const DARK: RGB = [20, 20, 30];
const SKIN: RGB = [240, 205, 180];

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-measure-lips-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function writeLayer(
  dir: string,
  name: string,
  paint: (set: SetPixel) => void,
  size = CANVAS,
): Promise<void> {
  const buf = Buffer.alloc(size * size * 4);
  paint((x, y, rgb, alpha = 255) =>
    buf.set([...rgb, alpha], (y * size + x) * 4),
  );
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(path.join(dir, name));
}

const block =
  (x0: number, x1: number, y0: number, y1: number, rgb: RGB) =>
  (set: SetPixel) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) set(x, y, rgb);
  };

interface Variant {
  /** The upper line's rows and columns. */
  line?: [number, number, number, number];
  /** The interior's rows and columns. */
  inner?: [number, number, number, number];
  lowerFrom?: number;
  green?: boolean;
  /** Rows cleared across the opening inside the interior. */
  hollow?: [number, number];
  /** Columns cleared out of the interior altogether. */
  innerGap?: [number, number];
  /** Skip a layer. */
  omit?: string;
  /** Write the lower lip on this canvas. */
  lowerCanvas?: number;
}

/** The contract set: line rows 90..92 over columns 60..139 with a 6x6 hook
 *  beyond each end, the interior on rows 93..117 with a 3-row dark band, the
 *  skin from row 117 (one row of overlap). */
async function writeSet(v: Variant = {}): Promise<string> {
  const dir = tmpDir();
  const [lx0, lx1, ly0, ly1] = v.line ?? [60, 139, 90, 92];
  const [ix0, ix1, iy0, iy1] = v.inner ?? [60, 139, 93, 117];
  if (v.omit !== "lip_upper") {
    await writeLayer(dir, "lip_upper.png", (set) => {
      block(lx0, lx1, ly0, ly1, DARK)(set);
      block(54, 59, 90, 95, DARK)(set);
      block(140, 145, 90, 95, DARK)(set);
    });
  }
  if (v.omit !== "mouth_inner") {
    await writeLayer(dir, "mouth_inner.png", (set) => {
      block(ix0, ix1, iy0, iy1, CAVITY)(set);
      block(ix0, ix1, Math.max(iy0, 115), iy1, DARK)(set);
      if (v.green) block(70, 74, 100, 103, KEY_GREEN)(set);
      if (v.innerGap) {
        for (let y = 0; y < CANVAS; y++)
          for (let x = v.innerGap[0]; x <= v.innerGap[1]; x++)
            set(x, y, CAVITY, 0);
      }
      if (v.hollow) {
        for (let y = v.hollow[0]; y <= v.hollow[1]; y++)
          for (let x = ix0; x <= ix1; x++) set(x, y, CAVITY, 0);
      }
    });
  }
  if (v.omit !== "lip_lower") {
    const size = v.lowerCanvas ?? CANVAS;
    await writeLayer(
      dir,
      "lip_lower.png",
      block(60, 139, v.lowerFrom ?? 117, 130, SKIN),
      size,
    );
  }
  return dir;
}

async function warningsOf(dir: string): Promise<string[]> {
  const r = await measureLayers({ layersDir: dir });
  if (!r.ok) throw new Error(r.error);
  return r.warnings.filter((w) => !/: missing — /.test(w));
}

describe("measure_layers: the lip set", () => {
  it("passes the contract set and raises no edge or flat-cut warning on it", async () => {
    expect(await warningsOf(await writeSet())).toEqual([]);
  });

  it("warns of a gap between the line and the interior, with its columns", async () => {
    const w = await warningsOf(await writeSet({ line: [60, 139, 88, 90] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/gap/);
    expect(w[0]).toContain("80 columns");
  });

  it("warns of a gap between the interior and the skin", async () => {
    const w = await warningsOf(await writeSet({ lowerFrom: 120 }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/skin/);
  });

  it("asks for a bolder line when it is one row", async () => {
    const w = await warningsOf(await writeSet({ line: [60, 139, 92, 92] }));
    expect(w.join("\n")).toMatch(/bolder/);
    expect(w.join("\n")).not.toMatch(/layout\.mouth_inner\.w/);
  });

  it("warns of an opening too short to fold, and of a band-only interior", async () => {
    expect(
      (await warningsOf(await writeSet({ inner: [60, 139, 93, 98] }))).join(
        "\n",
      ),
    ).toMatch(/too small to fold|px tall/);
    // lip_upper is 92 px wide (hooks included) and the opening 6 rows tall.
    expect(
      (await warningsOf(await writeSet({ inner: [60, 139, 93, 98] }))).join(
        "\n",
      ),
    ).toContain("layout.mouth_inner.w to 123");
    // Its own runs are the opening, so three rows is the height check's.
    expect(
      (await warningsOf(await writeSet({ inner: [60, 139, 115, 117] }))).join(
        "\n",
      ),
    ).toMatch(/px tall/);
  });

  it("warns of columns with no line above the interior", async () => {
    const w = await warningsOf(await writeSet({ line: [60, 99, 90, 92] }));
    expect(w.join("\n")).toMatch(/no line above the interior in 40 columns/);
  });

  it("warns of columns with no interior, naming mouth_interior.png", async () => {
    const w = await warningsOf(await writeSet({ innerGap: [90, 99] }));
    expect(w.join("\n")).toMatch(
      /no interior in 10 columns[^]*regenerate mouth_interior\.png/,
    );
  });

  it("warns of an opening too narrow for its lip", async () => {
    const w = await warningsOf(
      await writeSet({ line: [0, 199, 90, 92], inner: [75, 124, 93, 117] }),
    );
    expect(w.join("\n")).toMatch(/narrow/);
  });

  it("warns of key green left in a lip layer", async () => {
    expect(
      (await warningsOf(await writeSet({ green: true }))).join("\n"),
    ).toMatch(/green/);
  });

  it("warns of the interior's transparent holes", async () => {
    const w = await warningsOf(await writeSet({ hollow: [100, 106] }));
    expect(w.join("\n")).toMatch(/transparent inside|shows through/);
  });

  it("warns of a partial set, a mixed set and another canvas", async () => {
    expect(
      (await warningsOf(await writeSet({ omit: "lip_lower" }))).join("\n"),
    ).toMatch(/partial/);

    const mixed = await writeSet();
    await writeLayer(mixed, "mouth.png", block(70, 130, 95, 110, SKIN));
    expect((await warningsOf(mixed)).join("\n")).toMatch(/cannot be mixed/);

    expect(
      (await warningsOf(await writeSet({ lowerCanvas: 300 }))).join("\n"),
    ).toMatch(/canvas/);
  });

  it("reports the opening and the dead zone, in the table and in the text", async () => {
    const dir = await writeSet();
    const r = await measureLayers({ layersDir: dir });
    if (!r.ok) throw new Error(r.error);
    expect(r.lips?.opening).toEqual({ width: 80, height: 25, line: 3 });
    // The overlap is the centre's stroke thinned: the closed line's top.
    expect(
      Math.abs(r.lips!.deadZone - (UPPER_THIN * 3) / (25 + UPPER_THIN * 3)),
    ).toBeLessThan(0.01);
    const lines = formatMeasureReport(r).split("\n");
    const line = lines.find((l) => l.startsWith("lips:"))!;
    expect(line).toMatch(/^lips: opening 80 px wide/);
    expect(line).toMatch(/no slit below MouthOpen 0\.08$/);
    expect(lines.indexOf(line)).toBeLessThan(lines.indexOf("# checks"));

    const legacy = tmpDir();
    await writeLayer(legacy, "mouth.png", block(70, 130, 95, 110, SKIN));
    const old = await measureLayers({ layersDir: legacy });
    if (!old.ok) throw new Error(old.error);
    expect(old.lips).toBeUndefined();
    expect(formatMeasureReport(old)).not.toMatch(/^lips:/m);
  });
});
