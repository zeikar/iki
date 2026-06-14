import { describe, expect, it } from "vitest";
import {
  IKI_FORMAT_VERSION,
  IkiFormatError,
  loadIkiModel,
  parseIkiModel,
} from "@iki/format";

/** A minimal model that exercises every required field plus one binding. */
function validModel() {
  return {
    version: IKI_FORMAT_VERSION,
    name: "test",
    canvas: { width: 100, height: 100 },
    parameters: [{ id: "ParamA", name: "A", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "part1",
        color: [1, 0, 0, 1],
        width: 10,
        height: 20,
        transform: {
          x: 1,
          y: 2,
          rotation: 30,
          scaleX: 1,
          scaleY: 1,
          opacity: 0.5,
        },
        order: 0,
        bindings: [
          { parameter: "ParamA", channel: "translateX", from: 0, to: 5 },
        ],
      },
    ],
  };
}

describe("parseIkiModel — happy path", () => {
  it("normalizes a fully-specified model", () => {
    const model = parseIkiModel(validModel());
    expect(model.version).toBe(IKI_FORMAT_VERSION);
    expect(model.name).toBe("test");
    expect(model.canvas).toEqual({ width: 100, height: 100 });
    expect(model.parameters).toHaveLength(1);
    expect(model.parts[0].bindings).toHaveLength(1);
    expect(model.parts[0].color).toEqual([1, 0, 0, 1]);
  });

  it("accepts omitted optional fields (parameter name, transform extras, bindings)", () => {
    const input = validModel();
    delete (input.parameters[0] as Record<string, unknown>).name;
    input.parts[0].transform = { x: 0, y: 0 } as never;
    delete (input.parts[0] as Record<string, unknown>).bindings;

    const model = parseIkiModel(input);
    expect(model.parameters[0].name).toBeUndefined();
    expect(model.parts[0].transform.rotation).toBeUndefined();
    expect(model.parts[0].transform.opacity).toBeUndefined();
    expect(model.parts[0].bindings).toBeUndefined();
  });
});

describe("parseIkiModel — top-level errors", () => {
  it("rejects non-object input", () => {
    expect(() => parseIkiModel(42)).toThrow(IkiFormatError);
    expect(() => parseIkiModel(null)).toThrow(/model must be an object/);
    expect(() => parseIkiModel([])).toThrow(/model must be an object/);
  });

  it("rejects a non-number version", () => {
    const input = { ...validModel(), version: "1" };
    expect(() => parseIkiModel(input)).toThrow(
      /version must be a finite number/,
    );
  });

  it("rejects an unsupported version", () => {
    const input = { ...validModel(), version: IKI_FORMAT_VERSION + 1 };
    expect(() => parseIkiModel(input)).toThrow(/unsupported version/);
  });

  it("rejects a missing or empty name", () => {
    const input = { ...validModel(), name: "" };
    expect(() => parseIkiModel(input)).toThrow(
      /name must be a non-empty string/,
    );
  });

  it("rejects a non-object canvas", () => {
    const input = { ...validModel(), canvas: null };
    expect(() => parseIkiModel(input)).toThrow(/canvas must be an object/);
  });

  it("rejects a non-number canvas dimension", () => {
    const input = validModel();
    (input.canvas as Record<string, unknown>).width = "wide";
    expect(() => parseIkiModel(input)).toThrow(
      /canvas.width must be a finite number/,
    );
  });

  it("rejects non-array parameters and parts", () => {
    expect(() => parseIkiModel({ ...validModel(), parameters: {} })).toThrow(
      /parameters must be an array/,
    );
    expect(() => parseIkiModel({ ...validModel(), parts: {} })).toThrow(
      /parts must be an array/,
    );
  });

  it("rejects duplicate parameter ids", () => {
    const input = validModel();
    input.parameters.push({
      id: "ParamA",
      name: "dup",
      min: 0,
      max: 1,
      default: 0,
    });
    expect(() => parseIkiModel(input)).toThrow(
      /duplicate parameter id "ParamA"/,
    );
  });
});

describe("parseParameter errors", () => {
  it("rejects a non-object parameter", () => {
    const input = validModel();
    (input.parameters as unknown[])[0] = 5;
    expect(() => parseIkiModel(input)).toThrow(
      /parameters\[0\] must be an object/,
    );
  });

  it("rejects a missing id and non-number range fields", () => {
    const idless = validModel();
    delete (idless.parameters[0] as Record<string, unknown>).id;
    expect(() => parseIkiModel(idless)).toThrow(/parameters\[0\].id/);

    const badMin = validModel();
    (badMin.parameters[0] as Record<string, unknown>).min = "0";
    expect(() => parseIkiModel(badMin)).toThrow(
      /parameters\[0\].min must be a finite number/,
    );
  });
});

describe("parseColor errors", () => {
  it("rejects a non-array or wrong-length color", () => {
    const notArray = validModel();
    (notArray.parts[0] as Record<string, unknown>).color = "red";
    expect(() => parseIkiModel(notArray)).toThrow(
      /color must be an array of 4 numbers/,
    );

    const tooShort = validModel();
    (tooShort.parts[0] as Record<string, unknown>).color = [1, 0, 0];
    expect(() => parseIkiModel(tooShort)).toThrow(
      /color must be an array of 4 numbers/,
    );
  });

  it("rejects channels outside 0..1 or non-finite", () => {
    const high = validModel();
    high.parts[0].color = [1, 0, 0, 2];
    expect(() => parseIkiModel(high)).toThrow(
      /color\[3\] must be a number in 0\.\.1/,
    );

    const low = validModel();
    low.parts[0].color = [-0.1, 0, 0, 1];
    expect(() => parseIkiModel(low)).toThrow(
      /color\[0\] must be a number in 0\.\.1/,
    );

    const nan = validModel();
    nan.parts[0].color = [Number.NaN, 0, 0, 1] as never;
    expect(() => parseIkiModel(nan)).toThrow(
      /color\[0\] must be a number in 0\.\.1/,
    );
  });
});

