// Validation for the animation fields of a model (expressions, motions).
// Kept apart from validate.ts: they share only the declared-parameter set.
import { StandardParameter } from "./parameters";
import {
  IDLE_MOTION_GROUP,
  type IkiExpression,
  type IkiExpressionBlend,
  type IkiExpressionParameter,
  type IkiMotionClip,
  type IkiMotionCurve,
} from "./types";
import { IkiFormatError, isObject, num, str } from "./validate-primitives";

const EXPRESSION_BLENDS: ReadonlySet<string> = new Set([
  "add",
  "multiply",
  "overwrite",
]);

// A declared Idle group replaces only the procedural head sway and gaze, and
// its loop is written after the procedural idle: an Idle curve on these would
// overwrite the blink or breath on every frame.
const IDLE_PROCEDURAL: ReadonlySet<string> = new Set([
  StandardParameter.EyeOpenLeft,
  StandardParameter.EyeOpenRight,
  StandardParameter.Breath,
]);

// A host (or an LLM) picks an entry by its description, so it needs real text.
function parseDescription(value: unknown, path: string): string {
  const description = str(value, path);
  if (description.trim() === "") {
    throw new IkiFormatError(`${path} must contain a non-whitespace character`);
  }
  return description;
}

function parseFadeSeconds(value: unknown, path: string): number {
  const seconds = num(value, path);
  if (seconds < 0) {
    throw new IkiFormatError(`${path} must be >= 0`);
  }
  return seconds;
}

function parseExpressionParameter(
  value: unknown,
  path: string,
  declaredIds: ReadonlySet<string>,
): IkiExpressionParameter {
  if (!isObject(value)) {
    throw new IkiFormatError(`${path} must be an object`);
  }
  const parameter = str(value.parameter, `${path}.parameter`);
  if (!declaredIds.has(parameter)) {
    throw new IkiFormatError(
      `${path}.parameter "${parameter}" is not a declared parameter`,
    );
  }
  const result: IkiExpressionParameter = {
    parameter,
    value: num(value.value, `${path}.value`),
  };
  if (value.blend !== undefined) {
    if (
      typeof value.blend !== "string" ||
      !EXPRESSION_BLENDS.has(value.blend)
    ) {
      throw new IkiFormatError(
        `${path}.blend must be one of ${[...EXPRESSION_BLENDS].join(", ")}`,
      );
    }
    result.blend = value.blend as IkiExpressionBlend;
  }
  return result;
}

function parseExpression(
  value: unknown,
  path: string,
  declaredIds: ReadonlySet<string>,
): IkiExpression {
  if (!isObject(value)) {
    throw new IkiFormatError(`${path} must be an object`);
  }
  const expression: IkiExpression = {
    id: str(value.id, `${path}.id`),
    description: parseDescription(value.description, `${path}.description`),
    parameters: [],
  };
  if (value.fadeIn !== undefined) {
    expression.fadeIn = parseFadeSeconds(value.fadeIn, `${path}.fadeIn`);
  }
  if (value.fadeOut !== undefined) {
    expression.fadeOut = parseFadeSeconds(value.fadeOut, `${path}.fadeOut`);
  }
  if (!Array.isArray(value.parameters) || value.parameters.length === 0) {
    throw new IkiFormatError(`${path}.parameters must be a non-empty array`);
  }
  const seen = new Set<string>();
  expression.parameters = value.parameters.map((p, i) => {
    const at = `${path}.parameters[${i}]`;
    const parsed = parseExpressionParameter(p, at, declaredIds);
    if (seen.has(parsed.parameter)) {
      throw new IkiFormatError(
        `${at}.parameter "${parsed.parameter}" duplicates an earlier parameter in this expression`,
      );
    }
    seen.add(parsed.parameter);
    return parsed;
  });
  return expression;
}

/** Parse the model's `expressions` array. */
export function parseExpressions(
  value: unknown,
  declaredIds: ReadonlySet<string>,
): IkiExpression[] {
  if (!Array.isArray(value)) {
    throw new IkiFormatError("expressions must be an array");
  }
  const ids = new Set<string>();
  return value.map((e, i) => {
    const expression = parseExpression(e, `expressions[${i}]`, declaredIds);
    if (ids.has(expression.id)) {
      throw new IkiFormatError(
        `expressions[${i}].id "${expression.id}" duplicates an earlier expression id`,
      );
    }
    ids.add(expression.id);
    return expression;
  });
}

