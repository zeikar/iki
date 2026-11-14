import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { IkiModel, IkiPart } from "@ikijs/format";
import { findBrowser } from "../src/render-browser";
import { renderPoses } from "../src/render-poses";

// The page bundle inlines the engine: run `pnpm build` after an engine edit,
// or these render the old engine and prove nothing.

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const CYAN: Rgb = [0, 255, 255];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];
const MAGENTA: Rgb = [255, 0, 255];

const SIZE = 560;

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-render-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

const solid = ([r, g, b]: Rgb): IkiPart["color"] => [
  r / 255,
  g / 255,
  b / 255,
  1,
];

// A mesh quad, so it can be an occluder or a clip mask; `texture` makes it
// sample the atlas, otherwise it is a solid fill.
const quad = (
  id: string,
  color: Rgb,
  x: number,
  y: number,
  width: number,
  height: number,
  order: number,
  extra: Partial<IkiPart> = {},
): IkiPart => ({
  id,
  color: solid(color),
  width,
  height,
  transform: { x, y },
  order,
  mesh: {
    vertices: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
  },
  ...extra,
});

const backdrop = (): IkiPart => ({
  id: "backdrop",
  color: solid(BLUE),
  width: SIZE,
  height: SIZE,
  transform: { x: 0, y: 0 },
  order: 0,
});

const occluded = (by: string[]) => ({
  by,
  parameter: "k",
  stops: [
    { value: 0, amount: 0 },
    { value: 1, amount: 1 },
  ],
});

// The key `k` doubles as the amount; `f` fades an occluder through its
// opacity binding.
const build = (
  parts: IkiPart[],
  withField: boolean,
  textures?: IkiModel["textures"],
): IkiModel => ({
  version: 1,
  name: "occlusion",
  canvas: { width: SIZE, height: SIZE },
  parameters: ["k", "f"].map((id) => ({ id, min: 0, max: 1, default: 0 })),
  // JSON.stringify drops the undefined field.
  parts: parts.map((p) => (withField ? p : { ...p, occlusion: undefined })),
  ...(textures ? { textures } : {}),
});

type Frame = { data: Buffer; file: string };

async function render(
  parts: IkiPart[],
  withField: boolean,
  values: Record<string, number>,
  textures?: IkiModel["textures"],
): Promise<Frame> {
  const dir = tmpDir();
  const modelPath = path.join(dir, "m.iki");
  fs.writeFileSync(
    modelPath,
    JSON.stringify(build(parts, withField, textures)),
  );
  const r = await renderPoses({
    modelPath,
    outDir: dir,
    poses: [{ name: "p", values }],
  });
  if (!r.ok) throw new Error(r.error);
  const file = path.join(dir, "p.png");
  const { data, info } = await sharp(file)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(SIZE);
  expect(info.channels).toBe(4);
  return { data, file };
}