describe("parseBinding errors", () => {
  it("rejects an invalid transform channel", () => {
    const input = validModel();
    input.parts[0].bindings[0].channel = "skew" as never;
    expect(() => parseIkiModel(input)).toThrow(/channel must be one of/);
  });

  it("rejects a binding to an undeclared parameter", () => {
    const input = validModel();
    input.parts[0].bindings[0].parameter = "ParamMissing";
    expect(() => parseIkiModel(input)).toThrow(
      /"ParamMissing" is not a declared parameter/,
    );
  });

  it("rejects non-number from/to and a non-object binding", () => {
    const badFrom = validModel();
    (badFrom.parts[0].bindings[0] as Record<string, unknown>).from = "0";
    expect(() => parseIkiModel(badFrom)).toThrow(
      /bindings\[0\].from must be a finite number/,
    );

    const notObject = validModel();
    (notObject.parts[0].bindings as unknown[])[0] = null;
    expect(() => parseIkiModel(notObject)).toThrow(
      /bindings\[0\] must be an object/,
    );
  });
});

describe("parsePart errors", () => {
  it("rejects a non-object part", () => {
    const input = validModel();
    (input.parts as unknown[])[0] = 1;
    expect(() => parseIkiModel(input)).toThrow(/parts\[0\] must be an object/);
  });

  it("rejects a non-object transform and non-array bindings", () => {
    const badTransform = validModel();
    (badTransform.parts[0] as Record<string, unknown>).transform = null;
    expect(() => parseIkiModel(badTransform)).toThrow(
      /transform must be an object/,
    );

    const badBindings = validModel();
    (badBindings.parts[0] as Record<string, unknown>).bindings = {};
    expect(() => parseIkiModel(badBindings)).toThrow(
      /bindings must be an array/,
    );
  });

  it("rejects a non-number order", () => {
    const input = validModel();
    (input.parts[0] as Record<string, unknown>).order = "0";
    expect(() => parseIkiModel(input)).toThrow(/order must be a finite number/);
  });
});

describe("textures — happy path", () => {
  it("(a) accepts a model with textures array and a textured part", () => {
    const input = {
      ...validModel(),
      textures: [{ source: "data:image/png;base64,abc" }],
      parts: [
        {
          ...validModel().parts[0],
          texture: { index: 0, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        },
      ],
    };
    const model = parseIkiModel(input);
    expect(model.textures).toHaveLength(1);
    expect(model.textures![0].source).toBe("data:image/png;base64,abc");
    expect(model.parts[0].texture).toEqual({
      index: 0,
      uv: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
  });

  it("(f) back-compat: existing color-only model with no textures/texture still validates", () => {
    const model = parseIkiModel(validModel());
    expect(model.textures).toBeUndefined();
    expect(model.parts[0].texture).toBeUndefined();
  });
});

describe("textures — top-level errors", () => {
  it("rejects textures as non-array", () => {
    const input = { ...validModel(), textures: { source: "x" } };
    expect(() => parseIkiModel(input)).toThrow(/textures must be an array/);
  });

  it("(e) rejects an empty source string", () => {
    const input = { ...validModel(), textures: [{ source: "" }] };
    expect(() => parseIkiModel(input)).toThrow(
      /textures\[0\].source must be a non-empty string/,
    );
  });

  it("(e2) rejects a non-data: URI source (e.g. a plain filename)", () => {
    const input = { ...validModel(), textures: [{ source: "face.png" }] };
    expect(() => parseIkiModel(input)).toThrow(
      /textures\[0\].source must be a data:image\/ URI \(external sources are not supported yet\)/,
    );
  });

  it("(e3) rejects a data: URI that is not an image (e.g. data:text/plain)", () => {
    const input = {
      ...validModel(),
      textures: [{ source: "data:text/plain,hi" }],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /textures\[0\].source must be a data:image\/ URI \(external sources are not supported yet\)/,
    );
  });
});

describe("part.texture errors", () => {
  function modelWithTexture(
    textureOverride: Record<string, unknown>,
    texturesCount = 1,
  ) {
    return {
      ...validModel(),
      textures: Array.from({ length: texturesCount }, (_, i) => ({
        source: `data:image/png;base64,${i}`,
      })),
      parts: [
        {
          ...validModel().parts[0],
          texture: textureOverride,
        },
      ],
    };
  }

  it("(b) rejects part.texture.index out of range (>= count)", () => {
    const input = modelWithTexture(
      { index: 1, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      1,
    );
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.index 1 is not a declared texture/,
    );
  });

  it("(b) rejects part.texture.index when negative", () => {
    const input = modelWithTexture(
      { index: -1, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      1,
    );
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.index -1 is not a declared texture/,
    );
  });

  it("(b) rejects part.texture.index when non-integer", () => {
    const input = modelWithTexture(
      { index: 0.5, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      1,
    );
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.index 0\.5 is not a declared texture/,
    );
  });

  it("(b) rejects part.texture.index when textures is absent (count 0)", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          texture: { index: 0, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.index 0 is not a declared texture/,
    );
  });

  it("(c) rejects a uv field < 0", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.uv\.x must be a number in 0\.\.1/,
    );
  });

  it("(c) rejects a uv field > 1", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0, y: 0, width: 1.1, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.uv\.width must be a number in 0\.\.1/,
    );
  });

  it("(c) rejects a non-finite uv field", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0, y: Infinity, width: 0.5, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.uv\.y must be a number in 0\.\.1/,
    );
  });

  it("(d) rejects x + width > 1", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0.6, y: 0, width: 0.5, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.uv exceeds atlas bounds/,
    );
  });

  it("(d) rejects y + height > 1", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0, y: 0.6, width: 0.5, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.texture\.uv exceeds atlas bounds/,
    );
  });

  it("accepts a rect that exactly touches the right/bottom edge (x+width===1)", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });
    expect(() => parseIkiModel(input)).not.toThrow();
  });

  it("accepts a rect where float sum 0.1+0.9 is within epsilon of 1", () => {
    const input = modelWithTexture({
      index: 0,
      uv: { x: 0.1, y: 0, width: 0.9, height: 0.5 },
    });
    expect(() => parseIkiModel(input)).not.toThrow();
  });
});

