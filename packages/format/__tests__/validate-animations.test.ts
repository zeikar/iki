import { describe, expect, it } from "vitest";
import {
  IKI_FORMAT_VERSION,
  IkiFormatError,
  parseIkiModel,
} from "@ikijs/format";

function model(expressions?: unknown) {
  const m: Record<string, unknown> = {
    version: IKI_FORMAT_VERSION,
    name: "test",
    canvas: { width: 100, height: 100 },
    parameters: [
      { id: "ParamA", name: "A", min: -1, max: 1, default: 0 },
      { id: "ParamMouthOpenY", name: "Mouth", min: 0, max: 1, default: 0 },
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
