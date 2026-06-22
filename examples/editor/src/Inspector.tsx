import {
  AddPhysicsRig,
  DeletePhysicsRig,
  SetDeformerBindings,
  SetDeformerParent,
  SetDeformerPivotX,
  SetDeformerPivotY,
  SetDeformerTransform,
  SetPartBindings,
  SetPartColor,
  SetPartDeformer,
  SetPartHeight,
  SetPartOrder,
  SetPartTransform,
  SetPartWidth,
  SetPhysicsRig,
  type DeformerTransformChannel,
  type EditCommand,
  type EditTransformChannel,
} from "@iki/editor-core";
import type {
  IkiBinding,
  IkiDeformer,
  IkiDeformerBinding,
  IkiMatrixChannel,
  IkiMatrixDeformer,
  IkiModel,
  IkiPart,
  IkiPhysics,
  IkiTransformChannel,
} from "@iki/format";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { decodeImageFile } from "./atlas-image";
import { useEditorStore } from "./store";

/**
 * Engine transform defaults (verified in the engine's `deform.ts`). DISPLAYED
 * when the part omits an OPTIONAL channel, so the input is never blank — but a
 * command is only dispatched when the user actually edits. Only the optional
 * channels (`rotation`/`scaleX`/`scaleY`/`opacity`) ever fall back here; `x`/`y`
 * are required on `IkiTransform`, so their entries exist solely to type the map
 * over the full channel vocabulary and are never used as fallbacks.
 */
const TRANSFORM_DEFAULTS: Record<EditTransformChannel, number> = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
};

/**
 * Engine transform defaults for a matrix deformer (same as parts minus opacity,
 * which a matrix cannot represent). DISPLAYED when the deformer omits an
 * OPTIONAL channel; a `SetDeformerTransform` command is only dispatched on edit.
 */
const DEFORMER_TRANSFORM_DEFAULTS: Record<DeformerTransformChannel, number> = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

/** The five matrix-channel binding literals, in display order. */
const MATRIX_CHANNELS: IkiMatrixChannel[] = [
  "translateX",
  "translateY",
  "rotate",
  "scaleX",
  "scaleY",
];

/** The six part-channel binding literals, in display order. */
const PART_CHANNELS: IkiTransformChannel[] = [
  "translateX",
  "translateY",
  "rotate",
  "scaleX",
  "scaleY",
  "opacity",
];

const inputStyle: CSSProperties = {
  width: 80,
  background: "#101116",
  border: "1px solid #2a2b33",
  borderRadius: 4,
  color: "#e6e6ee",
  padding: "4px 6px",
  fontSize: 13,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const labelStyle: CSSProperties = { fontSize: 12, color: "#9a9aa5" };

const selectStyle: CSSProperties = {
  background: "#101116",
  border: "1px solid #2a2b33",
  borderRadius: 4,
  color: "#e6e6ee",
  padding: "4px 6px",
  fontSize: 13,
};

const smallBtnStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "2px 8px",
  fontSize: 12,
  background: "#1e1e2a",
  border: "1px solid #3a3b47",
  borderRadius: 4,
  color: "#e6e6ee",
  cursor: "pointer",
};

const removeBtnStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "2px 8px",
  fontSize: 12,
  background: "#2a1a1a",
  border: "1px solid #7a2a2a",
  borderRadius: 4,
  color: "#f08080",
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  background: "#3a1a1a",
  border: "1px solid #7a2a2a",
  borderRadius: 4,
  color: "#f08080",
  fontSize: 12,
  wordBreak: "break-word",
};

/**
 * Numeric property panel for the selected part's lean-5a fields. Each edit
 * dispatches the matching editor-core command through the store, which mutates
 * the document and bumps `revision`; `useReloadPreview` debounces and reloads.
 */