describe("loadIkiModel", () => {
  it("parses a valid JSON string", () => {
    const model = loadIkiModel(JSON.stringify(validModel()));
    expect(model.name).toBe("test");
  });

  it("throws IkiFormatError on malformed JSON", () => {
    expect(() => loadIkiModel("{ not json")).toThrow(IkiFormatError);
    expect(() => loadIkiModel("{ not json")).toThrow(/invalid JSON/);
  });

  it("propagates schema errors from the parsed object", () => {
    expect(() => loadIkiModel('{"version": 1}')).toThrow(
      /canvas must be an object/,
    );
  });
});

// ── Deformer tests ────────────────────────────────────────────────────────────

/** Minimal valid deformer entry. */
function makeDeformer(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, pivot: { x: 0, y: 0 }, ...overrides };
}

describe("deformers — happy path", () => {
  it("(a) valid two-level hierarchy parses without error", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("head"),
        makeDeformer("jaw", {
          parent: "head",
          transform: { x: 0, y: -50, rotation: 5 },
          bindings: [
            { parameter: "ParamA", channel: "rotate", from: 0, to: 30 },
          ],
        }),
      ],
      parts: [{ ...validModel().parts[0], deformer: "jaw" }],
    };
    const model = parseIkiModel(input);
    expect(model.deformers).toHaveLength(2);
    expect(model.deformers![1].parent).toBe("head");
    expect(model.parts[0].deformer).toBe("jaw");
  });

  it("(b) root deformer (omitted parent) is valid", () => {
    const input = { ...validModel(), deformers: [makeDeformer("root")] };
    const model = parseIkiModel(input);
    expect(model.deformers![0].parent).toBeUndefined();
  });

  it("back-compat: model with no deformers and no part.deformer still validates", () => {
    const model = parseIkiModel(validModel());
    expect(model.deformers).toBeUndefined();
    expect(model.parts[0].deformer).toBeUndefined();
  });
});

describe("deformers — parent errors", () => {
  it("(b) unknown parent throws", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("child", { parent: "nonexistent" })],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.parent "nonexistent" is not a declared deformer/,
    );
  });

  it("(c) self-parent throws", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("loop", { parent: "loop" })],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.parent "loop" is a self-reference/,
    );
  });

  it("(d) cycle throws", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("a", { parent: "b" }),
        makeDeformer("b", { parent: "a" }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/deformers contain a cycle/);
  });
});

describe("deformers — id collision errors", () => {
  it("(e) duplicate deformer id throws", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("dup"), makeDeformer("dup")],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[1\]\.id "dup" collides with a previous deformer id/,
    );
  });

  it("(f) deformer id colliding with a part id throws", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("part1")],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.id "part1" collides with parts\[0\]\.id/,
    );
  });
});

describe("deformers — cross-reference errors", () => {
  it("(g) dangling part.deformer throws", () => {
    const input = {
      ...validModel(),
      parts: [{ ...validModel().parts[0], deformer: "ghost" }],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.deformer "ghost" is not a declared deformer/,
    );
  });

  it("(h) deformer binding referencing unknown parameter throws", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("d0", {
          bindings: [
            { parameter: "NoSuchParam", channel: "rotate", from: 0, to: 1 },
          ],
        }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /"NoSuchParam" is not a declared parameter/,
    );
  });
});

describe("deformers — opacity rejection", () => {
  it("(i) deformer with transform.opacity throws", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("d0", { transform: { x: 0, y: 0, opacity: 0.5 } }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.transform\.opacity is not supported on a deformer \(matrix-only\)/,
    );
  });

  it("(j) deformer binding with channel 'opacity' throws", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("d0", {
          bindings: [
            { parameter: "ParamA", channel: "opacity", from: 0, to: 1 },
          ],
        }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.bindings\[0\]\.channel "opacity" is not supported on a deformer/,
    );
  });
});

describe("non-finite number rejection", () => {
  it("rejects Infinity in deformer pivot.x", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("d0", { pivot: { x: Infinity, y: 0 } })],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.pivot\.x must be a finite number/,
    );
  });

  it("rejects -Infinity in deformer pivot.y", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("d0", { pivot: { x: 0, y: -Infinity } })],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.pivot\.y must be a finite number/,
    );
  });

  it("rejects Infinity in deformer transform field", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("d0", { transform: { x: Infinity, y: 0 } })],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.transform\.x must be a finite number/,
    );
  });

  it("rejects Infinity in deformer binding from", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("d0", {
          bindings: [
            { parameter: "ParamA", channel: "rotate", from: Infinity, to: 1 },
          ],
        }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.bindings\[0\]\.from must be a finite number/,
    );
  });

  it("rejects Infinity in deformer binding to", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("d0", {
          bindings: [
            { parameter: "ParamA", channel: "rotate", from: 0, to: Infinity },
          ],
        }),
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /deformers\[0\]\.bindings\[0\]\.to must be a finite number/,
    );
  });

  it("rejects Infinity in part transform field", () => {
    const input = validModel();
    input.parts[0].transform = { x: Infinity, y: 0 } as never;
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.transform\.x must be a finite number/,
    );
  });

  it("rejects Infinity in part binding from", () => {
    const input = validModel();
    (input.parts[0].bindings[0] as Record<string, unknown>).from = Infinity;
    expect(() => parseIkiModel(input)).toThrow(
      /parts\[0\]\.bindings\[0\]\.from must be a finite number/,
    );
  });
});

// ── Mesh + warp tests ─────────────────────────────────────────────────────────

