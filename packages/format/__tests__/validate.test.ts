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
    expect(() => parseIkiModel(input)).toThrow(/version must be a number/);
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
    expect(() => parseIkiModel(input)).toThrow(/canvas.width must be a number/);
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
      /parameters\[0\].min must be a number/,
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
      /bindings\[0\].from must be a number/,
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
    expect(() => parseIkiModel(input)).toThrow(/order must be a number/);
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