export function Inspector() {
  const selectedPartId = useEditorStore((s) => s.selectedPartId);
  const selectedDeformerId = useEditorStore((s) => s.selectedDeformerId);
  const runCommand = useEditorStore((s) => s.runCommand);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  // `revision` subscribes the panel to in-place document mutations.
  const part = useEditorStore((s) => {
    void s.revision;
    return s.selectedPartId
      ? (s.doc.getModel().parts.find((p) => p.id === s.selectedPartId) ?? null)
      : null;
  });
  // NEW 5e deformer path: subscribe to `doc` + scalar `revision` separately and
  // read the live model in the RENDER BODY. A selector returning the live model
  // (a stable reference after in-place edits) would not re-render on a revision
  // bump, and one returning a fresh object would infinite-loop useSyncExternalStore.
  const doc = useEditorStore((s) => s.doc);
  const revision = useEditorStore((s) => s.revision);
  void revision;
  const model = doc.getModel();
  const deformer =
    model.deformers?.find((d) => d.id === selectedDeformerId) ?? null;
  const deletePart = useEditorStore((s) => s.deletePart);
  const deleteDeformer = useEditorStore((s) => s.deleteDeformer);
  const canUndo = useEditorStore((s) => {
    void s.revision;
    return s.doc.canUndo();
  });
  const canRedo = useEditorStore((s) => {
    void s.revision;
    return s.doc.canRedo();
  });
  const importLayerSet = useEditorStore((s) => s.importLayerSet);
  const generatorError = useEditorStore((s) => s.generatorError);
  const importing = useEditorStore((s) => s.importing);
  const layerSetInputRef = useRef<HTMLInputElement>(null);

  function onLayerSetInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.currentTarget.files;
    if (files && files.length > 0) {
      void importLayerSet([...files]);
      // Reset so re-selecting the same set re-triggers the change event.
      e.currentTarget.value = "";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={undo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={redo} disabled={!canRedo}>
          Redo
        </button>
      </div>

      {/* Model-level: auto-rig from named PNG layers */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={labelStyle}>Auto-rig from layers</span>
        <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
          Named PNG layers: face, eye_L, eye_R, mouth, … or a single .psd
        </p>
        <input
          ref={layerSetInputRef}
          type="file"
          multiple
          accept="image/png,.psd"
          style={{ display: "none" }}
          onChange={onLayerSetInputChange}
        />
        <button
          type="button"
          onClick={() => layerSetInputRef.current?.click()}
          disabled={importing}
          style={smallBtnStyle}
        >
          {importing ? "Importing…" : "Import layer set"}
        </button>
        {generatorError && <p style={errorStyle}>{generatorError}</p>}
      </div>

      {/* Model-level: physics rig CRUD + tuning */}
      <PhysicsRigsEditor model={model} runCommand={runCommand} />

      {selectedDeformerId ? (
        deformer ? (
          <DeformerPanel
            deformer={deformer}
            model={model}
            runCommand={runCommand}
            deleteDeformer={deleteDeformer}
          />
        ) : (
          <p style={labelStyle}>Select a part or deformer to edit.</p>
        )
      ) : selectedPartId && part ? (
        <PartFields
          part={part}
          model={model}
          runCommand={runCommand}
          deletePart={deletePart}
        />
      ) : (
        <p style={labelStyle}>Select a part or deformer to edit.</p>
      )}
    </div>
  );
}

// ── Physics rigs (model-level authoring) ─────────────────────────────────────

/** Scalar fields of a physics rig editable via draft-state inputs. `weight` and
 *  `scale` live under the nested `input`/`output`; the rest are top-level. */
type PhysicsScalar = "weight" | "scale" | "mass" | "stiffness" | "damping";

/** Return a deep-cloned rig with one scalar overwritten — never aliases the
 *  nested `input`/`output` objects. */
function withPhysicsScalar(
  rig: IkiPhysics,
  field: PhysicsScalar,
  value: number,
): IkiPhysics {
  const next = structuredClone(rig);
  if (field === "weight") next.input.weight = value;
  else if (field === "scale") next.output.scale = value;
  else next[field] = value;
  return next;
}

/**
 * Build a valid default rig for the Add button, or `null` when no valid pair
 * exists. A candidate `(input, output)` is valid iff (parsePhysics's per-rig +
 * cross-rig rules): input !== output; output is not an existing output; output
 * is not an existing input; AND input is not an existing output — because no rig
 * output may be used as any rig input (feedback both ways). Searches ALL ordered
 * pairs rather than greedily fixing input first.
 */
function defaultPhysicsRig(model: IkiModel): IkiPhysics | null {
  const physics = model.physics ?? [];
  const params = model.parameters;
  const existingOutputs = new Set(physics.map((r) => r.output.parameter));
  const existingInputs = new Set(physics.map((r) => r.input.parameter));

  let pair: { input: string; output: string } | null = null;
  for (const input of params) {
    if (existingOutputs.has(input.id)) continue; // input can't be an existing output
    for (const output of params) {
      if (
        input.id !== output.id &&
        !existingOutputs.has(output.id) &&
        !existingInputs.has(output.id)
      ) {
        pair = { input: input.id, output: output.id };
        break;
      }
    }
    if (pair) break;
  }
  if (!pair) return null;

  const ids = new Set(physics.map((r) => r.id));
  let n = physics.length + 1;
  let id = `physics-${n}`;
  while (ids.has(id)) id = `physics-${++n}`;
  return {
    id,
    input: { parameter: pair.input, weight: 1 },
    output: { parameter: pair.output, scale: -10 },
    mass: 1,
    stiffness: 80,
    damping: 10,
  };
}

/**
 * One physics scalar input with LOCAL DRAFT state. The committed value comes
 * from the parent rig; `onChange` updates ONLY the draft text (so a transient
 * "" or "-" never reaches the validate-before-mutate command). The edit commits
 * on blur/Enter only when the draft parses to a finite number that DIFFERS from
 * the current value (idempotent — avoids a double undo when Enter then blur).
 * A `text` input (not `number`) preserves a mid-edit "-" as raw draft text.
 * When `onCommit` returns `false` (validator-rejected), the draft snaps back to
 * the last committed value so the inspector stays consistent with the model.
 */
function PhysicsNumberDraftField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  // Re-sync the draft when the committed value changes (e.g. undo/redo).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    if (Number.isFinite(parsed) && parsed !== value) {
      const ok = onCommit(parsed);
      if (!ok) setDraft(String(value)); // snap back when validator rejected
    } else {
      setDraft(String(value)); // snap back an unparseable / no-op draft
    }
  };

  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: "#9a9aa5",
      }}
    >
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ ...inputStyle, width: 56 }}
      />
    </label>
  );
}

