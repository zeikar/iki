import type {
  IkiDeformerBinding,
  IkiDeformerTransform,
  IkiGridKeyform,
  IkiMatrixDeformer,
  IkiPart,
} from "@iki/format";

import type { EditorDocument } from "./document";
import { upsertGridKeyform } from "./grid-keyform";
import { validateDeformerReparent, validatePartAttach } from "./reparent";

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
