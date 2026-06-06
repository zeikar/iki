import {
  IKI_FORMAT_VERSION,
  type IkiBinding,
  type IkiDeformer,
  type IkiDeformerBinding,
  type IkiMatrixChannel,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiTexture,
  type IkiTransform,
  type IkiTransformChannel,
  type IkiUvRect,
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

const MATRIX_CHANNELS: ReadonlySet<IkiMatrixChannel> = new Set([
  "translateX",
  "translateY",
  "rotate",
  "scaleX",
  "scaleY",
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

function parseColor(
  value: unknown,
  path: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new IkiFormatError(`${path} must be an array of 4 numbers (RGBA)`);
  }
  for (let i = 0; i < 4; i++) {
    const channel = value[i];
    if (
      typeof channel !== "number" ||
      !Number.isFinite(channel) ||
      channel < 0 ||
      channel > 1
    ) {
      throw new IkiFormatError(`${path}[${i}] must be a number in 0..1`);
    }
  }
  return [value[0], value[1], value[2], value[3]];
}

function parseUvField(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new IkiFormatError(`${path} must be a number in 0..1`);
  }
  return value;
}

const UV_EPSILON = 1e-9;

function parseUvRect(value: unknown, path: string): IkiUvRect {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const x = parseUvField(value.x, `${path}.x`);
  const y = parseUvField(value.y, `${path}.y`);
  const width = parseUvField(value.width, `${path}.width`);
  const height = parseUvField(value.height, `${path}.height`);
  if (x + width > 1 + UV_EPSILON || y + height > 1 + UV_EPSILON) {
    throw new IkiFormatError(`${path} exceeds atlas bounds`);
  }
  return { x, y, width, height };
}

function parseTexture(value: unknown, path: string): IkiTexture {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const source = str(value.source, `${path}.source`);
  if (!source.startsWith("data:image/")) {
    throw new IkiFormatError(
      `${path}.source must be a data:image/ URI (external sources are not supported yet)`,
    );
  }
  return { source };
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

function parseBinding(
  value: unknown,
  path: string,
  validParameters: ReadonlySet<string>,
): IkiBinding {
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
  const parameter = str(value.parameter, `${path}.parameter`);
  if (!validParameters.has(parameter)) {
    throw new IkiFormatError(
      `${path}.parameter "${parameter}" is not a declared parameter`,
    );
  }
  return {
    parameter,
    channel: channel as IkiTransformChannel,
    from: num(value.from, `${path}.from`),
    to: num(value.to, `${path}.to`),
  };
}

function parseTransform(value: unknown, path: string): IkiTransform {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  return {
    x: num(value.x, `${path}.x`),
    y: num(value.y, `${path}.y`),
    rotation:
      value.rotation === undefined
        ? undefined
        : num(value.rotation, `${path}.rotation`),
    scaleX:
      value.scaleX === undefined
        ? undefined
        : num(value.scaleX, `${path}.scaleX`),
    scaleY:
      value.scaleY === undefined
        ? undefined
        : num(value.scaleY, `${path}.scaleY`),
    opacity:
      value.opacity === undefined
        ? undefined
        : num(value.opacity, `${path}.opacity`),
  };
}

function parseDeformerBinding(
  value: unknown,
  path: string,
  validParameters: ReadonlySet<string>,
): IkiDeformerBinding {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const channel = value.channel;
  if (channel === "opacity") {
    throw new IkiFormatError(
      `${path}.channel "opacity" is not supported on a deformer`,
    );
  }
  if (
    typeof channel !== "string" ||
    !MATRIX_CHANNELS.has(channel as IkiMatrixChannel)
  ) {
    throw new IkiFormatError(
      `${path}.channel must be one of ${[...MATRIX_CHANNELS].join(", ")}`,
    );
  }
  const parameter = str(value.parameter, `${path}.parameter`);
  if (!validParameters.has(parameter)) {
    throw new IkiFormatError(
      `${path}.parameter "${parameter}" is not a declared parameter`,
    );
  }
  return {
    parameter,
    channel: channel as IkiMatrixChannel,
    from: num(value.from, `${path}.from`),
    to: num(value.to, `${path}.to`),
  };
}

function parseDeformer(
  value: unknown,
  path: string,
  validParameters: ReadonlySet<string>,
): IkiDeformer {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const id = str(value.id, `${path}.id`);

  const pivot = value.pivot;
  if (!isObject(pivot)) {
    throw new IkiFormatError(`${path}.pivot must be an object`);
  }

  let transform: IkiDeformer["transform"];
  if (value.transform !== undefined) {
    if (!isObject(value.transform)) {
      throw new IkiFormatError(`${path}.transform must be an object`);
    }
    if (value.transform.opacity !== undefined) {
      throw new IkiFormatError(
        `${path}.transform.opacity is not supported on a deformer (matrix-only)`,
      );
    }
    const raw = parseTransform(value.transform, `${path}.transform`);
    // Strip opacity — IkiDeformerTransform is Omit<IkiTransform, "opacity">
    const { opacity: _opacity, ...rest } = raw;
    transform = rest;
  }

  const bindings = value.bindings;
  if (bindings !== undefined && !Array.isArray(bindings)) {
    throw new IkiFormatError(`${path}.bindings must be an array`);
  }

  return {
    id,
    parent:
      value.parent === undefined
        ? undefined
        : str(value.parent, `${path}.parent`),
    pivot: {
      x: num(pivot.x, `${path}.pivot.x`),
      y: num(pivot.y, `${path}.pivot.y`),
    },
    transform,
    bindings: bindings?.map((b, i) =>
      parseDeformerBinding(b, `${path}.bindings[${i}]`, validParameters),
    ),
  };
}

function parsePart(
  value: unknown,
  path: string,
  validParameters: ReadonlySet<string>,
  texturesCount: number,
): IkiPart {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const transform = value.transform;
  if (!isObject(transform)) {
    throw new IkiFormatError(`${path}.transform must be an object`);
  }
  const bindings = value.bindings;
  if (bindings !== undefined && !Array.isArray(bindings)) {
    throw new IkiFormatError(`${path}.bindings must be an array`);
  }

  let texture: IkiPart["texture"];
  if (value.texture !== undefined) {
    if (!isObject(value.texture)) {
      throw new IkiFormatError(`${path}.texture must be an object`);
    }
    const rawIndex = value.texture.index;
    if (
      typeof rawIndex !== "number" ||
      !Number.isInteger(rawIndex) ||
      rawIndex < 0 ||
      rawIndex >= texturesCount
    ) {
      throw new IkiFormatError(
        `${path}.texture.index ${rawIndex ?? "(missing)"} is not a declared texture`,
      );
    }
    texture = {
      index: rawIndex,
      uv: parseUvRect(value.texture.uv, `${path}.texture.uv`),
    };
  }

  return {
    id: str(value.id, `${path}.id`),
    color: parseColor(value.color, `${path}.color`),
    width: num(value.width, `${path}.width`),
    height: num(value.height, `${path}.height`),
    transform: parseTransform(transform, `${path}.transform`),
    order: num(value.order, `${path}.order`),
    bindings: bindings?.map((b, i) =>
      parseBinding(b, `${path}.bindings[${i}]`, validParameters),
    ),
    texture,
    deformer:
      value.deformer === undefined
        ? undefined
        : str(value.deformer, `${path}.deformer`),
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

  const parameters = input.parameters.map((p, i) =>
    parseParameter(p, `parameters[${i}]`),
  );

  const declaredIds = new Set<string>();
  for (const param of parameters) {
    if (declaredIds.has(param.id)) {
      throw new IkiFormatError(`duplicate parameter id "${param.id}"`);
    }
    declaredIds.add(param.id);
  }

  let textures: IkiTexture[] | undefined;
  if (input.textures !== undefined) {
    if (!Array.isArray(input.textures)) {
      throw new IkiFormatError("textures must be an array");
    }
    textures = input.textures.map((t, i) => parseTexture(t, `textures[${i}]`));
  }
  const texturesCount = textures?.length ?? 0;

  // Parse parts (deformer field collected here; cross-check after deformers are known)
  const parts = input.parts.map((p, i) =>
    parsePart(p, `parts[${i}]`, declaredIds, texturesCount),
  );

  // Parse deformers (optional)
  let deformers: IkiDeformer[] | undefined;
  if (input.deformers !== undefined) {
    if (!Array.isArray(input.deformers)) {
      throw new IkiFormatError("deformers must be an array");
    }
    deformers = input.deformers.map((d, i) =>
      parseDeformer(d, `deformers[${i}]`, declaredIds),
    );
  }

  // Shared namespace: deformer ids must not collide with each other or part ids
  const deformerIds = new Set<string>();
  if (deformers) {
    for (let i = 0; i < deformers.length; i++) {
      const { id } = deformers[i];
      if (deformerIds.has(id)) {
        throw new IkiFormatError(
          `deformers[${i}].id "${id}" collides with a previous deformer id`,
        );
      }
      // Find the part index for a better error message
      const partIdx = parts.findIndex((p) => p.id === id);
      if (partIdx !== -1) {
        throw new IkiFormatError(
          `deformers[${i}].id "${id}" collides with parts[${partIdx}].id`,
        );
      }
      deformerIds.add(id);
    }
  }

  // Cross-check deformer parent references and detect cycles
  if (deformers) {
    for (let i = 0; i < deformers.length; i++) {
      const { id, parent } = deformers[i];
      if (parent === undefined) continue;
      if (parent === id) {
        throw new IkiFormatError(
          `deformers[${i}].parent "${parent}" is a self-reference`,
        );
      }
      if (!deformerIds.has(parent)) {
        throw new IkiFormatError(
          `deformers[${i}].parent "${parent}" is not a declared deformer`,
        );
      }
    }

    // Cycle detection via topological walk (visited-set per node)
    const parentOf = new Map<string, string>();
    for (const d of deformers) {
      if (d.parent !== undefined) parentOf.set(d.id, d.parent);
    }
    for (const d of deformers) {
      const visited = new Set<string>();
      let cur: string | undefined = d.id;
      while (cur !== undefined) {
        if (visited.has(cur)) {
          throw new IkiFormatError(
            `deformers contain a cycle involving "${cur}"`,
          );
        }
        visited.add(cur);
        cur = parentOf.get(cur);
      }
    }
  }

  // Cross-check part.deformer references
  for (let i = 0; i < parts.length; i++) {
    const ref = parts[i].deformer;
    if (ref !== undefined && !deformerIds.has(ref)) {
      throw new IkiFormatError(
        `parts[${i}].deformer "${ref}" is not a declared deformer`,
      );
    }
  }

  return {
    version,
    name: str(input.name, "name"),
    canvas: {
      width: num(input.canvas.width, "canvas.width"),
      height: num(input.canvas.height, "canvas.height"),
    },
    parameters,
    textures,
    parts,
    deformers,
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