function parseMotionKeys(
  value: unknown,
  path: string,
  duration: number,
): [number, number][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IkiFormatError(`${path} must be a non-empty array`);
  }
  let previous = -Infinity;
  return value.map((k, i) => {
    const at = `${path}[${i}]`;
    if (!Array.isArray(k) || k.length !== 2) {
      throw new IkiFormatError(`${at} must be a [t, value] pair`);
    }
    const t = num(k[0], `${at}[0]`);
    const v = num(k[1], `${at}[1]`);
    if (t < 0 || t > duration) {
      throw new IkiFormatError(`${at}[0] must be within [0, duration]`);
    }
    if (t <= previous) {
      throw new IkiFormatError(
        `${at}[0] must be greater than the previous key's t`,
      );
    }
    previous = t;
    return [t, v];
  });
}

function parseMotionClip(
  value: unknown,
  path: string,
  declaredIds: ReadonlySet<string>,
  idle: boolean,
): IkiMotionClip {
  if (!isObject(value)) {
    throw new IkiFormatError(`${path} must be an object`);
  }
  const description = parseDescription(
    value.description,
    `${path}.description`,
  );
  const duration = num(value.duration, `${path}.duration`);
  if (duration <= 0) {
    throw new IkiFormatError(`${path}.duration must be > 0`);
  }
  const clip: IkiMotionClip = { description, duration, curves: [] };
  // Each fade is bounded by the clip; their sum is not (overlap is valid).
  for (const field of ["fadeIn", "fadeOut"] as const) {
    if (value[field] === undefined) continue;
    const seconds = parseFadeSeconds(value[field], `${path}.${field}`);
    if (seconds > duration) {
      throw new IkiFormatError(`${path}.${field} must not exceed duration`);
    }
    clip[field] = seconds;
  }
  if (!Array.isArray(value.curves) || value.curves.length === 0) {
    throw new IkiFormatError(`${path}.curves must be a non-empty array`);
  }
  const seen = new Set<string>();
  clip.curves = value.curves.map((c, i): IkiMotionCurve => {
    const at = `${path}.curves[${i}]`;
    if (!isObject(c)) {
      throw new IkiFormatError(`${at} must be an object`);
    }
    const parameter = str(c.parameter, `${at}.parameter`);
    if (!declaredIds.has(parameter)) {
      throw new IkiFormatError(
        `${at}.parameter "${parameter}" is not a declared parameter`,
      );
    }
    if (idle && IDLE_PROCEDURAL.has(parameter)) {
      throw new IkiFormatError(
        `${at}.parameter "${parameter}" stays procedural: an Idle clip may not animate blink or breath`,
      );
    }
    if (seen.has(parameter)) {
      throw new IkiFormatError(
        `${at}.parameter "${parameter}" duplicates an earlier curve in this clip`,
      );
    }
    seen.add(parameter);
    return { parameter, keys: parseMotionKeys(c.keys, `${at}.keys`, duration) };
  });
  return clip;
}

/** Parse the model's `motions` record (group name -> clips). */
export function parseMotions(
  value: unknown,
  declaredIds: ReadonlySet<string>,
): Record<string, IkiMotionClip[]> {
  if (!isObject(value)) {
    throw new IkiFormatError("motions must be an object");
  }
  // fromEntries defines own keys, so a group named "__proto__" is kept.
  return Object.fromEntries(
    Object.keys(value).map((group) => {
      const at = `motions[${JSON.stringify(group)}]`;
      if (group === "") {
        throw new IkiFormatError(`${at} group name must be non-empty`);
      }
      const clips = value[group];
      if (!Array.isArray(clips) || clips.length === 0) {
        throw new IkiFormatError(`${at} must be a non-empty array`);
      }
      const idle = group === IDLE_MOTION_GROUP;
      return [
        group,
        clips.map((c, i) =>
          parseMotionClip(c, `${at}[${i}]`, declaredIds, idle),
        ),
      ];
    }),
  );
}
