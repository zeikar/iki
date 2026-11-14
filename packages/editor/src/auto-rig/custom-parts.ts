/**
 * The `customParts` generator input. Every entry is checked before anything
 * is rigged, so a refusal rigs nothing; each message starts at the path of the
 * field (`customParts[i].tie`).
 */

import type { IkiParameter, IkiPart } from "@ikijs/format";
import { bh, boxOfPixels, bw, cx, cy, gridMesh } from "./layout";
import { ROLE_TABLE, partIdsOfRole } from "./roles";
import { checkedKeys } from "./solve";
import { CustomPartError, type CustomPart, type LayerInput } from "./types";

const KEYS = [
  "id",
  "layer",
  "anchor",
  "tie",
  "after",
  "deformer",
  "rigid",
  "occlusion",
];
const OCCLUSION_KEYS = ["by", "parameter", "stops"];
const STOP_KEYS = ["value", "amount"];
const LAYER_KEYS = ["fileName", "bbox"];

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Box = { x: number; y: number; w: number; h: number };

const inside = (b: Box, [x, y]: [number, number]) =>
  x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

/** Every role's name and every part id a role yields: an id no custom part
 *  may take, so `roleOfPart` can never read one as a role. */
const RESERVED = new Set(
  ROLE_TABLE.flatMap((r) => [r.role, ...partIdsOfRole(r.role)]),
);

export function checkCustomParts(
  customParts: unknown,
  byRole: ReadonlyMap<string, LayerInput>,
  canvas: { width: number; height: number },
  parameters: readonly IkiParameter[],
  physicsOutputs: ReadonlySet<string>,
): CustomPart[] {
  if (!Array.isArray(customParts)) {
    throw new CustomPartError(
      `customParts must be an array, got ${customParts === null ? "null" : typeof customParts}`,
    );
  }
  const present = [...byRole.keys()];
  const roleField = (at: string, v: unknown): LayerInput => {
    const layer = typeof v === "string" ? byRole.get(v) : undefined;
    if (layer === undefined) {
      throw new CustomPartError(
        `${at} must be a role of the set, one of ${present.join(", ")}; got ${JSON.stringify(v)}`,
      );
    }
    return layer;
  };
  const ids = new Set<string>();
  customParts.forEach((entry: unknown, i) => {
    const at = `customParts[${i}]`;
    if (!isObject(entry)) {
      throw new CustomPartError(`${at} must be a plain object`);
    }
    checkedKeys(at, entry, KEYS, CustomPartError);
    const { id, layer, anchor, tie, after, deformer, rigid, occlusion } = entry;

    if (typeof id !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      throw new CustomPartError(
        `${at}.id must be a plain identifier (letters, digits, underscore; not starting with a digit), got ${JSON.stringify(id)}`,
      );
    }
    if (RESERVED.has(id)) {
      throw new CustomPartError(
        `${at}.id "${id}" is a role's name or a part id a role yields: those are reserved, also for roles added later, so pick a name no role would take`,
      );
    }
    if (ids.has(id)) {
      throw new CustomPartError(
        `${at}.id "${id}" repeats an earlier entry's id`,
      );
    }
    ids.add(id);

    if (!isObject(layer)) {
      throw new CustomPartError(`${at}.layer must be a plain object`);
    }
    checkedKeys(`${at}.layer`, layer, LAYER_KEYS, CustomPartError);
    if (typeof layer.fileName !== "string" || layer.fileName === "") {
      throw new CustomPartError(
        `${at}.layer.fileName must be a non-empty string`,
      );
    }
    const b = isObject(layer.bbox) ? layer.bbox : {};
    const { x, y, w, h } = b;
    if (
      !(finite(x) && finite(y) && finite(w) && finite(h)) ||
      w <= 0 ||
      h <= 0 ||
      x < 0 ||
      y < 0 ||
      x + w > canvas.width ||
      y + h > canvas.height
    ) {
      throw new CustomPartError(
        `${at}.layer.bbox must be a finite, non-empty box inside the ${canvas.width}x${canvas.height} canvas, got ${JSON.stringify(layer.bbox)}`,
      );
    }
    const box: Box = { x, y, w, h };

    const anchorLayer = roleField(`${at}.anchor`, anchor);
    roleField(`${at}.after`, after);

    if (
      !Array.isArray(tie) ||
      tie.length !== 2 ||
      !tie.every(finite) ||
      !inside(box, tie as [number, number]) ||
      !inside(anchorLayer.bbox, tie as [number, number])
    ) {
      throw new CustomPartError(
        `${at}.tie must be [x, y], two finite canvas px inside both the part's layer box and the anchor "${String(anchor)}" layer box, got ${JSON.stringify(tie)}`,
      );
    }

    if (deformer !== undefined && deformer !== "headDeformer") {
      throw new CustomPartError(
        `${at}.deformer "${String(deformer)}" is not accepted: headDeformer is the only deformer a custom part hangs on`,
      );
    }

    if (rigid !== undefined && typeof rigid !== "boolean") {
      throw new CustomPartError(
        `${at}.rigid must be true or false, got ${JSON.stringify(rigid)}`,
      );
    }

    if (occlusion !== undefined) {
      checkOcclusion(
        `${at}.occlusion`,
        occlusion,
        present,
        parameters,
        physicsOutputs,
      );
    }
  });
  return customParts as CustomPart[];
}

