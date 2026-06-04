import {
  IKI_FORMAT_VERSION,
  type IkiBinding,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiTransformChannel,
} from "./types";

/** Thrown when input does not conform to the `.iki` format. */
export class IkiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IkiFormatError";
  }
}

const TRANSFORM_CHANNELS: ReadonlySet<IkiTransformChannel> = new Set([
  "translateX",
  "translateY",
  "rotate",
  "scaleX",
  "scaleY",
  "opacity",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new IkiFormatError(`${path} must be a number`);
  }
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new IkiFormatError(`${path} must be a non-empty string`);
  }
  return value;
}

function parseParameter(value: unknown, path: string): IkiParameter {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  return {
    id: str(value.id, `${path}.id`),
    name:
      value.name === undefined ? undefined : str(value.name, `${path}.name`),
    min: num(value.min, `${path}.min`),
    max: num(value.max, `${path}.max`),
    default: num(value.default, `${path}.default`),
  };
}

function parseBinding(value: unknown, path: string): IkiBinding {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const channel = value.channel;
  if (
    typeof channel !== "string" ||
    !TRANSFORM_CHANNELS.has(channel as IkiTransformChannel)
  ) {
    throw new IkiFormatError(
      `${path}.channel must be one of ${[...TRANSFORM_CHANNELS].join(", ")}`,
    );
  }
  return {
    parameter: str(value.parameter, `${path}.parameter`),
    channel: channel as IkiTransformChannel,
    from: num(value.from, `${path}.from`),
    to: num(value.to, `${path}.to`),
  };
}

function parsePart(value: unknown, path: string): IkiPart {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const transform = value.transform;
  if (!isObject(transform)) {
    throw new IkiFormatError(`${path}.transform must be an object`);
  }
  const bindings = value.bindings;
  if (bindings !== undefined && !Array.isArray(bindings)) {
    throw new IkiFormatError(`${path}.bindings must be an array`);
  }
  return {
    id: str(value.id, `${path}.id`),
    texture:
      value.texture === undefined
        ? undefined
        : str(value.texture, `${path}.texture`),
    color: value.color as IkiPart["color"],
    width: num(value.width, `${path}.width`),
    height: num(value.height, `${path}.height`),
    transform: {
      x: num(transform.x, `${path}.transform.x`),
      y: num(transform.y, `${path}.transform.y`),
      rotation:
        transform.rotation === undefined
          ? undefined
          : num(transform.rotation, `${path}.transform.rotation`),
      scaleX:
        transform.scaleX === undefined
          ? undefined
          : num(transform.scaleX, `${path}.transform.scaleX`),
      scaleY:
        transform.scaleY === undefined
          ? undefined
          : num(transform.scaleY, `${path}.transform.scaleY`),
      opacity:
        transform.opacity === undefined
          ? undefined
          : num(transform.opacity, `${path}.transform.opacity`),
    },
    order: num(value.order, `${path}.order`),
    bindings: bindings?.map((b, i) =>
      parseBinding(b, `${path}.bindings[${i}]`),
    ),
  };
}

/**
 * Validate and normalize arbitrary input into an {@link IkiModel}.
 * Throws {@link IkiFormatError} with a path-qualified message on bad input.
 */
export function parseIkiModel(input: unknown): IkiModel {
  if (!isObject(input)) throw new IkiFormatError("model must be an object");

  const version = num(input.version, "version");
  if (version !== IKI_FORMAT_VERSION) {
    throw new IkiFormatError(
      `unsupported version ${version}; expected ${IKI_FORMAT_VERSION}`,
    );
  }

  if (!isObject(input.canvas)) {
    throw new IkiFormatError("canvas must be an object");
  }
  if (!Array.isArray(input.parameters)) {
    throw new IkiFormatError("parameters must be an array");
  }
  if (!Array.isArray(input.parts)) {
    throw new IkiFormatError("parts must be an array");
  }

  return {
    version,
    name: str(input.name, "name"),
    canvas: {
      width: num(input.canvas.width, "canvas.width"),
      height: num(input.canvas.height, "canvas.height"),
    },
    parameters: input.parameters.map((p, i) =>
      parseParameter(p, `parameters[${i}]`),
    ),
    parts: input.parts.map((p, i) => parsePart(p, `parts[${i}]`)),
  };
}

/** Parse a `.iki` JSON string into an {@link IkiModel}. */
export function loadIkiModel(json: string): IkiModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new IkiFormatError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseIkiModel(parsed);
}