/** A valid 4-vertex (2×2 grid split into 2 triangles) mesh. */
function validMesh() {
  return {
    // 4 vertices => 8 components: bottom-left, bottom-right, top-right, top-left
    vertices: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

/** A model with a part that has a valid mesh and a 2-keyform warp. */
function modelWithMesh() {
  return {
    ...validModel(),
    parts: [
      {
        ...validModel().parts[0],
        mesh: validMesh(),
        warps: [
          {
            parameter: "ParamA",
            keyforms: [
              { value: -1, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
              { value: 1, offsets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
            ],
          },
        ],
      },
    ],
  };
}

describe("mesh + warp", () => {
  it("(a) happy path — part with valid mesh and 2-keyform warp parses and round-trips", () => {
    const model = parseIkiModel(modelWithMesh());
    const part = model.parts[0];
    expect(part.mesh).toBeDefined();
    expect(part.mesh!.vertices).toEqual([
      -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
    ]);
    expect(part.mesh!.uvs).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(part.mesh!.indices).toEqual([0, 1, 2, 0, 2, 3]);
    expect(part.warps).toHaveLength(1);
    expect(part.warps![0].parameter).toBe("ParamA");
    expect(part.warps![0].keyforms).toHaveLength(2);
    expect(part.warps![0].keyforms[0].value).toBe(-1);
    expect(part.warps![0].keyforms[1].offsets).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
    ]);
  });

  it("(b) back-compat — mesh-less part still validates and mesh/warps are undefined", () => {
    const model = parseIkiModel(validModel());
    expect(model.parts[0].mesh).toBeUndefined();
    expect(model.parts[0].warps).toBeUndefined();
  });

  it("(c) uvs length !== vertices length throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), uvs: [0, 1, 1, 1] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /uvs length must equal vertices length/,
    );
  });

  it("(c2) uvs entry outside 0..1 throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), uvs: [0, 1, 1, 1, 1, 0, 0, 1.5] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /uvs\[7\] must be a number in 0\.\.1/,
    );
  });

  it("(d) odd vertices length throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), vertices: [-0.5, -0.5, 0.5, -0.5, 0.5] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /vertices must have an even length \(x,y pairs\)/,
    );
  });

  it("(e) indices length not a positive multiple of 3 throws", () => {
    const notMultiple = {
      ...validModel(),
      parts: [
        { ...validModel().parts[0], mesh: { ...validMesh(), indices: [0, 1] } },
      ],
    };
    expect(() => parseIkiModel(notMultiple)).toThrow(
      /indices length must be a positive multiple of 3/,
    );

    const empty = {
      ...validModel(),
      parts: [
        { ...validModel().parts[0], mesh: { ...validMesh(), indices: [] } },
      ],
    };
    expect(() => parseIkiModel(empty)).toThrow(
      /indices length must be a positive multiple of 3/,
    );
  });

  it("(f) out-of-range index throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), indices: [0, 1, 99] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /indices\[2\] 99 is out of range/,
    );
  });

  it("(f2) vertexCount > 65536 throws exceeds the 65536-vertex limit", () => {
    const bigVertexCount = 65537;
    const vertices = Array.from({ length: bigVertexCount * 2 }, (_, i) =>
      i % 2 === 0 ? i * 0.000001 : 0,
    );
    const uvs = Array.from({ length: bigVertexCount * 2 }, () => 0);
    const indices = [0, 1, 2];
    const input = {
      ...validModel(),
      parts: [{ ...validModel().parts[0], mesh: { vertices, uvs, indices } }],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /vertices exceeds the 65536-vertex limit/,
    );
  });

  it("(g) keyform offsets length !== vertices length throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: 0, offsets: [0, 0] }, // wrong length (should be 8)
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /offsets length must equal mesh vertices length/,
    );
  });

  it("(h) empty keyforms array throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [{ parameter: "ParamA", keyforms: [] }],
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /keyforms must be a non-empty array/,
    );
  });

  it("(i) descending/equal keyform value throws sorted ascending", () => {
    const descending = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: 1, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
                { value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(descending)).toThrow(
      /keyforms must be sorted ascending by value/,
    );

    const equal = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
                { value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(equal)).toThrow(
      /keyforms must be sorted ascending by value/,
    );
  });

  it("(j) warps without mesh throws requires a mesh", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          warps: [
            {
              parameter: "ParamA",
              keyforms: [{ value: 0, offsets: [] }],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/warps requires a mesh/);
  });

  it("(k) warp.parameter not declared throws is not a declared parameter", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "NoSuchParam",
              keyforms: [{ value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] }],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /"NoSuchParam" is not a declared parameter/,
    );
  });

  it("(l) non-finite number in vertices throws finite-number message", () => {
    const badVertices = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: {
            ...validMesh(),
            vertices: [-0.5, -0.5, 0.5, NaN, 0.5, 0.5, -0.5, 0.5],
          },
        },
      ],
    };
    expect(() => parseIkiModel(badVertices)).toThrow(/must be a finite number/);

    const badUvs = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), uvs: [0, 1, 1, Infinity, 1, 0, 0, 0] },
        },
      ],
    };
    expect(() => parseIkiModel(badUvs)).toThrow(/must be a finite number/);

    const badOffsets = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [{ value: 0, offsets: [0, 0, 0, NaN, 0, 0, 0, 0] }],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(badOffsets)).toThrow(/must be a finite number/);
  });

  it("(f3) non-integer (float) index is rejected", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: { ...validMesh(), indices: [0, 1.5, 2] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/is out of range/);
  });

  it("(warps-non-array) warps that is not an array throws", () => {
    const input = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: 42,
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/warps must be an array/);
  });

  it("(m) keyform value outside parameter range throws outside parameter range", () => {
    // ParamA is declared min:-1, max:1. A keyform value of 100 is out of range.
    const outOfRange = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
                {
                  value: 100,
                  offsets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(outOfRange)).toThrow(
      /outside parameter .* range/,
    );
  });

  it("(m2) keyform values within parameter range still pass validation", () => {
    const inRange = {
      ...validModel(),
      parts: [
        {
          ...validModel().parts[0],
          mesh: validMesh(),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: [0, 0, 0, 0, 0, 0, 0, 0] },
                { value: 1, offsets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseIkiModel(inRange)).not.toThrow();
  });
});

