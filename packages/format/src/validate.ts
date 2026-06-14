import {
  IKI_FORMAT_VERSION,
  type IkiBinding,
  type IkiDeformer,
  type IkiDeformerBinding,
  type IkiGrid2DKeyform,
  type IkiGrid2DWarp,
  type IkiGridKeyform,
  type IkiGridWarp,
  type IkiKeyform,
  type IkiMatrixChannel,
  type IkiMatrixDeformer,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiTexture,
  type IkiTransform,
  type IkiTransformChannel,
  type IkiUvRect,
  type IkiWarp,
  type IkiWarpDeformer,
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

function parseGridKeyform(
  value: unknown,
  path: string,
  pointComponentCount: number,
): IkiGridKeyform {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const kfValue = num(value.value, `${path}.value`);
  const offsets = parseNumberArray(value.offsets, `${path}.offsets`);
  if (offsets.length !== pointComponentCount) {
    throw new IkiFormatError(
      `${path}.offsets length must equal grid.points length`,
    );
  }
  return { value: kfValue, offsets };
}

function parseGridWarp(
  value: unknown,
  path: string,
  paramDescriptors: ReadonlyMap<string, { min: number; max: number }>,
  pointComponentCount: number,
): IkiGridWarp {
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
    parseGridKeyform(kf, `${path}.keyforms[${i}]`, pointComponentCount),
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

function parseGrid2DWarp(
  value: unknown,
  path: string,
  paramDescriptors: ReadonlyMap<string, { min: number; max: number }>,
  pointComponentCount: number,
): IkiGrid2DWarp {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);

  // All five fields are required for a complete 2D warp shape.
  if (
    value.parameter === undefined ||
    value.parameterY === undefined ||
    value.valuesX === undefined ||
    value.valuesY === undefined ||
    value.keyforms2d === undefined
  ) {
    throw new IkiFormatError(
      `${path} must declare parameter, parameterY, valuesX, valuesY, and keyforms2d`,
    );
  }

  const parameter = str(value.parameter, `${path}.parameter`);
  const descriptorX = paramDescriptors.get(parameter);
  if (!descriptorX) {
    throw new IkiFormatError(
      `${path}.parameter "${parameter}" is not a declared parameter`,
    );
  }

  const parameterY = str(value.parameterY, `${path}.parameterY`);
  const descriptorY = paramDescriptors.get(parameterY);
  if (!descriptorY) {
    throw new IkiFormatError(
      `${path}.parameterY "${parameterY}" is not a declared parameter`,
    );
  }

  if (parameter === parameterY) {
    throw new IkiFormatError(
      `${path}.parameter and ${path}.parameterY must be different (a parameter cannot drive both axes)`,
    );
  }

  const valuesX = parseNumberArray(value.valuesX, `${path}.valuesX`);
  if (valuesX.length < 2) {
    throw new IkiFormatError(
      `${path}.valuesX must have at least 2 entries (a 2D warp needs ≥2 stops per axis)`,
    );
  }
  for (let i = 0; i < valuesX.length; i++) {
    const v = valuesX[i];
    if (v < descriptorX.min || v > descriptorX.max) {
      throw new IkiFormatError(
        `${path}.valuesX[${i}] ${v} is outside parameter "${parameter}" range [${descriptorX.min},${descriptorX.max}]`,
      );
    }
  }
  for (let i = 1; i < valuesX.length; i++) {
    if (valuesX[i] <= valuesX[i - 1]) {
      throw new IkiFormatError(`${path}.valuesX must be strictly ascending`);
    }
  }

  const valuesY = parseNumberArray(value.valuesY, `${path}.valuesY`);
  if (valuesY.length < 2) {
    throw new IkiFormatError(
      `${path}.valuesY must have at least 2 entries (a 2D warp needs ≥2 stops per axis)`,
    );
  }
  for (let i = 0; i < valuesY.length; i++) {
    const v = valuesY[i];
    if (v < descriptorY.min || v > descriptorY.max) {
      throw new IkiFormatError(
        `${path}.valuesY[${i}] ${v} is outside parameter "${parameterY}" range [${descriptorY.min},${descriptorY.max}]`,
      );
    }
  }
  for (let i = 1; i < valuesY.length; i++) {
    if (valuesY[i] <= valuesY[i - 1]) {
      throw new IkiFormatError(`${path}.valuesY must be strictly ascending`);
    }
  }

  if (!Array.isArray(value.keyforms2d)) {
    throw new IkiFormatError(`${path}.keyforms2d must be an array`);
  }
  const expectedCount = valuesX.length * valuesY.length;
  if (value.keyforms2d.length !== expectedCount) {
    throw new IkiFormatError(
      `${path}.keyforms2d length ${value.keyforms2d.length} must equal valuesX.length * valuesY.length = ${expectedCount}`,
    );
  }
  const keyforms2d: IkiGrid2DKeyform[] = value.keyforms2d.map(
    (kf: unknown, k: number) => {
      if (!isObject(kf)) {
        throw new IkiFormatError(`${path}.keyforms2d[${k}] must be an object`);
      }
      const offsets = parseNumberArray(
        kf.offsets,
        `${path}.keyforms2d[${k}].offsets`,
      );
      if (offsets.length !== pointComponentCount) {
        throw new IkiFormatError(
          `${path}.keyforms2d[${k}].offsets length must equal grid.points length`,
        );
      }
      return { offsets };
    },
  );

  return { parameter, parameterY, valuesX, valuesY, keyforms2d };
}

const GRID_REGULARITY_ERROR =
  "must be a regular axis-aligned grid (row 0 top / largest y, column 0 left / smallest x, strictly ordered, nonzero spacing)";

function checkGridRegularity(
  points: number[],
  cols: number,
  rows: number,
  path: string,
): void {
  const eps = 1e-6;
  // Derive per-column x and per-row y from row 0 and column 0
  const colX: number[] = [];
  for (let c = 0; c <= cols; c++) {
    colX.push(points[c * 2]);
  }
  const rowY: number[] = [];
  for (let r = 0; r <= rows; r++) {
    rowY.push(points[r * (cols + 1) * 2 + 1]);
  }
  // Column x must strictly increase
  for (let c = 1; c <= cols; c++) {
    if (colX[c] <= colX[c - 1]) {
      throw new IkiFormatError(`${path}.grid.points ${GRID_REGULARITY_ERROR}`);
    }
  }
  // Row y must strictly decrease (row 0 = top = largest y, +y up)
  for (let r = 1; r <= rows; r++) {
    if (rowY[r] >= rowY[r - 1]) {
      throw new IkiFormatError(`${path}.grid.points ${GRID_REGULARITY_ERROR}`);
    }
  }
  // Every point must match its column's x and row's y within epsilon
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const idx = (r * (cols + 1) + c) * 2;
      const px = points[idx];
      const py = points[idx + 1];
      if (Math.abs(px - colX[c]) > eps || Math.abs(py - rowY[r]) > eps) {
        throw new IkiFormatError(
          `${path}.grid.points ${GRID_REGULARITY_ERROR}`,
        );
      }
    }
  }
}