/**
 * One physics rig row. Holds the per-field draft state (in the keyed child, never
 * in the parent's map) so adding/deleting a rig never shifts hook order. Each
 * committed edit builds a deep-cloned patched rig and dispatches one
 * `SetPhysicsRig` (one undo step); Delete dispatches `DeletePhysicsRig`.
 */
function PhysicsRigRow({
  rig,
  model,
  runCommand,
}: {
  rig: IkiPhysics;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => boolean;
}) {
  const set = (patched: IkiPhysics): boolean =>
    runCommand(new SetPhysicsRig(rig.id, patched));
  const setParam = (which: "input" | "output", parameter: string) => {
    const next = structuredClone(rig);
    next[which].parameter = parameter;
    set(next);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        paddingTop: 6,
        borderTop: "1px solid #2a2b33",
      }}
    >
      <div style={rowStyle}>
        <span style={{ fontSize: 12, color: "#e6e6ee" }}>{rig.id}</span>
        <button
          type="button"
          style={removeBtnStyle}
          onClick={() => runCommand(new DeletePhysicsRig(rig.id))}
        >
          Delete
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={labelStyle}>in</span>
        <select
          value={rig.input.parameter}
          onChange={(e) => setParam("input", e.currentTarget.value)}
          style={{ ...selectStyle, flex: 1, minWidth: 0 }}
        >
          {model.parameters.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
        <PhysicsNumberDraftField
          label="w"
          value={rig.input.weight}
          onCommit={(v) => set(withPhysicsScalar(rig, "weight", v))}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={labelStyle}>out</span>
        <select
          value={rig.output.parameter}
          onChange={(e) => setParam("output", e.currentTarget.value)}
          style={{ ...selectStyle, flex: 1, minWidth: 0 }}
        >
          {model.parameters.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
        <PhysicsNumberDraftField
          label="×"
          value={rig.output.scale}
          onCommit={(v) => set(withPhysicsScalar(rig, "scale", v))}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <PhysicsNumberDraftField
          label="mass"
          value={rig.mass}
          onCommit={(v) => set(withPhysicsScalar(rig, "mass", v))}
        />
        <PhysicsNumberDraftField
          label="stiff"
          value={rig.stiffness}
          onCommit={(v) => set(withPhysicsScalar(rig, "stiffness", v))}
        />
        <PhysicsNumberDraftField
          label="damp"
          value={rig.damping}
          onCommit={(v) => set(withPhysicsScalar(rig, "damping", v))}
        />
      </div>
    </div>
  );
}

/**
 * Model-level "Physics Rigs" panel: lists every `model.physics` rig with
 * editable dropdowns + draft-state numeric fields, an Add button (disabled when
 * no valid rig can be built), and per-rig Delete. The parent holds NO per-field
 * hooks — all draft state lives in the keyed {@link PhysicsRigRow}.
 */
function PhysicsRigsEditor({
  model,
  runCommand,
}: {
  model: IkiModel;
  runCommand: (cmd: EditCommand) => boolean;
}) {
  const rigs = model.physics ?? [];
  const nextRig = defaultPhysicsRig(model);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>Physics Rigs</span>
      {rigs.length === 0 && (
        <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
          No physics rigs. Add one to spring-lag a parameter onto another.
        </p>
      )}
      {rigs.map((rig) => (
        <PhysicsRigRow
          key={rig.id}
          rig={rig}
          model={model}
          runCommand={runCommand}
        />
      ))}
      <button
        type="button"
        disabled={nextRig === null}
        onClick={() => nextRig && runCommand(new AddPhysicsRig(nextRig))}
        style={smallBtnStyle}
      >
        Add Physics Rig
      </button>
      {nextRig === null && (
        <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
          Need two free parameters (one unused as a rig output) to add a rig.
        </p>
      )}
    </div>
  );
}

