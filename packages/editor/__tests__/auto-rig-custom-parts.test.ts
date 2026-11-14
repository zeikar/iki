import { describe, expect, it } from "vitest";
import {
  EditorDocument,
  generateIkiFromLayerSet,
  type CustomPart,
  type RigPlanReport,
  type TurnSolveReport,
} from "@ikijs/editor";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import { checkCustomParts } from "../src/auto-rig/custom-parts";
import { ROLE_TABLE, partIdsOfRole } from "../src/auto-rig/roles";
import { CustomPartError, type LayerInput } from "../src/auto-rig/types";
import { CANVAS, character } from "./helpers/character";
import { fullBody } from "./helpers/full-body";

const { layers } = character();
const byRole = new Map<string, LayerInput>(layers.map((l) => [l.role, l]));
const faceBox = byRole.get("face")!.bbox;

const good = (extra: Record<string, unknown> = {}) => ({
  id: "ribbon",
  layer: {
    fileName: "ribbon.png",
    bbox: { x: faceBox.x, y: faceBox.y, w: 100, h: 100 },
  },
  anchor: "face",
  tie: [faceBox.x + 50, faceBox.y + 50],
  after: "hair_back",
  ...extra,
});

const rigged = generateIkiFromLayerSet(layers, CANVAS, character().options);
const check = (
  customParts: unknown,
  roles: ReadonlyMap<string, LayerInput>,
  canvas: { width: number; height: number },
) =>
  checkCustomParts(
    customParts,
    roles,
    canvas,
    rigged.parameters,
    new Set((rigged.physics ?? []).map((r) => r.output.parameter)),
  );

