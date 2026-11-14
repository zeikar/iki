/**
 * `auto_rig_from_layers`'s `customParts` on small script-drawn layers: the
 * extra atlas page, what the custom layers leave alone, and the refusals.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import {
  autoRigFromLayers,
  type AutoRigCustomPartInput,
  type AutoRigResult,
} from "../src/tools";

const CANVAS = 100;

type Rect = { x: number; y: number; w: number; h: number };
type Ok = Extract<AutoRigResult, { ok: true }>;

const createdDirs: string[] = [];
/** Output must resolve UNDER cwd; node_modules is gitignored. */
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-custom-parts-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function writeLayer(
  dir: string,
  name: string,
  rect: Rect | undefined,
  size = CANVAS,
  color = { r: 200, g: 120, b: 60 },
): Promise<string> {
  const filePath = path.join(dir, name);
  const base = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  if (rect === undefined) {
    await base.png().toFile(filePath);
    return filePath;
  }
  const overlay = await sharp({
    create: {
      width: rect.w,
      height: rect.h,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await base
    .composite([{ input: overlay, left: rect.x, top: rect.y }])
    .png()
    .toFile(filePath);
  return filePath;
}

/** The role set with the nose and bangs, so the head is measured and a turn
 *  is solved. */
async function writeRoles(dir: string): Promise<{ path: string }[]> {
  const files = [
    ["face.png", { x: 20, y: 20, w: 60, h: 60 }],
    ["eye_L.png", { x: 30, y: 35, w: 12, h: 8 }],
    ["eye_R.png", { x: 58, y: 35, w: 12, h: 8 }],
    ["mouth.png", { x: 42, y: 60, w: 16, h: 8 }],
    ["nose.png", { x: 46, y: 44, w: 8, h: 8 }],
    ["hair_front.png", { x: 10, y: 25, w: 80, h: 31 }],
  ] as const;
  return Promise.all(
    files.map(async ([name, rect]) => ({
      path: await writeLayer(dir, name, rect),
    })),
  );
}

/** A tail the width of the canvas, so it crosses the eye row beyond the face. */
async function tailEntry(
  dir: string,
  over: Partial<AutoRigCustomPartInput> = {},
): Promise<AutoRigCustomPartInput> {
  return {
    id: "tail",
    path: await writeLayer(
      dir,
      "tail.png",
      { x: 2, y: 30, w: 96, h: 40 },
      CANVAS,
      { r: 40, g: 90, b: 200 },
    ),
    anchor: "face",
    tie: [30, 40],
    after: "hair_front",
    ...over,
  };
}

function readModel(file: string): IkiModel {
  return parseIkiModel(JSON.parse(fs.readFileSync(file, "utf8")));
}

async function rig(
  dir: string,
  name: string,
  input: Partial<Parameters<typeof autoRigFromLayers>[0]>,
  layers: { path: string }[],
): Promise<Ok> {
  const r = await autoRigFromLayers({
    layers,
    outputPath: path.join(dir, name),
    ...input,
  });
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

describe("auto_rig_from_layers customParts", () => {
  let dir: string;
  let layers: { path: string }[];
  let tail: AutoRigCustomPartInput;
  let roles: Ok;
  let withTail: Ok;

  beforeAll(async () => {
    dir = tmpDir();
    layers = await writeRoles(dir);
    tail = await tailEntry(dir);
    roles = await rig(dir, "none.iki", {}, layers);
    withTail = await rig(dir, "t.iki", { customParts: [tail] }, layers);
  });

  it("writes the same file for no customParts and for []", async () => {
    const empty = await rig(dir, "empty.iki", { customParts: [] }, layers);
    expect(fs.readFileSync(path.join(dir, "empty.iki"), "utf8")).toBe(
      fs.readFileSync(path.join(dir, "none.iki"), "utf8"),
    );
    expect(roles.customParts).toBeUndefined();
    expect(empty.customParts).toMatchObject({
      parts: [],
      gate: { ok: true, parts: [] },
    });
  });

  it("puts the custom parts on the last page and leaves page 0 as it was", async () => {
    await rig(dir, "q-roles.iki", { quantizeColors: 256 }, layers);
    const quantized = await rig(
      dir,
      "q-tail.iki",
      { quantizeColors: 256, customParts: [tail] },
      layers,
    );
    const before = readModel(path.join(dir, "q-roles.iki"));
    const after = readModel(path.join(dir, "q-tail.iki"));

    // The nose is page 1 on both; the custom page comes after it.
    expect(before.textures).toHaveLength(2);
    expect(after.textures).toHaveLength(3);
    expect(after.textures![0].source).toBe(before.textures![0].source);
    expect(after.textures![1].source).toBe(before.textures![1].source);
    expect(after.parts.find((p) => p.id === "tail")!.texture!.index).toBe(2);
    expect(after.parts.find((p) => p.id === "nose")!.texture!.index).toBe(1);
    expect(quantized.customParts!.parts.map((p) => p.page)).toEqual([2]);
  });

  it("rigs the role layers as it would without the custom parts", async () => {
    expect(withTail.headHalfWidth).toBe(roles.headHalfWidth);
    expect(withTail.headEdges).toEqual(roles.headEdges);
    expect(withTail.turn).toEqual(roles.turn);

    const base = readModel(path.join(dir, "none.iki"));
    const custom = readModel(path.join(dir, "t.iki"));
    const strip = (m: IkiModel) => ({
      ...m,
      textures: undefined,
      parts: m.parts.map(({ order: _order, ...p }) => p),
    });
    expect(
      strip({ ...custom, parts: custom.parts.filter((p) => p.id !== "tail") }),
    ).toEqual(strip(base));
    // Drawn right after hair_front's part, with the order reassigned.
    const ids = custom.parts.map((p) => p.id);
    expect(ids[ids.indexOf("hair_front") + 1]).toBe("tail");
    expect(custom.parts.map((p) => p.order)).toEqual(
      custom.parts.map((_, i) => i),
    );
  });

  it("reports each part's box, mesh, order and page", async () => {
    const model = readModel(path.join(dir, "t.iki"));
    const part = model.parts.find((p) => p.id === "tail")!;
    expect(withTail.customParts!.parts).toEqual([
      {
        id: "tail",
        box: { x: 1, y: 29, w: 98, h: 42 },
        mesh: {
          vertices: part.mesh!.vertices.length / 2,
          triangles: part.mesh!.indices.length / 3,
        },
        order: part.order,
        // One lossless page of the roles, so the custom page is the second.
        page: 1,
      },
    ]);
  });

  describe("refusals write nothing", () => {
    async function refused(
      entry: AutoRigCustomPartInput,
      expected: RegExp,
    ): Promise<void> {
      const out = path.join(dir, "refused.iki");
      const r = await autoRigFromLayers({
        layers,
        outputPath: out,
        customParts: [entry],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(expected);
      expect(fs.existsSync(out)).toBe(false);
    }

    it("a layer of another size", async () => {
      const small = await writeLayer(
        dir,
        "small.png",
        { x: 5, y: 5, w: 10, h: 10 },
        50,
      );
      await refused({ ...tail, path: small }, /^customParts\[0\]\.path size/);
    });

    it("an empty layer", async () => {
      const empty = await writeLayer(dir, "empty.png", undefined);
      await refused(
        { ...tail, path: empty },
        /^customParts\[0\]\.path .*empty/,
      );
    });

    it("a path that does not exist, named by its customParts path", async () => {
      await refused(
        { ...tail, path: path.join(dir, "nope.png") },
        /^customParts\[0\]\.path file not found: /,
      );
    });

    it("an entry the rig refuses", async () => {
      await refused({ ...tail, tie: [5, 5] }, /^customParts\[0\]\.tie /);
      await refused({ ...tail, id: "face" }, /^customParts\[0\]\.id /);
    });
  });
});