function PartFields({
  part,
  model,
  runCommand,
  deletePart,
}: {
  part: IkiPart;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
  deletePart: (id: string) => void;
}) {
  const id = part.id;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}>
        {id}
      </p>

      <AttachDropdown part={part} model={model} runCommand={runCommand} />

      <NumberField
        label="width"
        value={part.width}
        onCommit={(v) => runCommand(new SetPartWidth(id, v))}
      />
      <NumberField
        label="height"
        value={part.height}
        onCommit={(v) => runCommand(new SetPartHeight(id, v))}
      />
      <NumberField
        label="order"
        value={part.order}
        onCommit={(v) => runCommand(new SetPartOrder(id, v))}
      />

      <TransformField
        label="x"
        channel="x"
        part={part}
        runCommand={runCommand}
      />
      <TransformField
        label="y"
        channel="y"
        part={part}
        runCommand={runCommand}
      />
      <TransformField
        label="rotation"
        channel="rotation"
        part={part}
        runCommand={runCommand}
      />
      <TransformField
        label="scaleX"
        channel="scaleX"
        part={part}
        runCommand={runCommand}
      />
      <TransformField
        label="scaleY"
        channel="scaleY"
        part={part}
        runCommand={runCommand}
      />
      <TransformField
        label="opacity"
        channel="opacity"
        part={part}
        runCommand={runCommand}
      />

      <ColorField
        color={part.color}
        onCommit={(rgba) => runCommand(new SetPartColor(id, rgba))}
      />

      <PartBindingsEditor part={part} model={model} runCommand={runCommand} />

      <MeshField part={part} />

      <TextureField partId={id} />

      <button
        type="button"
        onClick={() => deletePart(id)}
        style={{
          alignSelf: "flex-start",
          padding: "2px 8px",
          fontSize: 12,
          background: "#2a1a1a",
          border: "1px solid #7a2a2a",
          borderRadius: 4,
          color: "#f08080",
          cursor: "pointer",
        }}
      >
        Delete
      </button>
    </div>
  );
}

/**
 * Property panel for the selected deformer. A WARP deformer is read-only here
 * (its grid is authored via the grid-edit overlay) so it shows only its kind +
 * parent. A MATRIX deformer exposes its pivot, base transform, bindings, and
 * parent as live editable fields.
 */
function DeformerPanel({
  deformer,
  model,
  runCommand,
  deleteDeformer,
}: {
  deformer: IkiDeformer;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
  deleteDeformer: (id: string) => void;
}) {
  const id = deformer.id;

  if (deformer.kind === "warp") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p
          style={{ margin: 0, fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}
        >
          {id}
        </p>
        <div style={rowStyle}>
          <span style={labelStyle}>kind</span>
          <span style={{ fontSize: 13, color: "#e6e6ee" }}>warp</span>
        </div>
        <ParentDropdown
          deformer={deformer}
          model={model}
          runCommand={runCommand}
        />
        <button
          type="button"
          onClick={() => deleteDeformer(id)}
          style={{
            alignSelf: "flex-start",
            padding: "2px 8px",
            fontSize: 12,
            background: "#2a1a1a",
            border: "1px solid #7a2a2a",
            borderRadius: 4,
            color: "#f08080",
            cursor: "pointer",
          }}
        >
          Delete
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}>
        {id}
      </p>

      <NumberField
        label="pivot.x"
        value={deformer.pivot.x}
        onCommit={(v) => runCommand(new SetDeformerPivotX(id, v))}
      />
      <NumberField
        label="pivot.y"
        value={deformer.pivot.y}
        onCommit={(v) => runCommand(new SetDeformerPivotY(id, v))}
      />

      <DeformerTransformField
        label="x"
        channel="x"
        deformer={deformer}
        runCommand={runCommand}
      />
      <DeformerTransformField
        label="y"
        channel="y"
        deformer={deformer}
        runCommand={runCommand}
      />
      <DeformerTransformField
        label="rotation"
        channel="rotation"
        deformer={deformer}
        runCommand={runCommand}
      />
      <DeformerTransformField
        label="scaleX"
        channel="scaleX"
        deformer={deformer}
        runCommand={runCommand}
      />
      <DeformerTransformField
        label="scaleY"
        channel="scaleY"
        deformer={deformer}
        runCommand={runCommand}
      />

      <BindingsEditor
        deformer={deformer}
        model={model}
        runCommand={runCommand}
      />

      <ParentDropdown
        deformer={deformer}
        model={model}
        runCommand={runCommand}
      />

      <button
        type="button"
        onClick={() => deleteDeformer(id)}
        style={{
          alignSelf: "flex-start",
          padding: "2px 8px",
          fontSize: 12,
          background: "#2a1a1a",
          border: "1px solid #7a2a2a",
          borderRadius: 4,
          color: "#f08080",
          cursor: "pointer",
        }}
      >
        Delete
      </button>
    </div>
  );
}

