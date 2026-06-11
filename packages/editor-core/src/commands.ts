import type {
  IkiDeformer,
  IkiDeformerBinding,
  IkiDeformerTransform,
  IkiGridKeyform,
  IkiMatrixDeformer,
  IkiModel,
  IkiPart,
} from "@iki/format";
import { parseIkiModel } from "@iki/format";

import type { EditorDocument } from "./document";
import { upsertGridKeyform } from "./grid-keyform";
import {
  validateDeformerDelete,
  validateDeformerReparent,
  validatePartAttach,
} from "./reparent";

/**
 * Scan the id-flat namespace (parts first, then deformers) and return which
 * array already holds `id`, or `undefined` if the id is free. Parts and
 * deformers share a single flat id namespace, so both arrays must be checked
 * to produce a source-qualified collision message.
 */
function findIdCollision(
  model: IkiModel,
  id: string,
): "part" | "deformer" | undefined {
  for (const p of model.parts) {
    if (p.id === id) return "part";
  }
  for (const d of model.deformers ?? []) {
    if (d.id === id) return "deformer";
  }
  return undefined;
}

/**
 * One invertible edit. The document is passed IN at apply/invert time — a
 * command is constructed from `(partId, value)` alone, before any document
 * exists — so the same command object can be applied, inverted, and re-applied
 * by the undo/redo stack.
 *
 * Prior-value capture happens exactly ONCE, on the first {@link apply}. `redo`
 * (a second `apply`) reuses that captured value rather than re-reading the
 * current field, so undo always restores the original target.
 */
export interface EditCommand {
  apply(doc: EditorDocument): void;
  invert(doc: EditorDocument): void;
  readonly label: string;
}

/** Channels of {@link IkiTransform} this editor can edit (object-field names,
 *  NOT the binding `IkiTransformChannel` vocabulary). */
export type EditTransformChannel =
  | "x"
  | "y"
  | "rotation"
  | "scaleX"
  | "scaleY"
  | "opacity";

/**
 * Generic single-field command: reads/writes one field of the resolved part via
 * a getter/setter closure, capturing the prior value on the first `apply` and
 * restoring it on `invert`. `T` is the captured value's type; for cloned values
 * (the color tuple) the getter/setter perform the copy.
 */
class FieldCommand<T> implements EditCommand {
  readonly label: string;
  private captured = false;
  private prevValue!: T;

  constructor(
    private readonly partId: string,
    private readonly newValue: T,
    label: string,
    private readonly get: (part: IkiPart) => T,
    private readonly set: (part: IkiPart, value: T) => void,
  ) {
    this.label = label;
  }

  apply(doc: EditorDocument): void {
    const part = doc.findPart(this.partId);
    if (!this.captured) {
      this.prevValue = this.get(part);
      this.captured = true;
    }
    this.set(part, this.newValue);
  }

  invert(doc: EditorDocument): void {
    const part = doc.findPart(this.partId);
    this.set(part, this.prevValue);
  }
}

/** Edit a part's RGBA fill. The 4-tuple is mutable, so the command clones on
 *  construction (caller's array), on capture (part's current color), and on
 *  assign (writing to the part) — it never retains the caller's or model's
 *  array by reference. */
export class SetPartColor extends FieldCommand<
  [number, number, number, number]
> {
  constructor(partId: string, rgba: [number, number, number, number]) {
    super(
      partId,
      [...rgba] as [number, number, number, number],
      "Set color",
      (part) => [...part.color],
      (part, value) => {
        part.color = [...value] as [number, number, number, number];
      },
    );
  }
}

/** Edit a part's width (model-space units). */
export class SetPartWidth extends FieldCommand<number> {
  constructor(partId: string, value: number) {
    super(
      partId,
      value,
      "Set width",
      (part) => part.width,
      (part, v) => {
        part.width = v;
      },
    );
  }
}

/** Edit a part's height (model-space units). */
export class SetPartHeight extends FieldCommand<number> {
  constructor(partId: string, value: number) {
    super(
      partId,
      value,
      "Set height",
      (part) => part.height,
      (part, v) => {
        part.height = v;
      },
    );
  }
}

/** Edit a part's paint order. */
export class SetPartOrder extends FieldCommand<number> {
  constructor(partId: string, value: number) {
    super(
      partId,
      value,
      "Set order",
      (part) => part.order,
      (part, v) => {
        part.order = v;
      },
    );
  }
}

