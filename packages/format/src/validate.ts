import {
  IKI_FORMAT_VERSION,
  type IkiBinding,
  type IkiDeformer,
  type IkiDeformerBinding,
  type IkiKeyform,
  type IkiMatrixChannel,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiTexture,
  type IkiTransform,
  type IkiTransformChannel,
  type IkiUvRect,
  type IkiWarp,
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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IkiFormatError(`${path} must be a finite number`);
  }
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new IkiFormatError(`${path} must be a non-empty string`);
  }
  return value;
}

function parseNumberArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    throw new IkiFormatError(`${path} must be an array`);
  }
  return value.map((entry, i) => num(entry, `${path}[${i}]`));
}

function parseMesh(value: unknown, path: string): IkiMesh {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const vertices = parseNumberArray(value.vertices, `${path}.vertices`);
  const uvs = parseNumberArray(value.uvs, `${path}.uvs`);
  const indices = parseNumberArray(value.indices, `${path}.indices`);

  const componentCount = vertices.length;
  const vertexCount = componentCount / 2;

  if (componentCount % 2 !== 0) {
    throw new IkiFormatError(
      `${path}.vertices must have an even length (x,y pairs)`,
    );
  }
  if (componentCount < 6) {
    throw new IkiFormatError(
      `${path}.vertices must describe at least 3 vertices`,
    );
  }
  if (vertexCount > 65536) {
    throw new IkiFormatError(`${path}.vertices exceeds the 65536-vertex limit`);
  }
  if (uvs.length !== componentCount) {
    throw new IkiFormatError(`${path}.uvs length must equal vertices length`);
  }
  for (let i = 0; i < uvs.length; i++) {
    if (uvs[i] < 0 || uvs[i] > 1) {
      throw new IkiFormatError(`${path}.uvs[${i}] must be a number in 0..1`);
    }
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new IkiFormatError(
      `${path}.indices length must be a positive multiple of 3`,
    );
  }
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0 || v > vertexCount - 1) {
      throw new IkiFormatError(`${path}.indices[${i}] ${v} is out of range`);
    }
  }

  return { vertices, uvs, indices };
}

function parseKeyform(
  value: unknown,
  path: string,
  componentCount: number,
): IkiKeyform {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const kfValue = num(value.value, `${path}.value`);
  const offsets = parseNumberArray(value.offsets, `${path}.offsets`);
  if (offsets.length !== componentCount) {
    throw new IkiFormatError(
      `${path}.offsets length must equal mesh vertices length`,
    );
  }
  return { value: kfValue, offsets };
}

function parseWarp(
  value: unknown,
  path: string,
  paramDescriptors: ReadonlyMap<string, { min: number; max: number }>,
  componentCount: number,
): IkiWarp {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const parameter = str(value.parameter, `${path}.parameter`);
  const descriptor = paramDescriptors.get(parameter);
  if (!descriptor) {
    throw new IkiFormatError(
      `${path}.parameter "${parameter}" is not a declared parameter`,
    );
  }
  if (!Array.isArray(value.keyforms) || value.keyforms.length === 0) {
    throw new IkiFormatError(`${path}.keyforms must be a non-empty array`);
  }
  const keyforms = value.keyforms.map((kf, i) =>
    parseKeyform(kf, `${path}.keyforms[${i}]`, componentCount),
  );
  const { min, max } = descriptor;
  for (let i = 0; i < keyforms.length; i++) {
    const v = keyforms[i].value;
    if (v < min || v > max) {
      throw new IkiFormatError(
        `${path}.keyforms[${i}].value ${v} is outside parameter "${parameter}" range [${min},${max}]`,
      );
    }
  }
  for (let i = 1; i < keyforms.length; i++) {
    if (keyforms[i].value <= keyforms[i - 1].value) {
      throw new IkiFormatError(
        `${path}.keyforms must be sorted ascending by value`,
      );
    }
  }
  return { parameter, keyforms };
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
  paramDescriptors: ReadonlyMap<string, { min: number; max: number }>,
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

  let mesh: IkiPart["mesh"];
  if (value.mesh !== undefined) {
    mesh = parseMesh(value.mesh, `${path}.mesh`);
  }
  const componentCount = mesh ? mesh.vertices.length : 0;

  let warps: IkiPart["warps"];
  if (value.warps !== undefined) {
    if (!Array.isArray(value.warps)) {
      throw new IkiFormatError(`${path}.warps must be an array`);
    }
    if (mesh === undefined) {
      throw new IkiFormatError(`${path}.warps requires a mesh`);
    }
    warps = value.warps.map((w, i) =>
      parseWarp(w, `${path}.warps[${i}]`, paramDescriptors, componentCount),
    );
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
    mesh,
    warps,
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
  const paramDescriptors = new Map<string, { min: number; max: number }>();
  for (const param of parameters) {
    if (declaredIds.has(param.id)) {
      throw new IkiFormatError(`duplicate parameter id "${param.id}"`);
    }
    declaredIds.add(param.id);
    paramDescriptors.set(param.id, { min: param.min, max: param.max });
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
    parsePart(p, `parts[${i}]`, declaredIds, paramDescriptors, texturesCount),
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
