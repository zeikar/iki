import { useEditorStore } from "./store";

/**
 * Read-only, selectable list of the document's parts plus a read-only list of
 * its deformers (for hierarchy context — deformers are not editable in 5a).
 *
 * The {@link EditorDocument} is mutable and lives outside React's structural
 * sharing, so the live model is re-read via `doc.getModel()` inside a
 * `revision`-keyed selector: bumping `revision` (on every edit/undo/redo) is
 * what re-renders this list.
 */
export function PartsTree() {
  const selectedPartId = useEditorStore((s) => s.selectedPartId);
  const select = useEditorStore((s) => s.select);
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
      </div>

      {deformers.length > 0 && (
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#9a9aa5" }}>
            Deformers
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {deformers.map((deformer) => (
              <li
                key={deformer.id}
                style={{
                  padding: "6px 8px",
                  fontSize: 13,
                  color: "#9a9aa5",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span>{deformer.id}</span>
                <span style={{ color: "#6f6f7a" }}>
                  {deformer.kind ?? "matrix"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