/**
 * Edit one channel of a part's base transform. `x`/`y` are required; the rest
 * are optional and may be absent on the part. For an optional channel the
 * command captures the raw current value INCLUDING `undefined`, and restoring
 * `undefined` DELETES the key so undo returns the part to its original
 * (possibly-omitted) shape. Engine defaults (rotation 0 / scale 1 / opacity 1)
 * are NOT substituted here.
 */
export class SetPartTransform extends FieldCommand<number | undefined> {
  constructor(partId: string, channel: EditTransformChannel, value: number) {
    super(
      partId,
      value,
      "Set transform",
      (part) => part.transform[channel],
      (part, v) => {
        if (v === undefined) {
          delete part.transform[channel];
        } else {
          part.transform[channel] = v;
        }
      },
    );
  }
}

/**
 * Capture the warp deformer's grid as one keyform at the driving parameter
 * `value`, upserting `offsets` into `warps[0].keyforms`. The 4-tuple-style
 * mutable `offsets` array is cloned on construction so a later caller mutation
 * cannot corrupt apply/redo (mirrors {@link SetPartColor}).
 *
 * `apply` validates BEFORE mutating: the deformer must have a grid warp, the
 * offsets length must equal `grid.points.length`, and `value` must lie within
 * the driving parameter's declared `[min,max]` (fail fast, before
 * `parseIkiModel` would reject it). Prior keyforms are deep-copied once on the
 * first `apply` (capture-once like {@link FieldCommand}); `invert` restores
 * that deep copy so re-apply after undo never aliases.
 */
export class CaptureGridKeyform implements EditCommand {
  readonly label = "Capture grid keyform";
  private readonly offsets: number[];
  private captured = false;
  private prevKeyforms!: IkiGridKeyform[];

  constructor(
    private readonly deformerId: string,
    private readonly value: number,
    offsets: number[],
  ) {
    this.offsets = [...offsets];
  }

  apply(doc: EditorDocument): void {
    const deformer = doc.findWarpDeformer(this.deformerId);
    const warp = deformer.warps?.[0];
    if (!warp) {
      throw new Error(
        `deformers."${this.deformerId}".warps: no grid warp to capture into`,
      );
    }
    if (this.offsets.length !== deformer.grid.points.length) {
      throw new Error(
        `deformers."${this.deformerId}".warps[0].keyforms.offsets length ${this.offsets.length} must equal grid.points length ${deformer.grid.points.length}`,
      );
    }
    const param = doc
      .getModel()
      .parameters.find((p) => p.id === warp.parameter);
    if (!param) {
      throw new Error(
        `deformers."${this.deformerId}".warps[0].parameter "${warp.parameter}" is not a declared parameter`,
      );
    }
    if (this.value < param.min || this.value > param.max) {
      throw new Error(
        `deformers."${this.deformerId}".warps[0].keyforms.value ${this.value} is outside parameter "${warp.parameter}" range [${param.min},${param.max}]`,
      );
    }

    if (!this.captured) {
      this.prevKeyforms = structuredClone(warp.keyforms);
      this.captured = true;
    }
    warp.keyforms = upsertGridKeyform(warp.keyforms, this.value, [
      ...this.offsets,
    ]);
  }

  invert(doc: EditorDocument): void {
    const warp = doc.findWarpDeformer(this.deformerId).warps?.[0];
    if (!warp) {
      throw new Error(
        `deformers."${this.deformerId}".warps: no grid warp to restore into`,
      );
    }
    warp.keyforms = structuredClone(this.prevKeyforms);
  }
}

/**
 * Generic single-field command targeting a matrix deformer, mirroring
 * {@link FieldCommand} but resolving via `doc.findMatrixDeformer` instead of
 * `doc.findPart`. Capture-once on first `apply`; restore on `invert`.
 */
class DeformerFieldCommand<T> implements EditCommand {
  readonly label: string;
  private captured = false;
  private prevValue!: T;

  constructor(
    private readonly deformerId: string,
    private readonly newValue: T,
    label: string,
    private readonly get: (deformer: IkiMatrixDeformer) => T,
    private readonly set: (deformer: IkiMatrixDeformer, value: T) => void,
  ) {
    this.label = label;
  }

