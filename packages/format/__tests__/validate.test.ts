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
