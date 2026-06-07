import { parseIkiModel } from "@iki/format";
import type { IkiModel, IkiPart, IkiTexture, IkiUvRect } from "@iki/format";

import type { EditCommand } from "./commands";

/**
 * One part mapped to an imported atlas source. `index` is always 0 because the
 * atlas is a single page; only the `uv` sub-rectangle varies per part.
 */
export interface AtlasAssignment {
  partId: string;
  uv: IkiUvRect;
}

/** Input to {@link EditorDocument.applyAtlas}: the new atlas table plus the
 *  per-part UV assignments into it. */
export interface ApplyAtlasInput {
  textures: IkiTexture[];
  partTextureAssignments: AtlasAssignment[];
}

/**
 * In-memory editing session over a single {@link IkiModel}. The model is held
 * directly (no superset) and mutated in place by invertible {@link EditCommand}s
 * pushed through {@link execute}; undo/redo invert/re-apply them.
 *
 * The constructor `structuredClone`s the input so the caller's model is never
 * mutated. Parts are addressed by stable `id`, never by array index.
 */
export class EditorDocument {
  private readonly model: IkiModel;
  private readonly undoStack: EditCommand[] = [];
  private readonly redoStack: EditCommand[] = [];

  constructor(model: IkiModel) {
    this.model = structuredClone(model);
  }

  /** Live reference to the working model — for READ access. Mutate it only
   *  through {@link execute}/{@link undo}/{@link redo}. */
  getModel(): IkiModel {
    return this.model;
  }

  /** Resolve a part by stable id. Throws a plain `Error` (NOT an
   *  `IkiFormatError`) with a path-qualified message if the id is unknown. */
  findPart(id: string): IkiPart {
    const part = this.model.parts.find((p) => p.id === id);
    if (!part) {
      throw new Error(`parts: no part with id "${id}"`);
    }
    return part;
  }

  /**
   * Replace the atlas table and rewrite every part's texture reference in a
   * single atomic step. For every part in `partTextureAssignments` set
   * `texture = { index: 0, uv }`; CLEAR `texture` (delete the key) on every
   * other part.
   *
   * Deliberately NON-undoable: it does NOT push to or clear the undo/redo
   * stacks (texture/atlas state is not undoable in 5b — the unified
   * editor-state superset is deferred to 5d). `canUndo()`/`canRedo()` are
   * unchanged after a call.
   *
   * Validate-all-then-apply: structural input validation and per-partId
   * resolution both run BEFORE any mutation, so a bad input (wrong shape,
   * duplicate partId, or unknown partId) throws a plain `Error` and leaves the
   * model exactly as it was — never a partial application.
   */
  applyAtlas(input: ApplyAtlasInput): void {
    // Step A — structural validation of the input shape.
    const { texture, assignmentsByPart } = this.normalizeAtlasInput(input);

    // Step B — resolve every partId before mutating anything.
    const resolved = new Map<IkiPart, IkiUvRect>();
    for (const [partId, uv] of assignmentsByPart) {
      resolved.set(this.findPart(partId), uv);
    }

    // Mutate — only reached when A + B both pass.
    this.model.textures =
      texture === undefined ? undefined : [{ source: texture.source }];
    for (const part of this.model.parts) {
      const uv = resolved.get(part);
      if (uv) {
        part.texture = {
          index: 0,
          uv: { x: uv.x, y: uv.y, width: uv.width, height: uv.height },
        };
      } else {
        delete part.texture;
      }
    }
  }

  /**
   * Validate the structural shape of an {@link ApplyAtlasInput} without
   * touching the model, returning a known-good `{ texture?, assignmentsByPart }`
   * for {@link applyAtlas} to resolve and apply.
   */
  private normalizeAtlasInput(input: ApplyAtlasInput): {
    texture?: IkiTexture;
    assignmentsByPart: Map<string, IkiUvRect>;
  } {
    if (input.textures.length > 1) {
      throw new Error(
        `applyAtlas: textures must be a single atlas page (got ${input.textures.length})`,
      );
    }
    if (
      input.partTextureAssignments.length > 0 &&
      input.textures.length !== 1
    ) {
      throw new Error(
        "applyAtlas: partTextureAssignments require exactly one texture",
      );
    }

    const assignmentsByPart = new Map<string, IkiUvRect>();
    for (const { partId, uv } of input.partTextureAssignments) {
      if (assignmentsByPart.has(partId)) {
        throw new Error(
          `applyAtlas: duplicate partId "${partId}" in partTextureAssignments`,
        );
      }
      assignmentsByPart.set(partId, uv);
    }

    return { texture: input.textures[0], assignmentsByPart };
  }

  /** Apply a command and record it as one undo step. Clears the redo stack. */
  execute(cmd: EditCommand): void {
    cmd.apply(this);
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
  }

  /** Invert the most recent command and move it onto the redo stack. */
  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.invert(this);
    this.redoStack.push(cmd);
  }

  /** Re-apply the most recently undone command and move it back onto undo. */
  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.apply(this);
    this.undoStack.push(cmd);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Validate and export the current working model by running it through
   * {@link parseIkiModel}. Uses `structuredClone` so the validator's
   * normalized output cannot alias the working model. Propagates
   * `IkiFormatError` unchanged on failure — callers surface `.message`.
   */
  toIkiModel(): IkiModel {
    return parseIkiModel(structuredClone(this.model));
  }

  /**
   * Pretty-print the validated model as a `.iki` JSON string. Always
   * validates first — invalid documents never reach a file.
   */
  serialize(): string {
    return JSON.stringify(this.toIkiModel(), null, 2);
  }
}
