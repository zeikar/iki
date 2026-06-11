import {
  SetDeformerBindings,
  SetDeformerParent,
  SetDeformerPivotX,
  SetDeformerPivotY,
  SetDeformerTransform,
  SetPartColor,
  SetPartDeformer,
  SetPartHeight,
  SetPartOrder,
  SetPartTransform,
  SetPartWidth,
  type DeformerTransformChannel,
  type EditCommand,
  type EditTransformChannel,
} from "@iki/editor-core";
import type {
  IkiDeformer,
  IkiDeformerBinding,
  IkiMatrixChannel,
  IkiMatrixDeformer,
  IkiModel,
  IkiPart,
} from "@iki/format";
import { useRef, useState, type CSSProperties } from "react";

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
 * `SetDeformerTransform`) when the user edits.
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
  const raw = deformer.transform?.[channel];
  const display =
    raw === undefined ? DEFORMER_TRANSFORM_DEFAULTS[channel] : raw;
  return (
    <NumberField
      label={label}
      value={display}
      onCommit={(v) =>
        runCommand(new SetDeformerTransform(deformer.id, channel, v))
      }
    />
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
 * Per-part texture drop zone. Renders for ALL parts (quad and mesh).
 * Single-image: multi-file drops take only the first file.
 * The store owns ALL bitmap cleanup — this component never calls bitmap.close().
 */
function TextureField({ partId }: { partId: string }) {
  const currentImage = useEditorStore((s) => {
    void s.revision;
    return s.partTextures[partId] ?? null;
  });
  const setPartTexture = useEditorStore((s) => s.setPartTexture);
  const clearPartTexture = useEditorStore((s) => s.clearPartTexture);
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

      {/* Current image thumbnail/label */}
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
 * `SetPartTransform`).
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
  const raw = part.transform[channel];
  const display = raw === undefined ? TRANSFORM_DEFAULTS[channel] : raw;
  return (
    <NumberField
      label={label}
      value={display}
      onCommit={(v) => runCommand(new SetPartTransform(part.id, channel, v))}
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
