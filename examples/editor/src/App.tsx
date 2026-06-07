import type { IkiPlayer } from "@iki/engine";
import { IkiFormatError } from "@iki/format";
import { useRef } from "react";

import { AtlasPanel } from "./AtlasPanel";
import { Inspector } from "./Inspector";
import { PartsTree } from "./PartsTree";
import { Preview } from "./Preview";
import { useEditorStore } from "./store";
import { useReloadPreview } from "./useReloadPreview";

function downloadIki(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 3-column shell. App owns the imperative playerRef and calls the single
// load owner (useReloadPreview) once. Tree (left) + inspector (right) edit the
// document; the center preview + initial load + parameter sliders are fully
// working. Export button validates + downloads the .iki file (Task 8).
export function App() {
  const playerRef = useRef<IkiPlayer | null>(null);
  useReloadPreview(playerRef);

  const doc = useEditorStore((s) => s.doc);
  const exportError = useEditorStore((s) => s.exportError);
  const setExportError = useEditorStore((s) => s.setExportError);

  function handleExport() {
    try {
      const json = doc.serialize();
      downloadIki(`${doc.getModel().name}.iki`, json);
      setExportError(null);
    } catch (e) {
      setExportError(e instanceof IkiFormatError ? e.message : String(e));
    }
  }

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      <aside
        style={{
          width: 220,
          background: "#1c1d24",
          borderRight: "1px solid #2a2b33",
          padding: "16px 12px",
          overflowY: "auto",
        }}
      >
        <PartsTree />
      </aside>

      <Preview playerRef={playerRef} />

      <aside
        style={{
          width: 260,
          background: "#1c1d24",
          borderLeft: "1px solid #2a2b33",
          padding: "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflowY: "auto",
        }}
      >
        <AtlasPanel />
        <Inspector />
        {exportError && (
          <p
            style={{
              margin: 0,
              padding: "8px 10px",
              background: "#3a1a1a",
              border: "1px solid #7a2a2a",
              borderRadius: 4,
              color: "#f08080",
              fontSize: 12,
              wordBreak: "break-word",
            }}
          >
            {exportError}
          </p>
        )}
        <button
          type="button"
          onClick={handleExport}
          style={{ marginTop: "auto" }}
        >
          Export .iki
        </button>
      </aside>
    </div>
  );
}