  apply(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    if (!this.captured) {
      this.prevValue = this.get(deformer);
      this.captured = true;
    }
    this.set(deformer, this.newValue);
  }

  invert(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    this.set(deformer, this.prevValue);
  }
}

/** Edit a matrix deformer's pivot x. */
export class SetDeformerPivotX extends DeformerFieldCommand<number> {
  constructor(deformerId: string, value: number) {
    super(
      deformerId,
      value,
      "Set pivot x",
      (d) => d.pivot.x,
      (d, v) => {
        d.pivot.x = v;
      },
    );
  }
}

/** Edit a matrix deformer's pivot y. */
export class SetDeformerPivotY extends DeformerFieldCommand<number> {
  constructor(deformerId: string, value: number) {
    super(
      deformerId,
      value,
      "Set pivot y",
      (d) => d.pivot.y,
      (d, v) => {
        d.pivot.y = v;
      },
    );
  }
}

/** Channels of {@link IkiDeformerTransform} this editor can edit. */
export type DeformerTransformChannel =
  | "x"
  | "y"
  | "rotation"
  | "scaleX"
  | "scaleY";

/**
 * Edit one channel of a matrix deformer's base transform. Because
 * {@link IkiDeformerTransform} REQUIRES finite `x` and `y`, this command
 * captures and restores the WHOLE prior `transform` object (present or absent)
 * rather than a single channel, so undo can delete the transform when it did
 * not previously exist, and redo never produces a partial object missing `x`/`y`.
 *
 * When no `transform` is present on the deformer, `apply` creates one from
 * the identity base `{ x: 0, y: 0 }` — the minimal valid shape the validator
 * accepts — then writes the edited channel. For example, editing `rotation`
 * on a transform-less deformer yields `{ x: 0, y: 0, rotation: <value> }`.
 */
export class SetDeformerTransform implements EditCommand {
  readonly label = "Set deformer transform";
  private captured = false;
  private prevTransform!: IkiDeformerTransform | undefined;

  constructor(
    private readonly deformerId: string,
    private readonly channel: DeformerTransformChannel,
    private readonly value: number,
  ) {}

  apply(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    if (!this.captured) {
      // Shallow clone is sufficient — IkiDeformerTransform is a flat number map.
      this.prevTransform =
        deformer.transform === undefined
          ? undefined
          : { ...deformer.transform };
      this.captured = true;
    }
    // Start from the existing transform or the identity base. The identity base
    // is { x: 0, y: 0 } because the validator unconditionally requires finite
    // x and y whenever a transform object is present.
    const next: IkiDeformerTransform = {
      ...(deformer.transform ?? { x: 0, y: 0 }),
    };
    next[this.channel] = this.value;
    deformer.transform = next;
  }

  invert(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    if (this.prevTransform === undefined) {
      delete deformer.transform;
    } else {
      // Assign a fresh clone — never alias the captured object so repeated
      // undo/redo cycles cannot corrupt the saved prior value.
      deformer.transform = { ...this.prevTransform };
    }
  }
}

/**
 * Replace a matrix deformer's `bindings` array wholesale. A single command
 * covers add, edit, and remove (pass the desired final array; pass `[]` to
 * remove all). Mirrors {@link CaptureGridKeyform}'s deep-copy discipline:
 * clone-on-construction, capture-once, fresh deep copy on invert.
 *
 * Each {@link IkiDeformerBinding} is a flat object so a per-element spread
 * `{ ...b }` is a sufficient deep copy.
 */
export class SetDeformerBindings implements EditCommand {
  readonly label = "Set deformer bindings";
  private readonly bindings: IkiDeformerBinding[];
  private captured = false;
  private prevBindings!: IkiDeformerBinding[] | undefined;

  constructor(
    private readonly deformerId: string,
    bindings: IkiDeformerBinding[],
  ) {
    // Clone the caller's array on construction — prevents post-execute mutation
    // of the caller's array from corrupting apply/redo.
    this.bindings = bindings.map((b) => ({ ...b }));
  }