// ── Warp deformer tests ────────────────────────────────────────────────────────

/**
 * Builds a minimal valid warp deformer. cols=2, rows=1 → 3*2=6 points.
 * Grid: row 0 (top, y=10): x=-10,-0,10; row 1 (bottom, y=-10): x=-10,0,10.
 * Points flat: [-10,10, 0,10, 10,10, -10,-10, 0,-10, 10,-10]
 */
function makeWarpDeformer(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const pts = [-10, 10, 0, 10, 10, 10, -10, -10, 0, -10, 10, -10];
  return {
    kind: "warp",
    id,
    grid: { cols: 2, rows: 1, points: pts },
    ...overrides,
  };
}

/** A valid 3-vertex mesh for warp-child tests. */
function warpChildMesh() {
  return {
    vertices: [0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
}

/** A model with a single warp deformer and a mesh part referencing it. */
function modelWithWarpDeformer() {
  return {
    ...validModel(),
    deformers: [makeWarpDeformer("faceWarp")],
    parts: [
      {
        ...validModel().parts[0],
        deformer: "faceWarp",
        mesh: warpChildMesh(),
      },
    ],
  };
}

describe("warp deformers — happy path", () => {
  it("(a) valid warp deformer with a mesh child parses and returns correct structure", () => {
    const model = parseIkiModel(modelWithWarpDeformer());
    expect(model.deformers).toHaveLength(1);
    const wd = model.deformers![0];
    expect(wd.kind).toBe("warp");
    expect(wd.id).toBe("faceWarp");
    if (wd.kind === "warp") {
      expect(wd.grid.cols).toBe(2);
      expect(wd.grid.rows).toBe(1);
      expect(wd.grid.points).toHaveLength(12);
    }
    expect(model.parts[0].mesh).toBeDefined();
    expect(model.parts[0].deformer).toBe("faceWarp");
  });

  it("(b) warp deformer with optional warps array parses", () => {
    const input = {
      ...modelWithWarpDeformer(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: Array(12).fill(0) },
                { value: 1, offsets: Array(12).fill(0.5) },
              ],
            },
          ],
        },
      ],
    };
    const model = parseIkiModel(input);
    const wd = model.deformers![0];
    if (wd.kind === "warp") {
      expect(wd.warps).toHaveLength(1);
      expect(wd.warps![0].parameter).toBe("ParamA");
      expect(wd.warps![0].keyforms).toHaveLength(2);
    }
  });

  it("(c) omitted kind parses as matrix (back-compat)", () => {
    const input = {
      ...validModel(),
      deformers: [makeDeformer("head")],
    };
    const model = parseIkiModel(input);
    expect(model.deformers).toHaveLength(1);
    // kind is undefined for matrix deformers (omitted)
    expect(model.deformers![0].kind).toBeUndefined();
  });

  it("(d) matrix deformer parented to matrix parses (existing hierarchy)", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("root"),
        makeDeformer("child", { parent: "root" }),
      ],
    };
    const model = parseIkiModel(input);
    expect(model.deformers).toHaveLength(2);
    expect(model.deformers![1].parent).toBe("root");
  });

  it("(e) warp deformer parented to a matrix deformer is valid", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("headDeformer"),
        makeWarpDeformer("faceWarp", { parent: "headDeformer" }),
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    const model = parseIkiModel(input);
    expect(model.deformers![1].parent).toBe("headDeformer");
  });
});

describe("warp deformers — kind dispatch errors", () => {
  it("(a) unknown kind throws /is not a known deformer kind/", () => {
    const input = {
      ...validModel(),
      deformers: [{ kind: "bend", id: "d0", pivot: { x: 0, y: 0 } }],
    };
    expect(() => parseIkiModel(input)).toThrow(/is not a known deformer kind/);
  });

  it("(b) explicit kind:'matrix' is treated as matrix deformer", () => {
    const input = {
      ...validModel(),
      deformers: [{ kind: "matrix", id: "d0", pivot: { x: 0, y: 0 } }],
    };
    const model = parseIkiModel(input);
    expect(model.deformers![0].kind).toBe(undefined); // parseDeformer doesn't write kind back
    // Actually the type is IkiMatrixDeformer with kind?:"matrix" but parseDeformer
    // returns {id, parent, pivot, transform, bindings} without explicitly setting kind.
    // The important thing is it didn't throw.
    expect(model.deformers![0].id).toBe("d0");
  });
});