/**
 * One transform channel of a matrix deformer. Mirrors {@link TransformField}:
 * an absent OPTIONAL channel displays the engine default but only WRITES (via
 * `SetDeformerTransform`) when the user edits. While a capture session targets
 * this deformer, `onCommit` routes to `poseCapture` instead.
 */
function DeformerTransformField({
  label,
  channel,
  deformer,
  runCommand,
}: {
  label: string;
  channel: DeformerTransformChannel;
  deformer: IkiMatrixDeformer;
  runCommand: (cmd: EditCommand) => void;
}) {
  const deformerId = deformer.id;
  const isCapturing = useEditorStore(
    (s) =>
      s.capture?.target.kind === "deformer" &&
      s.capture.target.id === deformerId,
  );
  const poseCapture = useEditorStore((s) => s.poseCapture);
  const raw = deformer.transform?.[channel];
  const display =
    raw === undefined ? DEFORMER_TRANSFORM_DEFAULTS[channel] : raw;
  return (
    <NumberField
      label={label}
      value={display}
      onCommit={(v) => {
        if (isCapturing) {
          poseCapture(channel, v);
        } else {
          runCommand(new SetDeformerTransform(deformerId, channel, v));
        }
      }}
    />
  );
}

/**
 * Per-row capture session controls. Renders "Bind capture" when no session
 * is active for this row, and the full from/to/Done/Abandon controls when
 * this row IS the active capture target. Each selector returns a scalar (no
 * object literals) to avoid the infinite-render bug from 5d.
 */
function CaptureControls({
  kind,
  id,
  rowIndex,
}: {
  kind: "part" | "deformer";
  id: string;
  rowIndex: number;
}) {
  const isCapturingThisRow = useEditorStore(
    (s) =>
      s.capture?.target.kind === kind &&
      s.capture.target.id === id &&
      s.capture.rowIndex === rowIndex,
  );
  const fromCaptured = useEditorStore((s) => s.capture?.from.captured ?? false);
  const toCaptured = useEditorStore((s) => s.capture?.to.captured ?? false);
  const enterCapture = useEditorStore((s) => s.enterCapture);
  const commitCapture = useEditorStore((s) => s.commitCapture);
  const abandonCapture = useEditorStore((s) => s.abandonCapture);
  const captureEndpoint = useEditorStore((s) => s.captureEndpoint);

  const mutedBtnStyle: CSSProperties = {
    padding: "2px 8px",
    fontSize: 11,
    background: "#1e1e2a",
    border: "1px solid #3a3b47",
    borderRadius: 4,
    color: "#9a9aa5",
    cursor: "pointer",
  };

  if (!isCapturingThisRow) {
    return (
      <button
        type="button"
        onClick={() => enterCapture({ kind, id }, rowIndex)}
        style={mutedBtnStyle}
      >
        Bind capture
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...labelStyle, fontStyle: "italic" }}>
        Capturing — from {fromCaptured ? "✓" : "—"} / to{" "}
        {toCaptured ? "✓" : "—"}
      </span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => captureEndpoint("from")}
          style={mutedBtnStyle}
        >
          Capture from (@min)
        </button>
        <button
          type="button"
          onClick={() => captureEndpoint("to")}
          style={mutedBtnStyle}
        >
          Capture to (@max)
        </button>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          onClick={() => commitCapture()}
          style={{
            ...mutedBtnStyle,
            background: "#1a2a1a",
            border: "1px solid #3a6a3a",
            color: "#80c880",
          }}
        >
          Done
        </button>
        <button
          type="button"
          onClick={() => abandonCapture()}
          style={{
            ...mutedBtnStyle,
            background: "#2a1a1a",
            border: "1px solid #7a2a2a",
            color: "#f08080",
          }}
        >
          Abandon
        </button>
      </div>
    </div>
  );
}

/**
 * Editor for a part's parameter bindings. Add/edit/remove each compute the
 * next bindings array and dispatch a single `SetPartBindings` so every change
 * is one undoable step.
 */
