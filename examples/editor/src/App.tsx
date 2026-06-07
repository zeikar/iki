import type { IkiPlayer } from "@iki/engine";
import { useRef } from "react";

import { Preview } from "./Preview";
import { useReloadPreview } from "./useReloadPreview";

// 3-column shell. App owns the imperative playerRef and calls the single
// load owner (useReloadPreview) once. Tree (left), inspector (right), and the
// export button are placeholders wired up in Tasks 7–8; the center preview +
// initial load + parameter sliders are fully working at this commit.
export function App() {
  const playerRef = useRef<IkiPlayer | null>(null);
  useReloadPreview(playerRef);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      <aside
        style={{
          width: 220,
          background: "#1c1d24",
          borderRight: "1px solid #2a2b33",
          padding: "16px 12px",
        }}
      >
        <p style={{ margin: 0, fontSize: 12, color: "#9a9aa5" }}>
          Part tree (Task 7)
        </p>
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
        }}
      >
        <p style={{ margin: 0, fontSize: 12, color: "#9a9aa5" }}>
          Inspector (Task 7)
        </p>
        <button type="button" disabled style={{ marginTop: "auto" }}>
          Export (Task 8)
        </button>
      </aside>
    </div>
  );
}