describe("warp deformers — grid validation errors", () => {
  it("(a) grid.points length mismatch throws /grid\\.points length .* must equal/", () => {
    const input = {
      ...modelWithWarpDeformer(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: 2, points: [0, 0, 1, 0, 2, 0] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /grid\.points length .* must equal/,
    );
  });

  it("(b) cols not a positive integer throws /must be a positive integer/", () => {
    const input = {
      ...modelWithWarpDeformer(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 0, rows: 1, points: [] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/must be a positive integer/);
  });

  it("(b2) rows not a positive integer throws /must be a positive integer/", () => {
    const input = {
      ...modelWithWarpDeformer(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: -1, points: [] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/must be a positive integer/);
  });

  it("(b3) cols as float throws /must be a positive integer/", () => {
    const input = {
      ...modelWithWarpDeformer(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 1.5, rows: 1, points: [] },
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/must be a positive integer/);
  });

  it("(c) irregular grid — point nudged off its row/col throws /must be a regular axis-aligned grid/", () => {
    // 2x1 grid but nudge point [1] off its row-0 y slightly
    const pts = [-10, 10, 0, 9, 10, 10, -10, -10, 0, -10, 10, -10];
    const input = {
      ...validModel(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: 1, points: pts },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /must be a regular axis-aligned grid/,
    );
  });

  it("(d) reversed x (column 0 rightmost) throws /must be a regular axis-aligned grid/", () => {
    // x DECREASES by column: col0=10, col1=0, col2=-10
    const pts = [10, 10, 0, 10, -10, 10, 10, -10, 0, -10, -10, -10];
    const input = {
      ...validModel(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: 1, points: pts },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /must be a regular axis-aligned grid/,
    );
  });

  it("(e) reversed y (row 0 at bottom, y increasing by row) throws /must be a regular axis-aligned grid/", () => {
    // y INCREASES by row: row0=-10 (bottom), row1=10 (top)
    const pts = [-10, -10, 0, -10, 10, -10, -10, 10, 0, 10, 10, 10];
    const input = {
      ...validModel(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: 1, points: pts },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /must be a regular axis-aligned grid/,
    );
  });

  it("(f) zero-width column (duplicate x) throws /must be a regular axis-aligned grid/", () => {
    // col0 and col1 have same x=0 → no strictly increasing
    const pts = [0, 10, 0, 10, 10, 10, 0, -10, 0, -10, 10, -10];
    const input = {
      ...validModel(),
      deformers: [
        {
          kind: "warp",
          id: "faceWarp",
          grid: { cols: 2, rows: 1, points: pts },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /must be a regular axis-aligned grid/,
    );
  });
});

describe("warp deformers — grid warp keyform errors", () => {
  function modelWithWarpAndKeyform(keyformOverride: Record<string, unknown>) {
    return {
      ...validModel(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [keyformOverride],
            },
          ],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
  }

  it("(a) grid keyform offsets length mismatch throws /offsets length must equal grid\\.points length/", () => {
    const input = modelWithWarpAndKeyform({ value: 0, offsets: [0, 0] }); // grid has 12 components
    expect(() => parseIkiModel(input)).toThrow(
      /offsets length must equal grid\.points length/,
    );
  });

  it("(b) grid keyform value outside parameter range throws /outside parameter .* range/", () => {
    // ParamA is min:-1, max:1; value of 5 is out of range
    const input = modelWithWarpAndKeyform({
      value: 5,
      offsets: Array(12).fill(0),
    });
    expect(() => parseIkiModel(input)).toThrow(/outside parameter .* range/);
  });

  it("(c) grid keyform values not ascending throws /keyforms must be sorted ascending/", () => {
    const input = {
      ...validModel(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: 1, offsets: Array(12).fill(0) },
                { value: -1, offsets: Array(12).fill(0) },
              ],
            },
          ],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /keyforms must be sorted ascending/,
    );
  });

  it("(d) more than one grid warp throws /at most one grid warp/", () => {
    const oneWarp = {
      parameter: "ParamA",
      keyforms: [{ value: 0, offsets: Array(12).fill(0) }],
    };
    const input = {
      ...validModel(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [oneWarp, oneWarp],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/at most one grid warp/);
  });
});

describe("warp deformers — mesh-required cross-check", () => {
  it("(a) warp-deformer child without mesh throws /is a warp deformer and requires .*\\.mesh/", () => {
    const input = {
      ...validModel(),
      deformers: [makeWarpDeformer("faceWarp")],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          // no mesh!
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /is a warp deformer and requires .*\.mesh/,
    );
  });

  it("(b) warp-deformer child with mesh does not throw", () => {
    expect(() => parseIkiModel(modelWithWarpDeformer())).not.toThrow();
  });
});

describe("warp deformers — kind-aware parent restrictions", () => {
  it("(a) warp deformer parented to a warp deformer throws /must be a matrix deformer/", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeWarpDeformer("warp1"),
        makeWarpDeformer("warp2", { parent: "warp1" }),
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "warp2",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/must be a matrix deformer/);
  });

  it("(b) matrix deformer parented to a warp deformer throws /matrix deformers cannot be children of a warp deformer/", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeWarpDeformer("faceWarp"),
        makeDeformer("jaw", { parent: "faceWarp" }),
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /matrix deformers cannot be children of a warp deformer/,
    );
  });
});