function PartBindingsEditor({
  part,
  model,
  runCommand,
}: {
  part: IkiPart;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
}) {
  const id = part.id;
  const bindings = part.bindings ?? [];
  const hasParams = model.parameters.length > 0;

  const commit = (next: IkiBinding[]) =>
    runCommand(new SetPartBindings(id, next));

  const replaceRow = (
    index: number,
    patch: Partial<IkiBinding>,
  ): IkiBinding[] =>
    bindings.map((b, i) => (i === index ? { ...b, ...patch } : { ...b }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>bindings</span>

      {bindings.map((binding, index) => (
        <div
          key={index}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <select
              value={binding.parameter}
              onChange={(e) =>
                commit(replaceRow(index, { parameter: e.currentTarget.value }))
              }
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {model.parameters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            <select
              value={binding.channel}
              onChange={(e) =>
                commit(
                  replaceRow(index, {
                    channel: e.currentTarget.value as IkiTransformChannel,
                  }),
                )
              }
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {PART_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <NumberField
              label="from"
              value={binding.from}
              onCommit={(v) => commit(replaceRow(index, { from: v }))}
            />
            <NumberField
              label="to"
              value={binding.to}
              onCommit={(v) => commit(replaceRow(index, { to: v }))}
            />
            <button
              type="button"
              onClick={() =>
                commit(
                  bindings.filter((_, i) => i !== index).map((b) => ({ ...b })),
                )
              }
              style={{
                padding: "2px 8px",
                fontSize: 12,
                background: "#2a1a1a",
                border: "1px solid #7a2a2a",
                borderRadius: 4,
                color: "#f08080",
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          </div>
          <CaptureControls kind="part" id={id} rowIndex={index} />
        </div>
      ))}

      <button
        type="button"
        disabled={!hasParams}
        onClick={() =>
          commit([
            ...bindings.map((b) => ({ ...b })),
            {
              parameter: model.parameters[0].id,
              channel: "rotate",
              from: 0,
              to: 0,
            },
          ])
        }
        style={{ alignSelf: "flex-start", padding: "2px 8px", fontSize: 12 }}
      >
        Add binding
      </button>
    </div>
  );
}

/**
 * Editor for a matrix deformer's parameter bindings. Add/edit/remove each
 * compute the next bindings array (clone-then-replace) and dispatch a single
 * `SetDeformerBindings` so every change is one undoable step.
 */
function BindingsEditor({
  deformer,
  model,
  runCommand,
}: {
  deformer: IkiMatrixDeformer;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
}) {
  const id = deformer.id;
  const bindings = deformer.bindings ?? [];
  const hasParams = model.parameters.length > 0;

  const commit = (next: IkiDeformerBinding[]) =>
    runCommand(new SetDeformerBindings(id, next));

  const replaceRow = (
    index: number,
    patch: Partial<IkiDeformerBinding>,
  ): IkiDeformerBinding[] =>
    bindings.map((b, i) => (i === index ? { ...b, ...patch } : { ...b }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>bindings</span>

      {bindings.map((binding, index) => (
        <div
          key={index}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <select
              value={binding.parameter}
              onChange={(e) =>
                commit(replaceRow(index, { parameter: e.currentTarget.value }))
              }
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {model.parameters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            <select
              value={binding.channel}
              onChange={(e) =>
                commit(
                  replaceRow(index, {
                    channel: e.currentTarget.value as IkiMatrixChannel,
                  }),
                )
              }
              style={{ ...selectStyle, flex: 1, minWidth: 0 }}
            >
              {MATRIX_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <NumberField
              label="from"
              value={binding.from}
              onCommit={(v) => commit(replaceRow(index, { from: v }))}
            />
            <NumberField
              label="to"
              value={binding.to}
              onCommit={(v) => commit(replaceRow(index, { to: v }))}
            />
            <button
              type="button"
              onClick={() =>
                commit(
                  bindings.filter((_, i) => i !== index).map((b) => ({ ...b })),
                )
              }
              style={{
                padding: "2px 8px",
                fontSize: 12,
                background: "#2a1a1a",
                border: "1px solid #7a2a2a",
                borderRadius: 4,
                color: "#f08080",
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          </div>
          <CaptureControls kind="deformer" id={id} rowIndex={index} />
        </div>
      ))}

      <button
        type="button"
        disabled={!hasParams}
        onClick={() =>
          commit([
            ...bindings.map((b) => ({ ...b })),
            {
              parameter: model.parameters[0].id,
              channel: "rotate",
              from: 0,
              to: 0,
            },
          ])
        }
        style={{ alignSelf: "flex-start", padding: "2px 8px", fontSize: 12 }}
      >
        Add binding
      </button>
    </div>
  );
}

/**
 * Parent picker for a deformer. Options are "(none / root)" plus every MATRIX
 * deformer except this one. Warp deformers can't be parents (validator rule),
 * and self is excluded. Cycle-creating picks ARE still offered — the
 * `SetDeformerParent` validator rejects them, surfacing via `editError`;
 * pre-filtering all cycles here is extra logic the lean slice doesn't need.
 */
function ParentDropdown({
  deformer,
  model,
  runCommand,
}: {
  deformer: IkiDeformer;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
}) {
  const candidates = (model.deformers ?? []).filter(
    (d) => d.id !== deformer.id && d.kind !== "warp",
  );
  return (
    <label style={rowStyle}>
      <span style={labelStyle}>parent</span>
      <select
        value={deformer.parent ?? ""}
        onChange={(e) => {
          const value = e.currentTarget.value;
          runCommand(
            new SetDeformerParent(
              deformer.id,
              value === "" ? undefined : value,
            ),
          );
        }}
        style={selectStyle}
      >
        <option value="">(none / root)</option>
        {candidates.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Attach picker for a part. Options are "(none)" plus EVERY deformer (matrix and
 * warp). Attaching a meshless part to a warp deformer is rejected by the
 * `SetPartDeformer` validator, surfacing via `editError`.
 */
function AttachDropdown({
  part,
  model,
  runCommand,
}: {
  part: IkiPart;
  model: IkiModel;
  runCommand: (cmd: EditCommand) => void;
}) {
  const deformers = model.deformers ?? [];
  return (
    <label style={rowStyle}>
      <span style={labelStyle}>deformer</span>
      <select
        value={part.deformer ?? ""}
        onChange={(e) => {
          const value = e.currentTarget.value;
          runCommand(
            new SetPartDeformer(part.id, value === "" ? undefined : value),
          );
        }}
        style={selectStyle}
      >
        <option value="">(none)</option>
        {deformers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Grid-mesh controls for a part. Shows cols/rows inputs and "Add Grid Mesh"
 * when the part has no mesh; shows vertex/triangle counts plus cols/rows inputs
 * and "Regenerate" / "Remove Mesh" buttons when a mesh is present.
 * Errors (range, warp-coupling) surface via the store's editError banner.
 */
function MeshField({ part }: { part: IkiPart }) {
  const setPartGridMesh = useEditorStore((s) => s.setPartGridMesh);
  const removePartMesh = useEditorStore((s) => s.removePartMesh);
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(4);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>mesh</span>

      {part.mesh !== undefined && (
        <span style={labelStyle}>
          {part.mesh.vertices.length / 2} vertices,{" "}
          {part.mesh.indices.length / 3} triangles
        </span>
      )}

      <label style={rowStyle}>
        <span style={labelStyle}>cols</span>
        <input
          type="number"
          min={1}
          value={cols}
          onChange={(e) => setCols(e.currentTarget.valueAsNumber)}
          style={inputStyle}
        />
      </label>
      <label style={rowStyle}>
        <span style={labelStyle}>rows</span>
        <input
          type="number"
          min={1}
          value={rows}
          onChange={(e) => setRows(e.currentTarget.valueAsNumber)}
          style={inputStyle}
        />
      </label>

      {part.mesh === undefined ? (
        <button
          type="button"
          onClick={() => setPartGridMesh(part.id, cols, rows)}
          style={smallBtnStyle}
        >
          Add Grid Mesh
        </button>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => setPartGridMesh(part.id, cols, rows)}
            style={smallBtnStyle}
          >
            Regenerate
          </button>
          <button
            type="button"
            onClick={() => removePartMesh(part.id)}
            style={removeBtnStyle}
          >
            Remove Mesh
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Per-part texture drop zone. Renders for ALL parts (quad and mesh).
 * Single-image: multi-file drops take only the first file.
 * The store owns ALL bitmap cleanup — this component never calls bitmap.close().
 *
 * Clear paths (both non-undoable, consistent with the atlas layer):
 * - Imported side-table image present → clearPartTexture (atlas re-pack).
 * - No imported image but model-committed texture present → clearModelTexture
 *   (calls doc.clearPartTextureRef; no atlas re-pack needed).
 */
function TextureField({ partId }: { partId: string }) {
  const currentImage = useEditorStore((s) => {
    void s.revision;
    return s.partTextures[partId] ?? null;
  });
  const hasModelTexture = useEditorStore((s) => {
    void s.revision;
    return (
      s.doc.getModel().parts.find((p) => p.id === partId)?.texture !== undefined
    );
  });
  const setPartTexture = useEditorStore((s) => s.setPartTexture);
  const clearPartTexture = useEditorStore((s) => s.clearPartTexture);
  const clearModelTexture = useEditorStore((s) => s.clearModelTexture);
  const atlasError = useEditorStore((s) => s.atlasError);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // Monotonically increasing counter; each handleFile call captures a snapshot
  // at call start and compares after the async decode to detect stale results.
  const decodeSeqRef = useRef(0);

  async function handleFile(file: File) {
    setDecodeError(null);
    const seq = ++decodeSeqRef.current;
    try {
      const decoded = await decodeImageFile(file);
      if (seq !== decodeSeqRef.current) {
        // A newer file was selected before this decode finished — discard it.
        // We own this bitmap (never handed to the store), so we close it here.
        decoded.bitmap.close();
        return;
      }
      // Store owns the bitmap from here — we never close it on success or failure.
      setPartTexture(partId, decoded);
    } catch (err) {
      // decode rejected — no bitmap exists to close.
      if (seq === decodeSeqRef.current) {
        setDecodeError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.currentTarget.files;
    if (files && files.length > 0) {
      void handleFile(files[0]);
      // Reset so the same file can be re-selected.
      e.currentTarget.value = "";
    }
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(true);
  }

  function onDragLeave() {
    setDragOver(false);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    // Multi-file drop: take only the first file.
    void handleFile(files[0]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>texture</span>

      <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
        Setting a texture replaces the model&apos;s texture table.
      </p>
      <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
        Texture changes aren&apos;t undoable yet.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `1px dashed ${dragOver ? "#6a6aff" : "#2a2b33"}`,
          borderRadius: 4,
          padding: "10px 8px",
          textAlign: "center",
          cursor: "pointer",
          background: dragOver ? "#1e1e30" : "transparent",
          color: "#9a9aa5",
          fontSize: 12,
          userSelect: "none",
        }}
      >
        Drop PNG / WebP or click to browse
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/webp"
        style={{ display: "none" }}
        onChange={onFileInputChange}
      />

      {/* Current image thumbnail/label — imported side-table image */}
      {currentImage !== null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: "#e6e6ee",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {currentImage.name}
            </span>
            <span style={labelStyle}>
              {currentImage.width}&times;{currentImage.height}
            </span>
          </div>
          <button
            type="button"
            onClick={() => clearPartTexture(partId)}
            style={{
              flexShrink: 0,
              padding: "2px 8px",
              fontSize: 12,
              background: "#2a1a1a",
              border: "1px solid #7a2a2a",
              borderRadius: 4,
              color: "#f08080",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Clear button for model-committed texture (no imported image) */}
      {currentImage === null && hasModelTexture && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#9a9aa5" }}>
            Model texture assigned
          </span>
          <button
            type="button"
            onClick={() => clearModelTexture(partId)}
            style={{
              flexShrink: 0,
              padding: "2px 8px",
              fontSize: 12,
              background: "#2a1a1a",
              border: "1px solid #7a2a2a",
              borderRadius: 4,
              color: "#f08080",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Decode-stage error */}
      {decodeError && <p style={errorStyle}>{decodeError}</p>}
      {/* Commit-stage error (from store) */}
      {atlasError && <p style={errorStyle}>{atlasError}</p>}
    </div>
  );
}

/**
 * One transform channel. For an OPTIONAL channel that is `undefined`, displays
 * the engine default but only WRITES when the user edits (dispatching
 * `SetPartTransform`). While a capture session targets this part, `onCommit`
 * routes to `poseCapture` instead so the ephemeral pose drives the model.
 */
function TransformField({
  label,
  channel,
  part,
  runCommand,
}: {
  label: string;
  channel: EditTransformChannel;
  part: IkiPart;
  runCommand: (cmd: EditCommand) => void;
}) {
  const partId = part.id;
  const isCapturing = useEditorStore(
    (s) => s.capture?.target.kind === "part" && s.capture.target.id === partId,
  );
  const poseCapture = useEditorStore((s) => s.poseCapture);
  const raw = part.transform[channel];
  const display = raw === undefined ? TRANSFORM_DEFAULTS[channel] : raw;
  return (
    <NumberField
      label={label}
      value={display}
      onCommit={(v) => {
        if (isCapturing) {
          poseCapture(channel, v);
        } else {
          runCommand(new SetPartTransform(partId, channel, v));
        }
      }}
    />
  );
}

/**
 * Controlled numeric input. The NaN rule (B6): a non-finite document value
 * renders as an EMPTY string so React keeps a coherent controlled input, while
 * the document retains `NaN` for validation. Emptying the input yields
 * `valueAsNumber === NaN`, which the command writes back into the document.
 */
function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? String(value) : ""}
        onChange={(e) => onCommit(e.currentTarget.valueAsNumber)}
        style={inputStyle}
      />
    </label>
  );
}

/** RGBA control: four numeric inputs (each channel 0..1). */
function ColorField({
  color,
  onCommit,
}: {
  color: [number, number, number, number];
  onCommit: (rgba: [number, number, number, number]) => void;
}) {
  const channels: Array<["r" | "g" | "b" | "a", number]> = [
    ["r", color[0]],
    ["g", color[1]],
    ["b", color[2]],
    ["a", color[3]],
  ];

  const commit = (index: number, next: number) => {
    const rgba: [number, number, number, number] = [...color];
    rgba[index] = next;
    onCommit(rgba);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={labelStyle}>color (RGBA)</span>
      <div style={{ display: "flex", gap: 6 }}>
        {channels.map(([name, value], index) => (
          <label
            key={name}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            <span style={{ fontSize: 11, color: "#6f6f7a" }}>{name}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={Number.isFinite(value) ? String(value) : ""}
              onChange={(e) => commit(index, e.currentTarget.valueAsNumber)}
              style={{ ...inputStyle, width: 52 }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
