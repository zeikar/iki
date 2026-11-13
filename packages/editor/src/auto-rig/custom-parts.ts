/**
 * The `customParts` generator input. Every entry is checked before anything
 * is rigged, so a refusal rigs nothing; each message starts at the path of the
 * field (`customParts[i].tie`).
 */

import type { IkiPart } from "@ikijs/format";
import { bh, boxOfPixels, bw, cx, cy, gridMesh } from "./layout";
import { ROLE_TABLE, partIdsOfRole } from "./roles";
import { checkedKeys } from "./solve";
import { CustomPartError, type CustomPart, type LayerInput } from "./types";

const KEYS = ["id", "layer", "anchor", "tie", "after", "deformer"];
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
    const { id, layer, anchor, tie, after, deformer } = entry;

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
  });
  return customParts as CustomPart[];
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
