import { describe, expect, it } from "vitest";
import {
  IKI_FORMAT_VERSION,
  IkiFormatError,
  parseIkiModel,
  StandardParameter,
} from "@ikijs/format";

/** The ids the procedural idle keeps under a declared Idle group. */
const BLINK_AND_BREATH = [
  StandardParameter.EyeOpenLeft,
  StandardParameter.EyeOpenRight,
  StandardParameter.Breath,
];

function model(expressions?: unknown) {
  const m: Record<string, unknown> = {
    version: IKI_FORMAT_VERSION,
    name: "test",
    canvas: { width: 100, height: 100 },
    parameters: [
      { id: "ParamA", name: "A", min: -1, max: 1, default: 0 },
      { id: "ParamMouthOpenY", name: "Mouth", min: 0, max: 1, default: 0 },
      ...BLINK_AND_BREATH.map((id) => ({
        id,
        name: id,
        min: 0,
        max: 1,
        default: 1,
      })),
    ],
    parts: [],
  };
  if (expressions !== undefined) m.expressions = expressions;
  return m;
}

function expr(over: Record<string, unknown> = {}) {
  return {
    id: "smile",
    description: "a smile",
    parameters: [{ parameter: "ParamA", value: 0.5 }],
    ...over,
  };
}

function rejects(expressions: unknown, message: string) {
  let error: unknown;
  try {
    parseIkiModel(model(expressions));
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(IkiFormatError);
  expect((error as Error).message).toBe(message);
}

describe("expressions — accepted", () => {
  it("round-trips a full expression", () => {
    const e = expr({
      fadeIn: 0.2,
      fadeOut: 0.4,
      parameters: [{ parameter: "ParamA", value: 0.5, blend: "multiply" }],
    });
    expect(parseIkiModel(model([e])).expressions).toEqual([e]);
  });

  it("keeps absent fadeIn, fadeOut and blend absent", () => {
    const parsed = parseIkiModel(model([expr()])).expressions![0];
    expect("fadeIn" in parsed).toBe(false);
    expect("fadeOut" in parsed).toBe(false);
    expect("blend" in parsed.parameters[0]).toBe(false);
  });

  it("accepts ParamMouthOpenY", () => {
    const e = expr({
      parameters: [{ parameter: "ParamMouthOpenY", value: 1 }],
    });
    expect(parseIkiModel(model([e])).expressions).toEqual([e]);
  });

  it("keeps a padded description as given", () => {
    const e = expr({ description: "  a smile\n" });
    expect(parseIkiModel(model([e])).expressions).toEqual([e]);
  });

  it("accepts an empty list", () => {
    expect(parseIkiModel(model([])).expressions).toEqual([]);
  });

  it("adds no expressions key when absent", () => {
    expect("expressions" in parseIkiModel(model())).toBe(false);
  });
});

describe("expressions — rejected", () => {
  it("not an array", () => {
    rejects({}, "expressions must be an array");
  });
  it("entry not an object", () => {
    rejects([1], "expressions[0] must be an object");
  });
  it("missing description", () => {
    rejects(
      [expr({ description: undefined })],
      "expressions[0].description must be a non-empty string",
    );
  });
  it("empty description", () => {
    rejects(
      [expr({ description: "" })],
      "expressions[0].description must be a non-empty string",
    );
  });
  it("whitespace-only description", () => {
    rejects(
      [expr({ description: " \t\n" })],
      "expressions[0].description must contain a non-whitespace character",
    );
  });
  it("empty id", () => {
    rejects([expr({ id: "" })], "expressions[0].id must be a non-empty string");
  });
  it("unknown parameter", () => {
    rejects(
      [expr({ parameters: [{ parameter: "Nope", value: 1 }] })],
      'expressions[0].parameters[0].parameter "Nope" is not a declared parameter',
    );
  });
  it("Infinity value", () => {
    rejects(
      [expr({ parameters: [{ parameter: "ParamA", value: Infinity }] })],
      "expressions[0].parameters[0].value must be a finite number",
    );
  });
  it("bad blend", () => {
    rejects(
      [
        expr(),
        expr({
          id: "b",
          parameters: [{ parameter: "ParamA", value: 1, blend: "mix" }],
        }),
      ],
      "expressions[1].parameters[0].blend must be one of add, multiply, overwrite",
    );
  });
  it("negative fadeOut", () => {
    rejects([expr({ fadeOut: -1 })], "expressions[0].fadeOut must be >= 0");
  });
  it("non-finite fadeIn", () => {
    rejects(
      [expr({ fadeIn: Infinity })],
      "expressions[0].fadeIn must be a finite number",
    );
  });
  it("empty parameters", () => {
    rejects(
      [expr({ parameters: [] })],
      "expressions[0].parameters must be a non-empty array",
    );
  });
  it("duplicate id", () => {
    rejects(
      [expr(), expr()],
      'expressions[1].id "smile" duplicates an earlier expression id',
    );
  });
  it("duplicate parameter", () => {
    rejects(
      [
        expr({
          parameters: [
            { parameter: "ParamA", value: 1 },
            { parameter: "ParamA", value: 2 },
          ],
        }),
      ],
      'expressions[0].parameters[1].parameter "ParamA" duplicates an earlier parameter in this expression',
    );
  });
});

function motionModel(motions: unknown) {
  return { ...model(), motions };
}

function clip(over: Record<string, unknown> = {}) {
  return {
    description: "a nod",
    duration: 2,
    curves: [{ parameter: "ParamA", keys: [[0, 0]] }],
    ...over,
  };
}

function rejectsMotions(motions: unknown, message: string) {
  let error: unknown;
  try {
    parseIkiModel(motionModel(motions));
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(IkiFormatError);
  expect((error as Error).message).toBe(message);
}

describe("motions — accepted", () => {
  it("round-trips several groups including Idle", () => {
    const motions = {
      Idle: [
        clip({
          fadeIn: 0.5,
          fadeOut: 0.5,
          curves: [
            {
              parameter: "ParamA",
              keys: [
                [0, 0],
                [1, 1],
                [2, 0],
              ],
            },
            { parameter: "ParamMouthOpenY", keys: [[2, 0.3]] },
          ],
        }),
      ],
      Nod: [clip(), clip({ description: "again", duration: 1 })],
    };
    expect(parseIkiModel(motionModel(motions)).motions).toEqual(motions);
  });

  it("accepts fades equal to duration and overlapping fades", () => {
    const motions = { A: [clip({ fadeIn: 2, fadeOut: 2 })] };
    expect(parseIkiModel(motionModel(motions)).motions).toEqual(motions);
  });

  it("keeps absent fades and interpolation absent", () => {
    const parsed = parseIkiModel(motionModel({ A: [clip()] })).motions!.A[0];
    expect("fadeIn" in parsed).toBe(false);
    expect("fadeOut" in parsed).toBe(false);
    expect("interpolation" in parsed.curves[0]).toBe(false);
  });

  it.each(["linear", "smooth"])("round-trips interpolation %s", (mode) => {
    const motions = {
      A: [
        clip({
          curves: [
            {
              parameter: "ParamA",
              keys: [
                [0, 0],
                [2, 1],
              ],
              interpolation: mode,
            },
          ],
        }),
      ],
    };
    expect(parseIkiModel(motionModel(motions)).motions).toEqual(motions);
  });

  it("accepts blink and breath curves in a one-shot group", () => {
    const motions = {
      Wink: [
        clip({
          curves: BLINK_AND_BREATH.map((parameter) => ({
            parameter,
            keys: [
              [0, 1],
              [1, 0],
              [2, 1],
            ],
          })),
        }),
      ],
    };
    expect(parseIkiModel(motionModel(motions)).motions).toEqual(motions);
  });

  it("accepts an empty record", () => {
    expect(parseIkiModel(motionModel({})).motions).toEqual({});
  });

  it("adds no motions key when absent", () => {
    expect("motions" in parseIkiModel(model())).toBe(false);
  });

  it("keeps a __proto__ group as an own key", () => {
    const raw = JSON.parse(
      `{"__proto__": [${JSON.stringify(clip())}]}`,
    ) as unknown;
    const motions = parseIkiModel(motionModel(raw)).motions!;
    expect(Object.keys(motions)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(motions)).toBe(Object.prototype);
  });
});

describe("motions — rejected", () => {
  const key = (keys: unknown) => ({
    A: [clip({ curves: [{ parameter: "ParamA", keys }] })],
  });

  it("array instead of object", () => {
    rejectsMotions([], "motions must be an object");
  });
  it("empty group name", () => {
    rejectsMotions(
      { "": [clip()] },
      'motions[""] group name must be non-empty',
    );
  });
  it("empty group array", () => {
    rejectsMotions({ Nod: [] }, 'motions["Nod"] must be a non-empty array');
  });
  it("missing description", () => {
    rejectsMotions(
      { Nod: [clip({ description: undefined })] },
      'motions["Nod"][0].description must be a non-empty string',
    );
  });
  it("whitespace-only description", () => {
    rejectsMotions(
      { Nod: [clip({ description: "   " })] },
      'motions["Nod"][0].description must contain a non-whitespace character',
    );
  });
  it.each(BLINK_AND_BREATH)("Idle curve on %s", (parameter) => {
    rejectsMotions(
      {
        Idle: [
          clip({
            curves: [
              { parameter: "ParamA", keys: [[0, 0]] },
              { parameter, keys: [[0, 1]] },
            ],
          }),
        ],
      },
      `motions["Idle"][0].curves[1].parameter "${parameter}" stays procedural: an Idle clip may not animate blink or breath`,
    );
  });
  it("zero duration", () => {
    rejectsMotions(
      { Nod: [clip({ duration: 0 })] },
      'motions["Nod"][0].duration must be > 0',
    );
  });
  it("negative fadeIn", () => {
    rejectsMotions(
      { Nod: [clip({ fadeIn: -1 })] },
      'motions["Nod"][0].fadeIn must be >= 0',
    );
  });
  it("fadeIn beyond duration", () => {
    rejectsMotions(
      { Nod: [clip({ fadeIn: 3 })] },
      'motions["Nod"][0].fadeIn must not exceed duration',
    );
  });
  it("fadeOut beyond duration", () => {
    rejectsMotions(
      { Nod: [clip({ fadeOut: 3 })] },
      'motions["Nod"][0].fadeOut must not exceed duration',
    );
  });
  it("empty curves", () => {
    rejectsMotions(
      { Nod: [clip({ curves: [] })] },
      'motions["Nod"][0].curves must be a non-empty array',
    );
  });
  it("unknown parameter", () => {
    rejectsMotions(
      { Nod: [clip({ curves: [{ parameter: "Nope", keys: [[0, 0]] }] })] },
      'motions["Nod"][0].curves[0].parameter "Nope" is not a declared parameter',
    );
  });
  it.each([["cubic"], [""], [1], [null]])("interpolation %j", (mode) => {
    rejectsMotions(
      {
        Nod: [
          clip({
            curves: [
              { parameter: "ParamA", keys: [[0, 0]], interpolation: mode },
            ],
          }),
        ],
      },
      'motions["Nod"][0].curves[0].interpolation must be one of linear, smooth',
    );
  });
  it("duplicate curve parameter", () => {
    const c = { parameter: "ParamA", keys: [[0, 0]] };
    rejectsMotions(
      { Nod: [clip({ curves: [c, c] })] },
      'motions["Nod"][0].curves[1].parameter "ParamA" duplicates an earlier curve in this clip',
    );
  });
  it("empty keys", () => {
    rejectsMotions(
      key([]),
      'motions["A"][0].curves[0].keys must be a non-empty array',
    );
  });
  it("3-element key", () => {
    rejectsMotions(
      key([[0, 0, 0]]),
      'motions["A"][0].curves[0].keys[0] must be a [t, value] pair',
    );
  });
  it("non-finite t", () => {
    rejectsMotions(
      key([[Infinity, 0]]),
      'motions["A"][0].curves[0].keys[0][0] must be a finite number',
    );
  });
  it("equal t", () => {
    rejectsMotions(
      key([
        [1, 0],
        [1, 1],
      ]),
      'motions["A"][0].curves[0].keys[1][0] must be greater than the previous key\'s t',
    );
  });
  it("decreasing t", () => {
    rejectsMotions(
      key([
        [1, 0],
        [0.5, 1],
      ]),
      'motions["A"][0].curves[0].keys[1][0] must be greater than the previous key\'s t',
    );
  });
  it("negative t", () => {
    rejectsMotions(
      key([[-0.1, 0]]),
      'motions["A"][0].curves[0].keys[0][0] must be within [0, duration]',
    );
  });
  it("t beyond duration", () => {
    rejectsMotions(
      key([[2.1, 0]]),
      'motions["A"][0].curves[0].keys[0][0] must be within [0, duration]',
    );
  });
});