const refused = (customParts: unknown): string => {
  try {
    check(customParts, byRole, CANVAS);
  } catch (e) {
    expect(e).toBeInstanceOf(CustomPartError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("checkCustomParts", () => {
  it("passes a valid list, with and without deformer", () => {
    const list = [
      good(),
      good({
        id: "pin",
        deformer: "headDeformer",
      }),
    ];
    expect(check(list, byRole, CANVAS)).toHaveLength(2);
    expect(check([], byRole, CANVAS)).toEqual([]);
  });

  it("refuses a non-array", () => {
    expect(refused({})).toMatch(/^customParts must be an array/);
  });

  it("refuses a non-object entry", () => {
    expect(refused(["x"])).toMatch(/^customParts\[0\] must be a plain object/);
    expect(refused([good(), null])).toMatch(/^customParts\[1\]/);
  });

  it("refuses an unknown key and lists the keys", () => {
    const m = refused([good({ colour: 1 })]);
    expect(m).toMatch(/^customParts\[0\]\.colour is not one of /);
    expect(m).toContain("id, layer, anchor, tie, after, deformer");
  });

  it("refuses an id that is not a plain identifier", () => {
    expect(refused([good({ id: "a b" })])).toMatch(/^customParts\[0\]\.id /);
    expect(refused([good({ id: "1a" })])).toMatch(/^customParts\[0\]\.id /);
    expect(refused([good({ id: 3 })])).toMatch(/^customParts\[0\]\.id /);
  });

  it("refuses a repeated id", () => {
    expect(refused([good(), good()])).toMatch(
      /^customParts\[1\]\.id "ribbon" repeats/,
    );
  });

  it("refuses a role's name or a part id a role yields, as reserved", () => {
    const reserved = ROLE_TABLE.flatMap((r) => [
      r.role,
      ...partIdsOfRole(r.role),
    ]);
    expect(reserved).toContain("elbow_L");
    for (const id of new Set(reserved)) {
      const m = refused([good({ id })]);
      expect(m).toMatch(/^customParts\[0\]\.id /);
      expect(m).toContain("reserved");
      expect(m).toContain("added later");
    }
  });

  it("refuses a layer bbox that is not finite, empty or outside the canvas", () => {
    const bad = [
      { x: NaN, y: 0, w: 10, h: 10 },
      { x: 0, y: 0, w: 0, h: 10 },
      { x: -1, y: 0, w: 10, h: 10 },
      { x: 995, y: 0, w: 10, h: 10 },
      { x: 0, y: 0, w: 10, h: 1001 },
      undefined,
    ];
    for (const bbox of bad) {
      expect(refused([good({ layer: { fileName: "r.png", bbox } })])).toMatch(
        /^customParts\[0\]\.layer\.bbox /,
      );
    }
  });

  it("pins the canvas edge from both sides", () => {
    const full = new Map(byRole).set("face", {
      ...byRole.get("face")!,
      bbox: { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height },
    });
    const withW = (w: number) => [
      good({
        layer: { fileName: "r.png", bbox: { x: 900, y: 0, w, h: 10 } },
        tie: [950, 5],
      }),
    ];
    expect(check(withW(CANVAS.width - 900), full, CANVAS)).toHaveLength(1);
    expect(() => check(withW(CANVAS.width - 900 + 1), full, CANVAS)).toThrow(
      /^customParts\[0\]\.layer\.bbox /,
    );
  });

  it("pins the tie's far edges from both sides", () => {
    const x = faceBox.x;
    const y = faceBox.y;
    const own = { fileName: "r.png", bbox: { x, y, w: 100, h: 100 } };
    const ok = (tie: unknown) =>
      check([good({ layer: own, tie })], byRole, CANVAS);
    expect(ok([x + 99, y + 99])).toHaveLength(1);
    expect(() => ok([x + 100, y + 50])).toThrow(/^customParts\[0\]\.tie /);
    expect(() => ok([x + 50, y + 100])).toThrow(/^customParts\[0\]\.tie /);
    // The anchor's box: a tie on its far edge, inside the part's own box.
    const edge = faceBox.x + faceBox.w;
    const wide = {
      fileName: "r.png",
      bbox: { x: edge - 50, y, w: 100, h: 100 },
    };
    const at = (px: number) =>
      check([good({ layer: wide, tie: [px, y + 50] })], byRole, CANVAS);
    expect(at(edge - 1)).toHaveLength(1);
    expect(() => at(edge)).toThrow(/^customParts\[0\]\.tie /);
  });

  it("refuses a layer that is not an object with a file name", () => {
    expect(refused([good({ layer: 1 })])).toMatch(
      /^customParts\[0\]\.layer must/,
    );
    expect(refused([good({ layer: { fileName: "", bbox: faceBox } })])).toMatch(
      /^customParts\[0\]\.layer\.fileName /,
    );
    expect(
      refused([good({ layer: { fileName: "r.png", bbox: faceBox, x: 1 } })]),
    ).toMatch(/^customParts\[0\]\.layer\.x is not one of /);
  });

  it("refuses an anchor or after outside the set, listing the present roles", () => {
    for (const field of ["anchor", "after"]) {
      const m = refused([good({ [field]: "tail" })]);
      expect(m).toMatch(new RegExp(`^customParts\\[0\\]\\.${field} `));
      expect(m).toContain([...byRole.keys()].join(", "));
    }
    expect(refused([good({ anchor: 3 })])).toMatch(
      /^customParts\[0\]\.anchor /,
    );
  });

  it("refuses a tie that is malformed or outside either box", () => {
    const x = faceBox.x;
    const y = faceBox.y;
    const ties: unknown[] = [
      [x + 50],
      [NaN, y + 50],
      "x",
      // Outside the custom layer's box (100 x 100 at the face's corner).
      [x + 150, y + 50],
      // Inside the custom layer's box, outside the anchor's.
      [x - 5, y + 50],
    ];
    const m = refused([
      good({
        layer: { fileName: "r.png", bbox: { x: x - 20, y, w: 100, h: 100 } },
        tie: ties[4],
      }),
    ]);
    expect(m).toMatch(/^customParts\[0\]\.tie /);
    expect(m).toContain('anchor "face"');
    for (const tie of ties.slice(0, 4)) {
      expect(refused([good({ tie })])).toMatch(/^customParts\[0\]\.tie /);
    }
  });

  it("refuses a deformer other than headDeformer, naming the one accepted", () => {
    const m = refused([good({ deformer: "bodyDeformer" })]);
    expect(m).toMatch(/^customParts\[0\]\.deformer /);
    expect(m).toContain("headDeformer");
  });

  it("checks rigid", () => {
    expect(check([good({ rigid: true })], byRole, CANVAS)).toHaveLength(1);
    expect(refused([good({ rigid: "yes" })])).toMatch(
      /^customParts\[0\]\.rigid must be true or false/,
    );
  });

  describe("occlusion", () => {
    const occlusion = (extra: Record<string, unknown> = {}) => ({
      by: ["hair_front"],
      parameter: "ParamAngleX",
      stops: [
        { value: 5, amount: 0 },
        { value: 15, amount: 1 },
      ],
      ...extra,
    });
    const withOcclusion = (extra: Record<string, unknown> = {}) => [
      good({ occlusion: occlusion(extra) }),
    ];

    it("passes a valid occlusion", () => {
      expect(check(withOcclusion(), byRole, CANVAS)).toHaveLength(1);
      expect(
        check(
          withOcclusion({
            by: ["hair_front", "face"],
            stops: [{ value: 0, amount: 1 }],
          }),
          byRole,
          CANVAS,
        ),
      ).toHaveLength(1);
    });

    it("refuses what is not an object, and an unknown key", () => {
      expect(refused([good({ occlusion: 3 })])).toMatch(
        /^customParts\[0\]\.occlusion must be a plain object/,
      );
      expect(refused(withOcclusion({ extra: 1 }))).toMatch(
        /^customParts\[0\]\.occlusion\.extra is not one of/,
      );
    });

    it("refuses a by that is empty, not an array, or not roles of the set", () => {
      for (const by of [[], "hair_front", undefined]) {
        expect(refused(withOcclusion({ by }))).toMatch(
          /^customParts\[0\]\.occlusion\.by must be a non-empty array/,
        );
      }
      const m = refused(withOcclusion({ by: ["hair_front", "tail"] }));
      expect(m).toMatch(/^customParts\[0\]\.occlusion\.by\[1\] /);
      expect(m).toContain("one of body, face, ");
      expect(refused(withOcclusion({ by: [3] }))).toMatch(
        /^customParts\[0\]\.occlusion\.by\[0\] /,
      );
    });

    it("refuses a repeated role, naming its index", () => {
      expect(
        refused(withOcclusion({ by: ["hair_front", "face", "hair_front"] })),
      ).toMatch(/^customParts\[0\]\.occlusion\.by\[2\] "hair_front" repeats/);
    });

    it("refuses a parameter the rig does not declare, and a physics output", () => {
      expect(refused(withOcclusion({ parameter: "ParamNope" }))).toMatch(
        /^customParts\[0\]\.occlusion\.parameter /,
      );
      expect(refused(withOcclusion({ parameter: undefined }))).toMatch(
        /^customParts\[0\]\.occlusion\.parameter /,
      );
      expect(refused(withOcclusion({ parameter: "ParamHairSwayX" }))).toMatch(
        /^customParts\[0\]\.occlusion\.parameter "ParamHairSwayX" is a physics output/,
      );
    });

    it("refuses stops by the format's rules, each at its own path", () => {
      const stops = (s: unknown) => refused(withOcclusion({ stops: s }));
      expect(stops([])).toMatch(
        /^customParts\[0\]\.occlusion\.stops must be a non-empty array/,
      );
      expect(stops("x")).toMatch(/^customParts\[0\]\.occlusion\.stops /);
      expect(stops([1])).toMatch(/^customParts\[0\]\.occlusion\.stops\[0\] /);
      expect(stops([{ value: 5, amount: 0, x: 1 }])).toMatch(
        /^customParts\[0\]\.occlusion\.stops\[0\]/,
      );
      expect(stops([{ value: NaN, amount: 0 }])).toMatch(
        /^customParts\[0\]\.occlusion\.stops\[0\]\.value /,
      );
      expect(stops([{ value: "5", amount: 0 }])).toMatch(
        /^customParts\[0\]\.occlusion\.stops\[0\]\.value /,
      );
      expect(stops([{ value: 31, amount: 0 }])).toMatch(
        /^customParts\[0\]\.occlusion\.stops\[0\]\.value 31 is outside parameter "ParamAngleX" range/,
      );
      expect(
        stops([
          { value: 5, amount: 0 },
          { value: 5, amount: 1 },
        ]),
      ).toMatch(
        /^customParts\[0\]\.occlusion\.stops\[1\]\.value must be strictly ascending/,
      );
      expect(
        stops([
          { value: 5, amount: 0 },
          { value: 4, amount: 1 },
        ]),
      ).toMatch(/^customParts\[0\]\.occlusion\.stops\[1\]\.value /);
      for (const amount of [-0.1, 1.1, NaN, "1", undefined]) {
        expect(stops([{ value: 5, amount }])).toMatch(
          /^customParts\[0\]\.occlusion\.stops\[0\]\.amount /,
        );
      }
    });
  });

  it("refuses a later entry's fault, naming its index", () => {
    expect(refused([good(), good({ id: "b", tie: [0, 0] })])).toMatch(
      /^customParts\[1\]\.tie /,
    );
  });
});

describe("customParts in the generated rig", () => {
  const { layers: bustLayers, options: bustOptions } = character();
  const rigBust = (customParts?: CustomPart[]) =>
    generateIkiFromLayerSet(bustLayers, CANVAS, {
      ...bustOptions,
      ...(customParts === undefined ? {} : { customParts }),
    });
  const withoutOrder = (m: IkiModel) => ({
    ...m,
    parts: m.parts.map(({ order: _order, ...p }) => p),
  });
  const ribbon = good() as unknown as CustomPart;

  it("gives a model identical to none for undefined and for []", () => {
    const bust = JSON.stringify(rigBust());
    expect(JSON.stringify(rigBust([]))).toBe(bust);
    expect(
      JSON.stringify(
        generateIkiFromLayerSet(bustLayers, CANVAS, {
          ...bustOptions,
          customParts: undefined,
        }),
      ),
    ).toBe(bust);

    const fb = fullBody({ arms: true });
    const rigFb = (extra: object) =>
      JSON.stringify(
        generateIkiFromLayerSet(fb.layers, fb.canvas, {
          ...fb.options,
          ...extra,
        }),
      );
    expect(rigFb({ customParts: [] })).toBe(rigFb({}));
    expect(rigFb({ customParts: undefined })).toBe(rigFb({}));
  });

  it("leaves every other part and the rest of the model as they were", () => {
    const base = rigBust();
    const custom = rigBust([ribbon]);
    expect(custom.parts.map((p) => p.id)).toContain("ribbon");
    const rest = {
      ...custom,
      parts: custom.parts.filter((p) => p.id !== "ribbon"),
    };
    expect(withoutOrder(rest)).toEqual(withoutOrder(base));
    expect(rest.parts.map((p) => p.id)).toEqual(base.parts.map((p) => p.id));
    expect(custom.parts.map((p) => p.order)).toEqual(
      custom.parts.map((_, i) => i),
    );
  });

  it("with bakes, leaves the rest of the model as it was", () => {
    const base = rigBust();
    const custom = generateIkiFromLayerSet(bustLayers, CANVAS, {
      ...bustOptions,
      customParts: [ribbon],
      bakes: {
        targets: [
          {
            param: "ParamAngleX",
            parts: ["ribbon"],
            grid: { cols: 1, rows: 1 },
            stops: {
              "30": [
                [5, 0],
                [5, 0],
                [5, 0],
                [5, 0],
              ],
            },
          },
        ],
      },
    });
    expect(custom.parts.find((p) => p.id === "ribbon")!.warps).toHaveLength(1);
    const rest = {
      ...custom,
      parts: custom.parts.filter((p) => p.id !== "ribbon"),
    };
    expect(withoutOrder(rest)).toEqual(withoutOrder(base));
  });

  it("reports the turn and the rig plan as without", () => {
    const reports = (customParts?: CustomPart[]) => {
      let turn: TurnSolveReport | undefined;
      let plan: RigPlanReport | undefined;
      generateIkiFromLayerSet(bustLayers, CANVAS, {
        ...bustOptions,
        ...(customParts === undefined ? {} : { customParts }),
        onTurnSolved: (r) => (turn = r),
        onRigPlanResolved: (r) => (plan = r),
      });
      return { turn, plan };
    };
    const without = reports();
    expect(without.turn).toBeDefined();
    expect(reports([ribbon])).toEqual(without);
  });

  describe("occlusion", () => {
    const stops = [
      { value: 5, amount: 0 },
      { value: 15, amount: 1 },
    ];
    const fb = fullBody({ arms: true });
    const fbRibbon = (occlusion: unknown) => {
      const face = fb.layers.find((l) => l.role === "face")!.bbox;
      return {
        ...good({ occlusion }),
        layer: {
          fileName: "ribbon.png",
          bbox: { x: face.x, y: face.y, w: 100, h: 100 },
        },
        tie: [face.x + 50, face.y + 50],
      } as unknown as CustomPart;
    };
    const rigFb = (occlusion: unknown) =>
      generateIkiFromLayerSet(fb.layers, fb.canvas, {
        ...fb.options,
        customParts: [fbRibbon(occlusion)],
      });

    it("writes the role's part ids that are in the model, and the model validates", () => {
      const model = rigFb({ by: ["arm_L"], parameter: "ParamAngleX", stops });
      const written = model.parts.find((p) => p.id === "ribbon")!.occlusion!;
      expect(written.by).toEqual(["elbow_L", "forearm_L", "arm_L"]);
      expect(written.parameter).toBe("ParamAngleX");
      expect(written.stops).toEqual(stops);
      expect(() =>
        parseIkiModel(JSON.parse(JSON.stringify(model))),
      ).not.toThrow();
    });

    it("refuses a role with a clipped part, naming the part", () => {
      expect(() =>
        rigFb({ by: ["iris_L"], parameter: "ParamAngleX", stops }),
      ).toThrow(
        /^customParts\[0\]\.occlusion\.by\[0\] "iris_L" yields part "iris_L", which is clipped/,
      );
    });

    it("refuses a role with a meshless part, naming the part", () => {
      const pose = fullBody({ arms: true, poses: true });
      expect(() =>
        generateIkiFromLayerSet(pose.layers, pose.canvas, {
          ...pose.options,
          customParts: [
            {
              ...fbRibbon({
                by: ["forearm_pose_L"],
                parameter: "ParamAngleX",
                stops,
              }),
            },
          ],
        }),
      ).toThrow(
        /^customParts\[0\]\.occlusion\.by\[0\] "forearm_pose_L" yields part "forearm_pose_L", which has no mesh/,
      );
    });

    it("gives the rig minus its custom parts as without, no occluder gaining a field", () => {
      const base = generateIkiFromLayerSet(fb.layers, fb.canvas, fb.options);
      const custom = rigFb({ by: ["arm_L"], parameter: "ParamAngleX", stops });
      const rest = {
        ...custom,
        parts: custom.parts.filter((p) => p.id !== "ribbon"),
      };
      expect(withoutOrder(rest)).toEqual(withoutOrder(base));
    });

    it("writes none for an entry without the key", () => {
      expect(
        rigBust([ribbon]).parts.find((p) => p.id === "ribbon")!,
      ).not.toHaveProperty("occlusion");
    });
  });

  it("places the part: its box, a plain mesh, headDeformer, draw order", () => {
    const model = rigBust([ribbon]);
    const part = model.parts.find((p) => p.id === "ribbon")!;
    // A 100 x 100 box at the face's top left corner, on a 1000 canvas.
    expect(part.width).toBe(100);
    expect(part.height).toBe(100);
    expect(part.transform.x).toBe(faceBox.x + 50 - CANVAS.width / 2);
    expect(part.transform.y).toBe(CANVAS.height / 2 - (faceBox.y + 50));
    expect(part.color).toEqual([1, 1, 1, 1]);
    expect(part.deformer).toBe("headDeformer");
    expect(part.warps ?? []).toEqual([]);
    expect(part.mesh!.vertices.length / 2).toBe(6 * 6);
    expect(part.mesh!.indices.length / 3).toBe(5 * 5 * 2);
    const ids = model.parts.map((p) => p.id);
    const backs = partIdsOfRole("hair_back").map((id) => ids.indexOf(id));
    expect(ids.indexOf("ribbon")).toBe(Math.max(...backs) + 1);
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("sizes the mesh at about 20 px a cell, at least one", () => {
    const thin = {
      ...good({ id: "thread", tie: [faceBox.x + 3, faceBox.y + 50] }),
      layer: {
        fileName: "t.png",
        bbox: { x: faceBox.x, y: faceBox.y, w: 6, h: 300 },
      },
    } as unknown as CustomPart;
    const part = rigBust([thin]).parts.find((p) => p.id === "thread")!;
    // 1 column, 15 rows.
    expect(part.mesh!.vertices.length / 2).toBe(2 * 16);
  });

  it("puts entries with the same `after` in list order, one after the other", () => {
    const model = rigBust([
      good({ id: "a", after: "face" }),
      good({ id: "b", after: "face" }),
    ] as unknown as CustomPart[]);
    const ids = model.parts.map((p) => p.id);
    expect(ids.indexOf("b")).toBe(ids.indexOf("a") + 1);
    expect(ids.indexOf("a")).toBe(ids.indexOf("face") + 1);
  });

  it("goes after the last of a role's several parts", () => {
    const fb = fullBody({ arms: true });
    const armBox = fb.layers.find((l) => l.role === "arm_L")!.bbox;
    const pin = {
      id: "cuffpin",
      layer: { fileName: "p.png", bbox: { ...armBox, w: 40, h: 40 } },
      anchor: "arm_L",
      tie: [armBox.x + 10, armBox.y + 10],
      after: "arm_L",
    } as CustomPart;
    const model = generateIkiFromLayerSet(fb.layers, fb.canvas, {
      ...fb.options,
      customParts: [pin],
    });
    const ids = model.parts.map((p) => p.id);
    const armIds = partIdsOfRole("arm_L");
    expect(armIds.length).toBeGreaterThan(1);
    expect(ids.indexOf("cuffpin")).toBe(
      Math.max(...armIds.map((id) => ids.indexOf(id))) + 1,
    );
  });

  it("refuses a patch aimed at a custom part", () => {
    expect(() =>
      generateIkiFromLayerSet(bustLayers, CANVAS, {
        ...bustOptions,
        customParts: [ribbon],
        patches: [
          {
            target: "ribbon",
            at: { ParamAngleX: 30 },
            region: { role: "face", x: [0, 1], y: [0, 1] },
            by: { dx: 0.01, dy: 0 },
          },
        ],
      }),
    ).toThrow(/^patches\[0\]\.target "ribbon" is neither a feature grid/);
  });

  it("checks the entries before the rig: a bad patch and a bad entry give CustomPartError", () => {
    expect(() =>
      generateIkiFromLayerSet(bustLayers, CANVAS, {
        ...bustOptions,
        customParts: [good({ id: "face" }) as unknown as CustomPart],
        patches: [{ target: "nowhere" } as never],
      }),
    ).toThrow(CustomPartError);
  });

  it("survives the editor's document round trip", () => {
    const model = rigBust([ribbon]);
    expect(new EditorDocument(model).getModel()).toEqual(model);
  });
});