  apply(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    if (!this.captured) {
      // Preserve the original absent-vs-empty distinction.
      this.prevBindings =
        deformer.bindings === undefined
          ? undefined
          : deformer.bindings.map((b) => ({ ...b }));
      this.captured = true;
    }
    if (this.bindings.length > 0) {
      // Assign a fresh deep copy — model must never alias the command's stored array.
      deformer.bindings = this.bindings.map((b) => ({ ...b }));
    } else {
      // Delete the key on empty: keeps the model shape minimal and correctly
      // represents "no bindings" as an absent key rather than an empty array.
      delete deformer.bindings;
    }
  }

  invert(doc: EditorDocument): void {
    const deformer = doc.findMatrixDeformer(this.deformerId);
    if (this.prevBindings === undefined) {
      delete deformer.bindings;
    } else {
      // Assign a fresh deep copy — never alias the captured array so re-apply
      // after undo cannot corrupt the saved prior value.
      deformer.bindings = this.prevBindings.map((b) => ({ ...b }));
    }
  }
}

/**
 * Reparent a deformer (matrix or warp) under a new parent, or promote it to
 * root (`newParentId === undefined`). Calls {@link validateDeformerReparent}
 * FIRST so invalid reparents (cycles, warp parent, unknown id) throw before any
 * capture or mutation — a throwing apply leaves the model and undo stack
 * untouched.
 *
 * Absent-vs-present distinction: captures both the prior `parent` value AND
 * whether the key was present on the object, so `invert` can delete the key
 * (restore "absent") rather than blindly assigning `undefined`.
 */
export class SetDeformerParent implements EditCommand {
  readonly label = "Set deformer parent";
  private captured = false;
  private prevParent: string | undefined = undefined;
  private prevHadParent = false;

  constructor(
    private readonly deformerId: string,
    private readonly newParentId: string | undefined,
  ) {}

  apply(doc: EditorDocument): void {
    // Validate FIRST — throws before capture/mutate on any violation.
    validateDeformerReparent(
      doc.getModel().deformers ?? [],
      this.deformerId,
      this.newParentId,
    );
    const deformer = doc.findDeformer(this.deformerId);
    if (!this.captured) {
      this.prevHadParent = Object.prototype.hasOwnProperty.call(
        deformer,
        "parent",
      );
      this.prevParent = deformer.parent;
      this.captured = true;
    }
    if (this.newParentId !== undefined) {
      deformer.parent = this.newParentId;
    } else {
      delete deformer.parent;
    }
  }

  invert(doc: EditorDocument): void {
    const deformer = doc.findDeformer(this.deformerId);
    if (this.prevHadParent) {
      deformer.parent = this.prevParent;
    } else {
      delete deformer.parent;
    }
  }
}

/**
 * Add a new part to the model. Validates the candidate model with
 * {@link parseIkiModel} BEFORE mutating, so a structurally invalid part
 * (bad color tuple, missing required fields, id collision with a deformer)
 * throws an `IkiFormatError` and leaves the model untouched.
 *
 * Captures the prior base-UV entry for the part's id on the FIRST apply so
 * invert can restore the exact pre-add state. This guards the id-reuse hazard:
 * DeletePart(X) → AddPart(X′, different mesh) → undo(add) → undo(delete) —
 * without restore, X's constructor-captured base would be gone, causing
 * applyAtlas to fail when X is restored by the undo of the delete.
 */
export class AddPart implements EditCommand {
  readonly label = "Add part";
  private readonly part: IkiPart;
  private captured = false;
  private prevBaseMeshUvs: number[] | undefined = undefined;

  constructor(part: IkiPart) {
    // Clone on construction — prevents caller mutation from corrupting apply/redo.
    this.part = structuredClone(part);
  }

  apply(doc: EditorDocument): void {
    // (a) Cheap id-uniqueness pre-check with a source-qualified message.
    const hit = findIdCollision(doc.getModel(), this.part.id);
    if (hit === "part") {
      throw new Error(
        `parts: id "${this.part.id}" collides with an existing part id`,
      );
    }
    if (hit === "deformer") {
      throw new Error(
        `parts: id "${this.part.id}" collides with an existing deformer id`,
      );
    }

    // (b) Full structural validation on a candidate clone — propagate
    //     IkiFormatError unchanged so the caller gets a path-qualified message.
    const candidate = structuredClone(doc.getModel());
    candidate.parts.push(structuredClone(this.part));
    parseIkiModel(candidate);

    // (c) All checks pass — mutate the real model with a fresh clone so the
    //     model never aliases the command's stored part.
    doc.getModel().parts.push(structuredClone(this.part));

    // Register base mesh UVs so applyAtlas can remap this part. Capture the
    // prior entry on the FIRST apply only — redo must NOT re-capture or it
    // would clobber the saved prior and make invert unable to restore correctly.
    const prev = doc.captureBaseMeshUvs(this.part.id);
    if (!this.captured) {
      this.prevBaseMeshUvs = prev;
      this.captured = true;
    }
  }

