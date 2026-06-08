import { parseIkiModel } from "@iki/format";
import type {
  IkiModel,
  IkiPart,
  IkiTexture,
  IkiUvRect,
  IkiWarpDeformer,
} from "@iki/format";

import type { EditCommand } from "./commands";
import { remapMeshUvsToRect } from "./mesh-uv";

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
  /** Editor-only session state, never serialized; keyed by stable part id. The
   *  unmodified BASE local uvs of every mesh part, captured once at construction
   *  so atlas remaps always derive from the original (idempotent). */
  private readonly baseMeshUvs = new Map<string, number[]>();

  constructor(model: IkiModel) {
    this.model = structuredClone(model);
    // Capture-once base UVs. Scope: assumes the loaded model's mesh parts carry
    // original LOCAL 0..1 uvs (true for the sample). Restoring base UVs after
    // reloading an already-textured exported model is out of scope (deferred —
    // needs project-file persistence).
    for (const part of this.model.parts) {
      if (part.mesh) {
        this.baseMeshUvs.set(part.id, part.mesh.uvs.slice());
      }
    }
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

  /** Resolve a warp deformer by stable id. Throws a path-qualified plain
   *  `Error` if no deformer matches the id or the match is not a warp deformer.
   *  READ/mutate-through accessor, consistent with {@link findPart}. */
  findWarpDeformer(id: string): IkiWarpDeformer {
    const deformer = this.model.deformers?.find((d) => d.id === id);
    if (!deformer || deformer.kind !== "warp") {
      throw new Error(`deformers: no warp deformer with id "${id}"`);
    }
    return deformer;
  }

  /** The construction-captured base UVs for a mesh part. Throws a path-qualified
   *  plain `Error` if absent. SINGLE accessor for both apply branches — never
   *  read `baseMeshUvs` with a bare `!` elsewhere. */
  private requireBaseUvs(partId: string): number[] {
    const base = this.baseMeshUvs.get(partId);
    if (!base) {
      throw new Error(`parts: no base mesh uvs captured for part "${partId}"`);
    }
    return base;
  }

  /**
   * Replace the atlas table and rewrite every part's texture reference in a
   * single atomic step. For every part in `partTextureAssignments` set
   * `texture = { index: 0, uv }`; CLEAR `texture` (delete the key) on every
   * other part.
   *
   * Mesh parts are textured as a MATCHED PAIR: an assigned mesh part also has
   * its per-vertex `mesh.uvs` remapped (from the construction-captured base)
   * into the same `uv` rect; an unassigned mesh part has its `mesh.uvs` restored
   * to that base. Quad parts carry `texture.uv` only and are untouched here.
   *
   * Deliberately NON-undoable: it does NOT push to or clear the undo/redo
   * stacks (texture/atlas state is not undoable in 5b — the unified
   * editor-state superset is deferred to 5d). `canUndo()`/`canRedo()` are
   * unchanged after a call.
   *
   * Validate-all-then-apply: structural input validation, per-partId
   * resolution, and a base-UV preflight over every mesh part all run BEFORE any
   * mutation, so a bad input (wrong shape, duplicate partId, unknown partId, or
   * a mesh part with no captured base) throws a plain `Error` and leaves the
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

    // Step C — preflight base UVs for EVERY mesh part (assigned AND unassigned):
    // the mutate loop's clear/restore branch also reads the base of unassigned
    // mesh parts, so this guard must cover them before any write so atomicity
    // (validate-all-then-apply) holds.
    for (const part of this.model.parts) {
      if (part.mesh) {
        this.requireBaseUvs(part.id);
      }
    }

    // Mutate — only reached when A + B + C all pass.
    this.model.textures =
      texture === undefined ? undefined : [{ source: texture.source }];
    for (const part of this.model.parts) {
      const uv = resolved.get(part);
      if (uv) {
        part.texture = {
          index: 0,
          uv: { x: uv.x, y: uv.y, width: uv.width, height: uv.height },
        };
        if (part.mesh) {
          // Replace the mesh object so each part owns its own uvs array —
          // de-aliases parts that shared the same mesh object in the input model.
          part.mesh = {
            ...part.mesh,
            uvs: remapMeshUvsToRect(this.requireBaseUvs(part.id), uv),
          };
        }
      } else {
        delete part.texture;
        if (part.mesh) {
          // Same spread here to break aliasing on restore as well.
          part.mesh = {
            ...part.mesh,
            uvs: this.requireBaseUvs(part.id).slice(),
          };
        }
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