function parseWarpDeformer(
  value: unknown,
  path: string,
  paramDescriptors: ReadonlyMap<string, { min: number; max: number }>,
): IkiWarpDeformer {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const id = str(value.id, `${path}.id`);
  const parent =
    value.parent === undefined
      ? undefined
      : str(value.parent, `${path}.parent`);

  const grid = value.grid;
  if (!isObject(grid)) {
    throw new IkiFormatError(`${path}.grid must be an object`);
  }

  const colsRaw = grid.cols;
  if (!Number.isInteger(colsRaw) || (colsRaw as number) <= 0) {
    throw new IkiFormatError(`${path}.grid.cols must be a positive integer`);
  }
  const cols = colsRaw as number;

  const rowsRaw = grid.rows;
  if (!Number.isInteger(rowsRaw) || (rowsRaw as number) <= 0) {
    throw new IkiFormatError(`${path}.grid.rows must be a positive integer`);
  }
  const rows = rowsRaw as number;

  const points = parseNumberArray(grid.points, `${path}.grid.points`);
  const expected = 2 * (cols + 1) * (rows + 1);
  if (points.length !== expected) {
    throw new IkiFormatError(
      `${path}.grid.points length ${points.length} must equal 2*(cols+1)*(rows+1) = ${expected}`,
    );
  }

  checkGridRegularity(points, cols, rows, path);

  // A warp deformer carries EITHER warps (1D) XOR warp2d (2D) — reject both.
  // An empty warps array is treated as absent (it contributes nothing at runtime);
  // only a non-empty warps array conflicts with warp2d.
  if (
    Array.isArray(value.warps) &&
    value.warps.length > 0 &&
    value.warp2d !== undefined
  ) {
    throw new IkiFormatError(
      `${path}: a warp deformer declares only one of warps (1D) or warp2d (2D), not both`,
    );
  }

  let warps: IkiWarpDeformer["warps"];
  if (value.warps !== undefined) {
    if (!Array.isArray(value.warps)) {
      throw new IkiFormatError(`${path}.warps must be an array`);
    }
    // A warp deformer's grid is driven by at most ONE grid warp in this
    // milestone. Multi-parameter grid composition (multiple grid drivers blended
    // additively) is deferred until intentionally designed; reject it here so the
    // contract does not silently commit to that behavior.
    if (value.warps.length > 1) {
      throw new IkiFormatError(
        `${path}.warps supports at most one grid warp (multi-parameter grid composition is deferred)`,
      );
    }
    warps = value.warps.map((w, i) =>
      parseGridWarp(w, `${path}.warps[${i}]`, paramDescriptors, points.length),
    );
  }

  let warp2d: IkiWarpDeformer["warp2d"];
  if (value.warp2d !== undefined) {
    warp2d = parseGrid2DWarp(
      value.warp2d,
      `${path}.warp2d`,
      paramDescriptors,
      points.length,
    );
    // Normalize: an inert empty warps array alongside warp2d is dropped so the
    // output model satisfies the XOR contract (EITHER warps XOR warp2d, not both).
    if (warps !== undefined && warps.length === 0) {
      warps = undefined;
    }
  }

  return {
    kind: "warp",
    id,
    parent,
    grid: { cols, rows, points },
    warps,
    warp2d,
  };
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
): IkiMatrixDeformer {
  if (!isObject(value)) throw new IkiFormatError(`${path} must be an object`);
  const id = str(value.id, `${path}.id`);

  const pivot = value.pivot;
  if (!isObject(pivot)) {
    throw new IkiFormatError(`${path}.pivot must be an object`);
  }

  let transform: IkiMatrixDeformer["transform"];
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
    deformers = input.deformers.map((d, i) => {
      const path = `deformers[${i}]`;
      if (!isObject(d)) throw new IkiFormatError(`${path} must be an object`);
      const kind = d.kind;
      if (kind === "warp") return parseWarpDeformer(d, path, paramDescriptors);
      if (kind === undefined || kind === "matrix")
        return parseDeformer(d, path, declaredIds);
      throw new IkiFormatError(
        `${path}.kind "${kind}" is not a known deformer kind`,
      );
    });
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

    // Kind-aware parent restrictions: warp->warp and matrix->warp are forbidden.
    // Only matrix parent -> warp child is allowed (#4c milestone).
    const deformerKindById = new Map<string, IkiDeformer["kind"]>();
    for (const d of deformers) {
      deformerKindById.set(d.id, d.kind);
    }
    for (let i = 0; i < deformers.length; i++) {
      const d = deformers[i];
      if (d.parent === undefined) continue;
      const parentKind = deformerKindById.get(d.parent);
      if (d.kind === "warp" && parentKind === "warp") {
        throw new IkiFormatError(
          `deformers[${i}].parent "${d.parent}" must be a matrix deformer (warp deformers cannot be nested under a warp deformer)`,
        );
      }
      if (d.kind !== "warp" && parentKind === "warp") {
        throw new IkiFormatError(
          `deformers[${i}].parent "${d.parent}" is a warp deformer; matrix deformers cannot be children of a warp deformer`,
        );
      }
    }
  }

  // Build set of warp-deformer ids for the mesh-required cross-check
  const warpDeformerIds = new Set<string>();
  if (deformers) {
    for (const d of deformers) {
      if (d.kind === "warp") warpDeformerIds.add(d.id);
    }
  }

  // Cross-check part.deformer references (and warp-deformer mesh requirement)
  for (let i = 0; i < parts.length; i++) {
    const ref = parts[i].deformer;
    if (ref !== undefined && !deformerIds.has(ref)) {
      throw new IkiFormatError(
        `parts[${i}].deformer "${ref}" is not a declared deformer`,
      );
    }
    if (
      ref !== undefined &&
      warpDeformerIds.has(ref) &&
      parts[i].mesh === undefined
    ) {
      throw new IkiFormatError(
        `parts[${i}].deformer "${ref}" is a warp deformer and requires parts[${i}].mesh`,
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
