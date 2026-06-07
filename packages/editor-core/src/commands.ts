import type { IkiPart } from "@iki/format";

import type { EditorDocument } from "./document";

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
