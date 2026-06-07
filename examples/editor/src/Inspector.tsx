import {
  SetPartColor,
  SetPartHeight,
  SetPartOrder,
  SetPartTransform,
  SetPartWidth,
  type EditCommand,
  type EditTransformChannel,
} from "@iki/editor-core";
import type { IkiPart } from "@iki/format";
import type { CSSProperties } from "react";

import { useEditorStore } from "./store";
import type { DecodedSource } from "./atlas-image";

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

/**
 * Numeric property panel for the selected part's lean-5a fields. Each edit
 * dispatches the matching editor-core command through the store, which mutates
 * the document and bumps `revision`; `useReloadPreview` debounces and reloads.
 */
export function Inspector() {
  const selectedPartId = useEditorStore((s) => s.selectedPartId);
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

      {!selectedPartId || !part ? (
        <p style={labelStyle}>Select a part to edit.</p>
      ) : (
        <PartFields part={part} runCommand={runCommand} />
      )}
    </div>
  );
}

function PartFields({
  part,
  runCommand,
}: {
  part: IkiPart;
  runCommand: (cmd: EditCommand) => void;
}) {
  const id = part.id;

  // Subscribe to atlas state via revision-keyed selector pattern so texture
  // assignments re-render with the document.
  const atlasSources = useEditorStore((s) => {
    void s.revision;
    return s.atlasSources;
  });
  const partAssignments = useEditorStore((s) => {
    void s.revision;
    return s.partAssignments;
  });
  const assignPartTexture = useEditorStore((s) => s.assignPartTexture);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}>
        {id}
      </p>

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

      <TextureField
        part={part}
        atlasSources={atlasSources}
        currentSourceId={partAssignments[id] ?? null}
        onAssign={(sourceId) => assignPartTexture(id, sourceId)}
      />
    </div>
  );
}

/**
 * Texture assignment field. Only shown for quad parts (no `mesh`).
 * For mesh parts, renders a disabled informational note (first line of defense;
 * the store is the second).
 */
function TextureField({
  part,
  atlasSources,
  currentSourceId,
  onAssign,
}: {
  part: IkiPart;
  atlasSources: DecodedSource[];
  currentSourceId: string | null;
  onAssign: (sourceId: string | null) => void;
}) {
  if (part.mesh !== undefined) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>texture</span>
        <span style={{ fontSize: 11, color: "#6f6f7a", fontStyle: "italic" }}>
          Texture assignment is for quad parts (mesh UV is 5c).
        </span>
      </div>
    );
  }

  return (
    <label style={rowStyle}>
      <span style={labelStyle}>texture</span>
      <select
        value={currentSourceId ?? ""}
        onChange={(e) => {
          const val = e.currentTarget.value;
          onAssign(val === "" ? null : val);
        }}
        style={{
          background: "#101116",
          border: "1px solid #2a2b33",
          borderRadius: 4,
          color: "#e6e6ee",
          padding: "4px 6px",
          fontSize: 13,
          maxWidth: 140,
        }}
      >
        <option value="">none</option>
        {atlasSources.map((src) => (
          <option key={src.id} value={src.id}>
            {src.name}
          </option>
        ))}
      </select>
    </label>
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
