import { parseIkiModel } from "@iki/format";
import type {
  IkiDeformer,
  IkiDeformerTransform,
  IkiMatrixDeformer,
  IkiModel,
  IkiPart,
  IkiTexture,
  IkiTransform,
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

  /** Resolve a matrix deformer by stable id. Throws a path-qualified plain
   *  `Error` if no deformer matches the id or the match is a warp deformer
   *  (`kind === "warp"`). A `kind` of `"matrix"` or `undefined` is a matrix
   *  deformer. READ/mutate-through accessor, consistent with {@link findPart}. */
  findMatrixDeformer(id: string): IkiMatrixDeformer {
    const deformer = this.model.deformers?.find((d) => d.id === id);
    if (!deformer || deformer.kind === "warp") {
      throw new Error(`deformers: no matrix deformer with id "${id}"`);
    }
    return deformer;
  }

  /** Resolve any deformer (matrix or warp) by stable id. Throws a
   *  path-qualified plain `Error` if no deformer matches the id.
   *  READ/mutate-through accessor, consistent with {@link findPart}. */
  findDeformer(id: string): IkiDeformer {
    const deformer = this.model.deformers?.find((d) => d.id === id);
    if (!deformer) {
      throw new Error(`deformers: no deformer with id "${id}"`);
    }
    return deformer;
  }

  /**
   * Record the base mesh UVs for a part inserted AFTER construction (e.g. by
   * {@link AddPart}). Returns the PRIOR entry for that id (or `undefined` if
   * none existed) so the caller can restore it on undo. No-op for meshless
   * parts (returns `undefined`). Must be called by any command that pushes a
   * mesh part into the model so the part joins the constructor-captured base-UV
   * side state required by {@link applyAtlas}.
   *
   * The returned prior value is what {@link restoreBaseMeshUvs} expects on
   * undo — pass it verbatim. Hazard guarded: DeletePart(X) → AddPart(X′) →
   * undo(add) → undo(delete); without restore, X's constructor-captured entry
   * would be permanently gone after undo of the add, causing applyAtlas to
   * fail when X is restored.
   */
  captureBaseMeshUvs(partId: string): number[] | undefined {
    const prev = this.baseMeshUvs.get(partId);
    const part = this.model.parts.find((p) => p.id === partId);
    if (part?.mesh) {
      this.baseMeshUvs.set(partId, part.mesh.uvs.slice());
    }
    return prev;
  }

  /**
   * Restore the base-UV side state to exactly what it was before a
   * {@link captureBaseMeshUvs} call. Called from {@link AddPart.invert}:
   * pass the value returned by captureBaseMeshUvs on first apply.
   * - `prev` is `number[]` → sets the entry (restores a prior mesh's base).
   * - `prev` is `undefined` → deletes the entry (no entry existed before the
   *   add, so a later different-mesh part reusing the id must not inherit this
   *   one's base).
   * DeletePart does NOT call this — the entry persists across delete/undo so
   * the restored part still has its base available for applyAtlas.
   */
  restoreBaseMeshUvs(partId: string, prev: number[] | undefined): void {
    if (prev !== undefined) {
      this.baseMeshUvs.set(partId, prev);
    } else {
      this.baseMeshUvs.delete(partId);
    }
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
   * Clear a model-committed texture reference from a single part. Deliberately
   * NON-undoable, matching {@link applyAtlas} — texture/atlas state is not in
   * the undo model (unified editor-state is deferred). Does NOT push to or
   * clear the undo/redo stacks. Does NOT touch `mesh.uvs` — atlas-space UVs on
   * an untextured mesh are inert for color rendering; a later atlas import
   * remaps from the base UVs anyway.
   *
   * This is the single consistent texture/atlas undo boundary: by the time a
   * part is deletable (no texture), its DeletePart snapshot carries no texture
   * reference, so no stale index can resurface on undo after a later atlas
   * repack.
   *
   * Throws a path-qualified plain `Error` (NOT `IkiFormatError`) if the part
   * id is unknown — same contract as {@link findPart}.
   */
  clearPartTextureRef(partId: string): void {
    const part = this.findPart(partId);
    delete part.texture;
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

  /**
   * Overwrite a part's whole transform with a fresh copy of `transform`.
   * Replacing the whole object (rather than individual channels) preserves any
   * optional keys already absent from the incoming value.
   *
   * Deliberately NON-undoable — used ONLY for the editor's transient capture
   * pose. Does NOT push to or clear undoStack/redoStack (sibling to
   * {@link applyAtlas}'s non-undoable boundary). The caller is responsible for
   * restoring the exact prior snapshot when the capture pose ends.
   *
   * `IkiTransform` is a flat number map, so a shallow spread is a sufficient
   * deep copy — no aliasing of the caller's object remains.
   */
  setPartTransformEphemeral(partId: string, transform: IkiTransform): void {
    const part = this.findPart(partId);
    part.transform = { ...transform };
  }

  /**
   * Overwrite a matrix deformer's optional transform with a fresh copy, or
   * delete it when `transform` is `undefined`.
   * `undefined` deletes the key, restoring the deformer to the same state as
   * one that never had a transform (absent-vs-present matters for downstream
   * renderers).
   *
   * Deliberately NON-undoable — used ONLY for the editor's transient capture
   * pose. Does NOT push to or clear undoStack/redoStack (sibling to
   * {@link applyAtlas}'s non-undoable boundary). The caller is responsible for
   * restoring the exact prior snapshot when the capture pose ends.
   *
   * `IkiDeformerTransform` is a flat number map, so a shallow spread is a
   * sufficient deep copy — no aliasing of the caller's object remains.
   */
  setDeformerTransformEphemeral(
    deformerId: string,
    transform: IkiDeformerTransform | undefined,
  ): void {
    const deformer = this.findMatrixDeformer(deformerId);
    if (transform === undefined) {
      delete deformer.transform;
    } else {
      deformer.transform = { ...transform };
    }
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