/** `occlusion`, by the format's rules for `IkiPart.occlusion` (the roles stand
 *  in for part ids, which the generator writes). */
function checkOcclusion(
  at: string,
  occlusion: unknown,
  present: string[],
  parameters: readonly IkiParameter[],
  physicsOutputs: ReadonlySet<string>,
): void {
  if (!isObject(occlusion)) {
    throw new CustomPartError(`${at} must be a plain object`);
  }
  checkedKeys(at, occlusion, OCCLUSION_KEYS, CustomPartError);
  const { by, parameter, stops } = occlusion;

  if (!Array.isArray(by) || by.length === 0) {
    throw new CustomPartError(
      `${at}.by must be a non-empty array of roles of the set, one of ${present.join(", ")}`,
    );
  }
  by.forEach((role: unknown, j) => {
    if (typeof role !== "string" || !present.includes(role)) {
      throw new CustomPartError(
        `${at}.by[${j}] must be a role of the set, one of ${present.join(", ")}; got ${JSON.stringify(role)}`,
      );
    }
    if (by.indexOf(role) !== j) {
      throw new CustomPartError(
        `${at}.by[${j}] "${role}" repeats an earlier role`,
      );
    }
  });

  const descriptor = parameters.find((p) => p.id === parameter);
  if (typeof parameter !== "string" || descriptor === undefined) {
    throw new CustomPartError(
      `${at}.parameter must be a parameter the rig declares, got ${JSON.stringify(parameter)}`,
    );
  }
  if (physicsOutputs.has(parameter)) {
    throw new CustomPartError(
      `${at}.parameter "${parameter}" is a physics output; an occlusion amount cannot be keyed on one`,
    );
  }

  if (!Array.isArray(stops) || stops.length === 0) {
    throw new CustomPartError(`${at}.stops must be a non-empty array`);
  }
  const { min, max } = descriptor;
  let previous = -Infinity;
  stops.forEach((stop: unknown, k) => {
    const s = `${at}.stops[${k}]`;
    if (!isObject(stop))
      throw new CustomPartError(`${s} must be a plain object`);
    checkedKeys(s, stop, STOP_KEYS, CustomPartError);
    const { value, amount } = stop;
    if (!finite(value)) {
      throw new CustomPartError(
        `${s}.value must be a finite number, got ${JSON.stringify(value)}`,
      );
    }
    if (value < min || value > max) {
      throw new CustomPartError(
        `${s}.value ${value} is outside parameter "${parameter}" range [${min},${max}]`,
      );
    }
    if (value <= previous) {
      throw new CustomPartError(`${s}.value must be strictly ascending`);
    }
    previous = value;
    if (!finite(amount) || amount < 0 || amount > 1) {
      throw new CustomPartError(
        `${s}.amount must be a number in 0..1, got ${JSON.stringify(amount)}`,
      );
    }
  });
}

/** The experiment's cell size (`uniformMesh` at 20 px): a plain grid, so a bake
 *  can later move its vertices freely. */
const CELL_PX = 20;

/** One unrigged part per entry, on `headDeformer` with no warps and no
 *  bindings, placed from the layer's box the way a role's part is. `order`
 *  is left for the caller, who places it among the role parts. */
export function buildCustomParts(
  customParts: CustomPart[],
  canvas: { width: number; height: number },
): IkiPart[] {
  return customParts.map(({ id, layer }) => {
    const b = boxOfPixels(layer.bbox, canvas.width, canvas.height);
    return {
      id,
      color: [1, 1, 1, 1],
      width: bw(b),
      height: bh(b),
      transform: { x: cx(b), y: cy(b) },
      order: 0,
      deformer: "headDeformer",
      mesh: gridMesh(
        Math.max(1, Math.round(bw(b) / CELL_PX)),
        Math.max(1, Math.round(bh(b) / CELL_PX)),
      ),
    };
  });
}

/** Writes each entry's `occlusion` onto its built part, `by` expanded to the
 *  ids its roles yield in this model. Called once the custom parts sit among
 *  the role parts, so a role's clipped or meshless part is found here. */
export function writeOcclusion(
  customParts: CustomPart[],
  built: IkiPart[],
  parts: readonly IkiPart[],
): void {
  const byId = new Map(parts.map((p) => [p.id, p]));
  customParts.forEach((entry, i) => {
    if (entry.occlusion === undefined) return;
    const { by, parameter, stops } = entry.occlusion;
    const ids: string[] = [];
    by.forEach((role, j) => {
      for (const id of partIdsOfRole(role)) {
        const part = byId.get(id);
        if (part === undefined) continue;
        const fault =
          part.clip !== undefined
            ? { is: "is clipped", kind: "a clipped part" }
            : part.mesh === undefined
              ? { is: "has no mesh", kind: "a part without a mesh" }
              : undefined;
        if (fault !== undefined) {
          throw new CustomPartError(
            `customParts[${i}].occlusion.by[${j}] "${role}" yields part "${id}", which ${fault.is}; ${fault.kind} cannot occlude`,
          );
        }
        ids.push(id);
      }
    });
    built[i].occlusion = {
      by: ids,
      parameter,
      stops: stops.map((s) => ({ value: s.value, amount: s.amount })),
    };
  });
}