// The model's centre is the canvas centre and a model unit is a pixel.
const at = ({ data }: Frame, x: number, y: number): Rgb => {
  const i = ((SIZE / 2 - y) * SIZE + (SIZE / 2 + x)) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const expectRgb = (got: Rgb, want: Rgb, tolerance = 2) => {
  got.forEach((v, i) =>
    expect(Math.abs(v - want[i])).toBeLessThanOrEqual(tolerance),
  );
};

const PART = (extra: Partial<IkiPart> = {}) =>
  quad("part", RED, 0, 0, 200, 200, 2, extra);

// The occluder covers the part's right half; its left half is uncovered.
const rightHalf = (order: number, extra: Partial<IkiPart> = {}) =>
  quad("occ", GREEN, 50, 0, 100, 300, order, extra);

describe.skipIf(findBrowser() === undefined)("occlusion in a browser", () => {
  it("is byte-identical to the model without the field at amount 0", async () => {
    const parts = [
      backdrop(),
      rightHalf(1),
      PART({ occlusion: occluded(["occ"]) }),
    ];
    const withField = await render(parts, true, { k: 0 });
    const without = await render(parts, false, { k: 0 });
    expect(
      fs.readFileSync(withField.file).equals(fs.readFileSync(without.file)),
    ).toBe(true);
  });

  it("hides the covered half at amount 1, occluder drawn before the part", async () => {
    const parts = [
      backdrop(),
      rightHalf(1),
      PART({ occlusion: occluded(["occ"]) }),
    ];
    const hidden = await render(parts, true, { k: 1 });
    const plain = await render(parts, false, { k: 1 });
    expectRgb(at(hidden, 50, 0), GREEN);
    expectRgb(at(hidden, -50, 0), RED);
    expectRgb(at(hidden, -50, 0), at(plain, -50, 0), 0);
    expectRgb(at(hidden, -50, 80), at(plain, -50, 80), 0);
  });

  // An opaque occluder drawn later would show its colour with or without
  // occlusion, so this one is translucent (0.8, still a cover): hidden, it sits
  // over the backdrop; otherwise over the part.
  it("hides the covered half at amount 1, occluder drawn after the part", async () => {
    const parts = [
      backdrop(),
      rightHalf(3, { color: [0, 1, 0, 0.8] }),
      PART({ occlusion: occluded(["occ"]) }),
    ];
    const hidden = await render(parts, true, { k: 1 });
    const plain = await render(parts, false, { k: 1 });
    expectRgb(at(hidden, 50, 0), [0, 204, 51]);
    expectRgb(at(plain, 50, 0), [51, 204, 0]);
    expectRgb(at(hidden, -50, 0), RED);
  });

  it("hides the union of two occluders", async () => {
    const parts = [
      backdrop(),
      quad("occ", GREEN, -70, 0, 60, 400, 1),
      quad("occ2", CYAN, 70, 0, 60, 400, 1),
      PART({ occlusion: occluded(["occ", "occ2"]) }),
    ];
    const hidden = await render(parts, true, { k: 1 });
    expectRgb(at(hidden, -70, 0), GREEN);
    expectRgb(at(hidden, 70, 0), CYAN);
    expectRgb(at(hidden, 0, 0), RED);
  });

  it.each([0.25, 0.5, 0.75])(
    "draws the part over the occluder in the 1 - amount share at %s",
    async (amount) => {
      const parts = [
        backdrop(),
        rightHalf(1),
        PART({ occlusion: occluded(["occ"]) }),
      ];
      const frame = await render(parts, true, { k: amount });
      expectRgb(at(frame, 50, 0), [255 * (1 - amount), 255 * amount, 0]);
      expectRgb(at(frame, -50, 0), RED);
    },
  );

  it.each([0.5, 1])(
    "leaves no seam on a diagonal occluder edge at amount %s",
    async (amount) => {
      const parts = [
        backdrop(),
        quad("occ", GREEN, 50, 0, 100, 600, 1, {
          transform: { x: 50, y: 0, rotation: 30 },
        }),
        PART({ occlusion: occluded(["occ"]) }),
      ];
      const frame = await render(parts, true, { k: amount });
      for (let y = -96; y <= 96; y++) {
        for (let x = -96; x <= 96; x++) {
          const [, , b] = at(frame, x, y);
          expect(b).toBeLessThanOrEqual(2);
        }
      }
    },
  );

  it("covers where the occluder's alpha is at least a half", async () => {
    // Left half of the patch at alpha 0.3, right half at 0.8.
    const w = 64;
    const raw = Buffer.alloc(w * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < w; x++) {
        raw.set([0, 255, 0, x < w / 2 ? 77 : 204], (y * w + x) * 4);
      }
    }
    const png = await sharp(raw, { raw: { width: w, height: 8, channels: 4 } })
      .png()
      .toBuffer();
    const frame = await render(
      [
        backdrop(),
        quad("occ", [255, 255, 255], 0, 0, 200, 200, 1, {
          texture: { index: 0, uv: { x: 0, y: 0, width: 1, height: 1 } },
        }),
        PART({ occlusion: occluded(["occ"]) }),
      ],
      true,
      { k: 1 },
      [{ source: `data:image/png;base64,${png.toString("base64")}` }],
    );
    // Under alpha 0.3 the occluder covers nothing: the part shows whole.
    expectRgb(at(frame, -50, 0), RED);
    // Under 0.8 it covers: the part is hidden, the occluder's 0.8 over the backdrop.
    expectRgb(at(frame, 50, 0), [0, 204, 51]);
  });

  it("covers nothing while the occluder is faded under a half", async () => {
    const parts = [
      backdrop(),
      rightHalf(1, {
        bindings: [{ parameter: "f", channel: "opacity", from: 1, to: 0.4 }],
      }),
      PART({ occlusion: occluded(["occ"]) }),
    ];
    const faded = await render(parts, true, { k: 1, f: 1 });
    expectRgb(at(faded, 50, 0), RED);
    const solidOcc = await render(parts, true, { k: 1, f: 0 });
    expectRgb(at(solidOcc, 50, 0), GREEN);
  });

  describe("restores the state clipped and plain parts expect", () => {
    // Top: a clipped part drawn before the occluded part. Bottom: one drawn
    // after it, whose mask also shows plain above and below the clipped part.
    // A cyan plain part follows the occluded part at once, inside the occluder's
    // coverage but off the part: a stencil test left on would drop it.
    const parts = () => [
      backdrop(),
      quad("m1", MAGENTA, -40, 200, 80, 120, 1),
      quad("c1", YELLOW, 0, 200, 160, 80, 2, { clip: { masks: ["m1"] } }),
      rightHalf(3),
      PART({ order: 4, occlusion: occluded(["occ"]) }),
      quad("m2", MAGENTA, -40, -200, 80, 120, 5),
      quad("c2", YELLOW, 0, -200, 160, 80, 6, { clip: { masks: ["m2"] } }),
      quad("after", CYAN, 60, 125, 40, 40, 4.5),
    ];

    const clipsAndPlainIntact = (frame: Frame) => {
      // Inside the mask: the clipped part; beyond it: the backdrop.
      for (const y of [200, -200]) {
        expectRgb(at(frame, -40, y), YELLOW);
        expectRgb(at(frame, 40, y), BLUE);
      }
      // The mask shows where the clipped part does not reach.
      expectRgb(at(frame, -40, 245), MAGENTA);
      expectRgb(at(frame, -40, -245), MAGENTA);
      expectRgb(at(frame, 60, 125), CYAN);
    };

    it("equals the model without the field at amount 0", async () => {
      const withField = await render(parts(), true, { k: 0 });
      const without = await render(parts(), false, { k: 0 });
      expect(
        fs.readFileSync(withField.file).equals(fs.readFileSync(without.file)),
      ).toBe(true);
      clipsAndPlainIntact(withField);
    });

    it("still clips both clipped parts at amount 1", async () => {
      const frame = await render(parts(), true, { k: 1 });
      expectRgb(at(frame, 50, 0), GREEN);
      clipsAndPlainIntact(frame);
    });
  });
});