  invert(doc: EditorDocument): void {
    const parts = doc.getModel().parts;
    const i = parts.findIndex((p) => p.id === this.part.id);
    if (i !== -1) parts.splice(i, 1);
    // Restore the exact prior base-UV state so a constructor-captured entry for
    // a deleted part with this id survives the undo of the add.
    doc.restoreBaseMeshUvs(this.part.id, this.prevBaseMeshUvs);
  }
}

/**
 * Add a new deformer (matrix or warp) to the model. Validates the candidate
 * model with {@link parseIkiModel} BEFORE mutating — this enforces the warp
 * rest-grid invariant, points length, pivot, parent, and bindings without
 * hand-rolling partial checks. Mirrors {@link AddPart} but also tracks whether
 * `model.deformers` was absent before the first apply, so `invert` can restore
 * the exact key-absence state (mirrors {@link SetDeformerBindings}).
 */
export class AddDeformer implements EditCommand {
  readonly label = "Add deformer";
  private readonly deformer: IkiDeformer;
  private captured = false;
  private prevDeformersAbsent = false;

  constructor(deformer: IkiDeformer) {
    // Clone on construction — prevents caller mutation from corrupting apply/redo.
    this.deformer = structuredClone(deformer);
  }

  apply(doc: EditorDocument): void {
    const model = doc.getModel();

    // (a) Cheap id-uniqueness pre-check with a source-qualified message.
    const hit = findIdCollision(model, this.deformer.id);
    if (hit === "deformer") {
      throw new Error(
        `deformers: id "${this.deformer.id}" collides with an existing deformer id`,
      );
    }
    if (hit === "part") {
      throw new Error(
        `deformers: id "${this.deformer.id}" collides with an existing part id`,
      );
    }

    // (b) Full structural validation on a candidate clone.
    const candidate = structuredClone(model);
    candidate.deformers = [
      ...(candidate.deformers ?? []),
      structuredClone(this.deformer),
    ];
    parseIkiModel(candidate);

    // (c) All checks pass — capture-once, then mutate.
    if (!this.captured) {
      this.prevDeformersAbsent = model.deformers === undefined;
      this.captured = true;
    }
    if (model.deformers === undefined) {
      model.deformers = [];
    }
    model.deformers.push(structuredClone(this.deformer));
  }

  invert(doc: EditorDocument): void {
    const model = doc.getModel();
    const arr = model.deformers;
    if (!arr) return;
    const i = arr.findIndex((d) => d.id === this.deformer.id);
    if (i !== -1) arr.splice(i, 1);
    // Restore the absent-vs-present distinction. If deformers did not exist
    // before apply, delete the key once the array is empty again.
    if (this.prevDeformersAbsent && arr.length === 0) {
      delete model.deformers;
    }
  }
}

/**
 * Delete a part by id, preserving its original array slot so `invert` restores
 * it at the same position. Slot position is cosmetic (the renderer uses the
 * `order` field for paint ordering), but restoring the index keeps undo
 * visually predictable.
 *
 * No `parseIkiModel` pre-check is needed: removing an element from an already-
 * valid model cannot introduce a structural violation. Nothing in the model
 * contract references a part by id, so there are no dangling-ref hazards.
 *
 * Texture-reference safety (editor-core invariant): `apply` refuses to delete a
 * part that still carries `part.texture`. Texture/atlas state is non-undoable
 * per the 5b boundary; clear the texture first via
 * {@link EditorDocument.clearPartTextureRef} (model-committed) or
 * {@link EditorDocument.applyAtlas} with no assignment (imported) — both are
 * non-undoable. By the time a part is deletable it carries no texture, so
 * `invert` can never restore a stale texture index that would render the wrong
 * atlas region after a later atlas repack. No transactional atlas capture is
 * needed in this command.
 */
export class DeletePart implements EditCommand {
  readonly label = "Delete part";
  private captured = false;
  private removed!: IkiPart;
  private index!: number;

