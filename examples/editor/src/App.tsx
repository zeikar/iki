// Placeholder shell — columns wired up in Tasks 6–8.
export function App() {
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
        <p style={{ margin: 0, fontSize: 12, color: "#9a9aa5" }}>Part tree</p>
      </aside>
      <main
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          background: "#14151a",
        }}
      >
        <p style={{ color: "#9a9aa5", fontSize: 14 }}>Canvas (Task 6)</p>
      </main>
      <aside
        style={{
          width: 260,
          background: "#1c1d24",
          borderLeft: "1px solid #2a2b33",
          padding: "16px 12px",
        }}
      >
        <p style={{ margin: 0, fontSize: 12, color: "#9a9aa5" }}>Inspector</p>
      </aside>
    </div>
  );
}