describe("warp deformers — cycle and dangling parent with warp deformer present", () => {
  it("(a) dangling parent on a warp deformer throws /is not a declared deformer/", () => {
    const input = {
      ...validModel(),
      deformers: [makeWarpDeformer("faceWarp", { parent: "nonexistent" })],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(/is not a declared deformer/);
  });

  it("(b) cycle involving a warp deformer throws /deformers contain a cycle/", () => {
    const input = {
      ...validModel(),
      deformers: [
        makeDeformer("matA", { parent: "faceWarp" }),
        makeWarpDeformer("faceWarp", { parent: "matA" }),
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    // Note: the cycle check fires, but kind-aware check might also fire first.
    // Either cycle or kind error is acceptable; the cycle path is:
    // matA -> faceWarp -> matA which creates a cycle detected by topoWalk.
    // But the kind-aware check: faceWarp (warp) parented to matA (matrix) = ok,
    // matA (matrix) parented to faceWarp (warp) = forbidden by kind check.
    // Kind check runs after dangling/self check but before cycle detection? Let's check.
    // Actually looking at code: kind check runs AFTER cycle detection.
    // So cycle detection fires first.
    expect(() => parseIkiModel(input)).toThrow(
      /deformers contain a cycle|matrix deformers cannot be children of a warp deformer/,
    );
  });
});

// ── 2D warp deformer tests ─────────────────────────────────────────────────────

/**
 * A model with two declared parameters and a warp deformer that carries a
 * 3×3 warp2d (valuesX: 3 stops, valuesY: 3 stops → 9 keyforms).
 *
 * makeWarpDeformer uses cols:2, rows:1 → (2+1)*(1+1)=6 points → 12 components.
 * Each IkiGrid2DKeyform.offsets must be length 12.
 */
function modelWith2DWarp(warp2dOverride?: Record<string, unknown>) {
  const offsets12 = Array(12).fill(0);
  const defaultWarp2d = {
    parameter: "ParamX",
    parameterY: "ParamY",
    valuesX: [-1, 0, 1],
    valuesY: [-1, 0, 1],
    // 3*3 = 9 keyforms
    keyforms2d: Array(9)
      .fill(null)
      .map(() => ({ offsets: [...offsets12] })),
  };
  return {
    ...validModel(),
    parameters: [
      { id: "ParamA", name: "A", min: -1, max: 1, default: 0 },
      { id: "ParamX", min: -1, max: 1, default: 0 },
      { id: "ParamY", min: -1, max: 1, default: 0 },
    ],
    parts: [
      {
        ...validModel().parts[0],
        bindings: [
          { parameter: "ParamA", channel: "translateX", from: 0, to: 5 },
        ],
        deformer: "faceWarp",
        mesh: warpChildMesh(),
      },
    ],
    deformers: [
      {
        ...makeWarpDeformer("faceWarp"),
        warp2d: warp2dOverride ?? defaultWarp2d,
      },
    ],
  };
}

describe("warp deformers — 2D warp (warp2d) happy path", () => {
  it("(a) 3×3 warp2d round-trips: valuesX, valuesY, keyforms2d are preserved", () => {
    const input = modelWith2DWarp();
    const model = parseIkiModel(structuredClone(input));
    const wd = model.deformers![0];
    expect(wd.kind).toBe("warp");
    if (wd.kind === "warp") {
      expect(wd.warp2d).toBeDefined();
      const w = wd.warp2d!;
      expect(w.parameter).toBe("ParamX");
      expect(w.parameterY).toBe("ParamY");
      expect(w.valuesX).toEqual([-1, 0, 1]);
      expect(w.valuesY).toEqual([-1, 0, 1]);
      expect(w.keyforms2d).toHaveLength(9);
      for (const kf of w.keyforms2d) {
        expect(kf.offsets).toHaveLength(12);
      }
      // row-major order: cell (i=1, j=2) is at index j*valuesX.length + i = 2*3+1 = 7
      expect(w.keyforms2d[7].offsets).toEqual(Array(12).fill(0));
    }
  });

  it("(b) asymmetric 2×3 warp2d (valuesX:2, valuesY:3 → 6 keyforms) parses", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [-1, 0, 1],
      keyforms2d: Array(6)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    const model = parseIkiModel(structuredClone(input));
    const wd = model.deformers![0];
    if (wd.kind === "warp") {
      expect(wd.warp2d!.keyforms2d).toHaveLength(6);
      expect(wd.warp2d!.valuesX).toEqual([-1, 1]);
      expect(wd.warp2d!.valuesY).toEqual([-1, 0, 1]);
    }
  });

  it("(c) 1D back-compat: model with warps (no warp2d) still parses unchanged", () => {
    const input = {
      ...validModel(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: Array(12).fill(0) },
                { value: 1, offsets: Array(12).fill(0.5) },
              ],
            },
          ],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };
    const model = parseIkiModel(structuredClone(input));
    const wd = model.deformers![0];
    if (wd.kind === "warp") {
      expect(wd.warps).toHaveLength(1);
      expect(wd.warps![0].parameter).toBe("ParamA");
      expect(wd.warp2d).toBeUndefined();
    }
  });
});

describe("warp deformers — 2D warp (warp2d) error paths", () => {
  it("(a) both non-empty warps and warp2d present throws XOR error", () => {
    const validWarp2d = {
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [-1, 1],
      keyforms2d: [
        { offsets: Array(12).fill(0) },
        { offsets: Array(12).fill(0) },
        { offsets: Array(12).fill(0) },
        { offsets: Array(12).fill(0) },
      ],
    };
    const input = {
      ...modelWith2DWarp(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [{ parameter: "ParamA", keyforms: [] }], // non-empty — must trigger XOR
          warp2d: validWarp2d,
        },
      ],
    };
    expect(() => parseIkiModel(input)).toThrow(
      /declares only one of warps \(1D\) or warp2d \(2D\), not both/,
    );
  });

  it("(a2) empty warps array with warp2d does NOT throw — empty warps is treated as absent", () => {
    const input = {
      ...modelWith2DWarp(),
      deformers: [
        {
          ...makeWarpDeformer("faceWarp"),
          warps: [], // inert empty array — must NOT trigger XOR error
          warp2d: {
            parameter: "ParamX",
            parameterY: "ParamY",
            valuesX: [-1, 1],
            valuesY: [-1, 1],
            keyforms2d: [
              { offsets: Array(12).fill(0) },
              { offsets: Array(12).fill(0) },
              { offsets: Array(12).fill(0) },
              { offsets: Array(12).fill(0) },
            ],
          },
        },
      ],
    };
    const model = parseIkiModel(input);
    const wd = model.deformers!.find((d) => d.id === "faceWarp") as {
      warp2d?: unknown;
      warps?: unknown[];
    };
    expect(wd.warp2d).toBeDefined();
    // empty warps is normalized to absent so the output satisfies the XOR contract
    expect(wd.warps).toBeUndefined();
  });

  it("(b) keyforms2d.length !== valuesX.length * valuesY.length throws with actual + expected", () => {
    const offsets12 = Array(12).fill(0);
    // valuesX:3, valuesY:3 → expect 9; supply 4
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 0, 1],
      valuesY: [-1, 0, 1],
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /keyforms2d length 4 must equal valuesX\.length \* valuesY\.length = 9/,
    );
  });

  it("(c) offset length mismatch in keyforms2d throws /offsets length must equal grid\.points length/", () => {
    // grid has 12 components; supply 6 in a keyform
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [-1, 1],
      keyforms2d: [
        { offsets: Array(12).fill(0) },
        { offsets: Array(12).fill(0) },
        { offsets: Array(12).fill(0) },
        { offsets: Array(6).fill(0) }, // wrong length at index 3
      ],
    });
    expect(() => parseIkiModel(input)).toThrow(
      /keyforms2d\[3\]\.offsets length must equal grid\.points length/,
    );
  });

  it("(d) valuesX with only one entry throws axis length error", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [0],
      valuesY: [-1, 1],
      keyforms2d: [{ offsets: [...offsets12] }, { offsets: [...offsets12] }],
    });
    expect(() => parseIkiModel(input)).toThrow(
      /valuesX must have at least 2 entries/,
    );
  });

  it("(e) valuesY with only one entry throws axis length error", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [0],
      keyforms2d: [{ offsets: [...offsets12] }, { offsets: [...offsets12] }],
    });
    expect(() => parseIkiModel(input)).toThrow(
      /valuesY must have at least 2 entries/,
    );
  });

  it("(f) non-ascending valuesX throws /valuesX must be strictly ascending/", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [1, -1], // descending
      valuesY: [-1, 1],
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /valuesX must be strictly ascending/,
    );
  });

  it("(g) non-ascending valuesY throws /valuesY must be strictly ascending/", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [0, 0], // equal (not strictly ascending)
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /valuesY must be strictly ascending/,
    );
  });

  it("(h) valuesY entry outside parameterY range throws out-of-range message", () => {
    // ParamY has min:-1, max:1; supply a valuesY entry of 2.0
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [-1, 2.0], // 2.0 out of range
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /valuesY\[1\] 2 is outside parameter "ParamY" range/,
    );
  });

  it("(i) undeclared parameterY throws /is not a declared parameter/", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "NoSuchParam",
      valuesX: [-1, 1],
      valuesY: [-1, 1],
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /"NoSuchParam" is not a declared parameter/,
    );
  });

  it("(j) parameter === parameterY throws same-axis error", () => {
    const offsets12 = Array(12).fill(0);
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamX", // same!
      valuesX: [-1, 1],
      valuesY: [-1, 1],
      keyforms2d: Array(4)
        .fill(null)
        .map(() => ({ offsets: [...offsets12] })),
    });
    expect(() => parseIkiModel(input)).toThrow(
      /parameter and .*parameterY must be different/,
    );
  });

  it("(k) missing any required field (e.g. no keyforms2d) throws incomplete shape error", () => {
    const input = modelWith2DWarp({
      parameter: "ParamX",
      parameterY: "ParamY",
      valuesX: [-1, 1],
      valuesY: [-1, 1],
      // keyforms2d intentionally omitted
    });
    expect(() => parseIkiModel(input)).toThrow(
      /must declare parameter, parameterY, valuesX, valuesY, and keyforms2d/,
    );
  });
});