  constructor(private readonly partId: string) {}

  apply(doc: EditorDocument): void {
    // Validate FIRST — throws with path-qualified message if unknown.
    const part = doc.findPart(this.partId);

    // Texture guard — enforced at the editor-core boundary so public callers
    // cannot bypass it (the example store adds a friendly pre-check, but this
    // is the real invariant). Throw before any capture or mutation.
    if (part.texture !== undefined) {
      throw new Error(
        `parts."${this.partId}": cannot delete — part has a texture reference; clear its texture first`,
      );
    }

    const parts = doc.getModel().parts;
    const i = parts.indexOf(part);
    if (!this.captured) {
      this.removed = structuredClone(part);
      this.index = i;
      this.captured = true;
    }
    parts.splice(i, 1);
  }

  invert(doc: EditorDocument): void {
    // Restore at the original slot — exact deep restore including bindings and
    // mesh. No texture key is present (apply enforced that invariant before
    // capture), so the snapshot is always atlas-safe on restore.
    doc.getModel().parts.splice(this.index, 0, structuredClone(this.removed));
  }
}

/**
 * Delete a deformer by id. Calls {@link validateDeformerDelete} FIRST so the
 * delete is refused when other deformers are parented to it or parts are still
 * attached — enforcing the same referential safety as {@link SetDeformerParent}
 * and {@link SetPartDeformer}.
 *
 * `invert` re-inserts the deformer at its original index. The `??=` on
 * `model.deformers` is defensive — a deformer existed to delete so the array is
 * guaranteed present, but avoids a runtime crash if the model is in an
 * unexpected state.
 */
export class DeleteDeformer implements EditCommand {
  readonly label = "Delete deformer";
  private captured = false;
  private removed!: IkiDeformer;
  private index!: number;

  constructor(private readonly deformerId: string) {}

  apply(doc: EditorDocument): void {
    const model = doc.getModel();
    // Validate FIRST — throws before capture/mutate on any referential violation.
    validateDeformerDelete(model.deformers ?? [], model.parts, this.deformerId);
    // validateDeformerDelete guarantees the deformer (and thus the array) exists.
    const arr = model.deformers!;
    const i = arr.findIndex((d) => d.id === this.deformerId);
    if (!this.captured) {
      this.removed = structuredClone(arr[i]);
      this.index = i;
      this.captured = true;
    }
    arr.splice(i, 1);
  }

  invert(doc: EditorDocument): void {
    // Re-insert at the original slot. `??=` is defensive — deformers must
    // already be present given a deformer existed to delete.
    (doc.getModel().deformers ??= []).splice(
      this.index,
      0,
      structuredClone(this.removed),
    );
  }
}

/**
 * Attach a part to a deformer, or detach it (`newDeformerId === undefined`).
 * Calls {@link validatePartAttach} FIRST so invalid attachments (warp without
 * mesh, unknown ids) throw before any capture or mutation.
 *
 * Absent-vs-present distinction mirrors {@link SetDeformerParent}: captures
 * both the prior `deformer` value and whether the key was present, so `invert`
 * can delete the key rather than assigning `undefined`.
 */
export class SetPartDeformer implements EditCommand {
  readonly label = "Set part deformer";
  private captured = false;
  private prevDeformer: string | undefined = undefined;
  private prevHadDeformer = false;

  constructor(
    private readonly partId: string,
    private readonly newDeformerId: string | undefined,
  ) {}

  apply(doc: EditorDocument): void {
    // Validate FIRST — throws before capture/mutate on any violation.
    validatePartAttach(
      doc.getModel().deformers ?? [],
      this.partId,
      doc.getModel().parts,
      this.newDeformerId,
    );
    const part = doc.findPart(this.partId);
    if (!this.captured) {
      this.prevHadDeformer = Object.prototype.hasOwnProperty.call(
        part,
        "deformer",
      );
      this.prevDeformer = part.deformer;
      this.captured = true;
    }
    if (this.newDeformerId !== undefined) {
      part.deformer = this.newDeformerId;
    } else {
      delete part.deformer;
    }
  }

  invert(doc: EditorDocument): void {
    const part = doc.findPart(this.partId);
    if (this.prevHadDeformer) {
      part.deformer = this.prevDeformer;
    } else {
      delete part.deformer;
    }
  }
}
