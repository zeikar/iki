// Validation for the animation fields of a model (expressions, motions).
// Kept apart from validate.ts: they share only the declared-parameter set.
import type {
  IkiExpression,
  IkiExpressionBlend,
  IkiExpressionParameter,
} from "./types";
import { IkiFormatError, isObject, num, str } from "./validate-primitives";

const EXPRESSION_BLENDS: ReadonlySet<string> = new Set([
  "add",
  "multiply",
  "overwrite",
]);

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
        `${path}.blend must be one of add, multiply, overwrite`,
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
    description: str(value.description, `${path}.description`),
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
