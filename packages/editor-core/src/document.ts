import type { IkiModel, IkiPart } from "@iki/format";

import type { EditCommand } from "./commands";

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
}