describe("parseIkiModel — clip masks", () => {
  const tri = () => ({
    vertices: [0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  });
  const meshPart = (id: string, order: number, extra: object = {}) => ({
    id,
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    order,
    transform: { x: 0, y: 0 },
    mesh: tri(),
    ...extra,
  });

  /** A mask part `eyeWhite` (mesh) and a consumer `iris` carrying `clip`. */
  function clipModel(clip: unknown, maskExtra: object = {}) {
    return {
      version: IKI_FORMAT_VERSION,
      name: "clip",
      canvas: { width: 100, height: 100 },
      parameters: [],
      parts: [
        meshPart("eyeWhite", 0, maskExtra),
        meshPart("iris", 1, { clip }),
      ],
    };
  }

  it("accepts a consumer clipped by a mesh mask", () => {
    const model = parseIkiModel(clipModel({ masks: ["eyeWhite"] }));
    expect(model.parts[1].clip).toEqual({ masks: ["eyeWhite"] });
  });

  it("rejects an unknown mask reference", () => {
    expect(() => parseIkiModel(clipModel({ masks: ["nope"] }))).toThrow(
      /parts\[1\]\.clip\.masks\[0\] "nope" is not a declared part/,
    );
  });

  it("rejects self-clip", () => {
    expect(() => parseIkiModel(clipModel({ masks: ["iris"] }))).toThrow(
      /cannot clip itself/,
    );
  });

  it("rejects a duplicate mask reference", () => {
    expect(() =>
      parseIkiModel(clipModel({ masks: ["eyeWhite", "eyeWhite"] })),
    ).toThrow(/duplicate mask reference/);
  });

  it("rejects a non-mesh mask", () => {
    const m = clipModel({ masks: ["eyeWhite"] });
    delete (m.parts[0] as Record<string, unknown>).mesh;
    expect(() => parseIkiModel(m)).toThrow(/must reference a part with a mesh/);
  });

  it("rejects a consumer clipped by a mask that is itself clipped (flat only)", () => {
    const m = {
      version: IKI_FORMAT_VERSION,
      name: "nested",
      canvas: { width: 100, height: 100 },
      parameters: [],
      parts: [
        meshPart("base", 0),
        meshPart("eyeWhite", 1, { clip: { masks: ["base"] } }),
        meshPart("iris", 2, { clip: { masks: ["eyeWhite"] } }),
      ],
    };
    expect(() => parseIkiModel(m)).toThrow(
      /parts\[2\]\.clip\.masks\[0\] "eyeWhite" is itself clipped; nested masks are not supported/,
    );
  });

  it("rejects an empty masks array", () => {
    expect(() => parseIkiModel(clipModel({ masks: [] }))).toThrow(
      /clip\.masks must not be empty/,
    );
  });

  it("rejects a non-array masks", () => {
    expect(() => parseIkiModel(clipModel({ masks: "eyeWhite" }))).toThrow(
      /clip\.masks must be an array/,
    );
  });

  it("rejects a non-object clip", () => {
    expect(() => parseIkiModel(clipModel("eyeWhite"))).toThrow(
      /\.clip must be an object/,
    );
  });

  it("rejects duplicate part ids (clip refs must resolve unambiguously)", () => {
    const m = clipModel({ masks: ["eyeWhite"] });
    (m.parts[1] as Record<string, unknown>).id = "eyeWhite";
    expect(() => parseIkiModel(m)).toThrow(
      /parts\[1\]\.id "eyeWhite" collides with parts\[0\]\.id/,
    );
  });
});
