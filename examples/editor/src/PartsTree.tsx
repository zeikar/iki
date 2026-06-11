import { type CSSProperties } from "react";

import { useEditorStore } from "./store";

const addButtonStyle: CSSProperties = {
  background: "#2a2b33",
  color: "#c8c8d0",
  fontSize: 12,
  borderRadius: 4,
  padding: "4px 8px",
  border: "none",
  cursor: "pointer",
};

/**
 * Read-only, selectable list of the document's parts plus a selectable list of
 * its deformers (selectable and editable as of 5e).
 *
 * The {@link EditorDocument} is mutable and lives outside React's structural
 * sharing, so the live model is re-read via `doc.getModel()` inside a
 * `revision`-keyed selector: bumping `revision` (on every edit/undo/redo) is
 * what re-renders this list.
 */
export function PartsTree() {
  const selectedPartId = useEditorStore((s) => s.selectedPartId);
  const select = useEditorStore((s) => s.select);
  const selectedDeformerId = useEditorStore((s) => s.selectedDeformerId);
  const selectDeformer = useEditorStore((s) => s.selectDeformer);
  const addPart = useEditorStore((s) => s.addPart);
  const addMatrixDeformer = useEditorStore((s) => s.addMatrixDeformer);
  const addWarpDeformer = useEditorStore((s) => s.addWarpDeformer);
  // `revision` is read only to subscribe — the model is mutated in place.
  const model = useEditorStore((s) => {
    void s.revision;
    return s.doc.getModel();
  });

  // Display sorted by paint order (renderer parity) WITHOUT mutating the array.
  const parts = [...model.parts].sort((a, b) => a.order - b.order);
  const deformers = model.deformers ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "#9a9aa5" }}>
          Parts
        </p>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {parts.map((part) => {
            const selected = part.id === selectedPartId;
            return (
              <li key={part.id}>
                <button
                  type="button"
                  onClick={() => select(part.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 8px",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 13,
                    background: selected ? "#3a3d4d" : "transparent",
                    color: selected ? "#fff" : "#c8c8d0",
                  }}
                >
                  {part.id}
                </button>
              </li>
            );
          })}
        </ul>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" onClick={addPart} style={addButtonStyle}>
            + Part
          </button>
          <button
            type="button"
            onClick={addMatrixDeformer}
            style={addButtonStyle}
          >
            + Matrix
          </button>
          <button
            type="button"
            onClick={addWarpDeformer}
            style={addButtonStyle}
          >
            + Warp
          </button>
        </div>
      </div>

      {deformers.length > 0 && (
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#9a9aa5" }}>
            Deformers
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {deformers.map((deformer) => {
              const selected = deformer.id === selectedDeformerId;
              return (
                <li key={deformer.id}>
                  <button
                    type="button"
                    onClick={() => selectDeformer(deformer.id)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 8px",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 13,
                      background: selected ? "#3a3d4d" : "transparent",
                      color: selected ? "#fff" : "#c8c8d0",
                    }}
                  >
                    <span>{deformer.id}</span>
                    <span style={{ color: "#6f6f7a" }}>
                      {deformer.kind ?? "matrix"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
