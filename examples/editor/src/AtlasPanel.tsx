import { useRef, useState } from "react";

import { decodeImageFile } from "./atlas-image";
import { useEditorStore } from "./store";

const labelStyle = { fontSize: 12, color: "#9a9aa5" } as const;

const errorStyle = {
  margin: 0,
  padding: "8px 10px",
  background: "#3a1a1a",
  border: "1px solid #7a2a2a",
  borderRadius: 4,
  color: "#f08080",
  fontSize: 12,
  wordBreak: "break-word" as const,
};

/**
 * Atlas image import panel. Handles file-input + drop zone, calls
 * decodeImageFile per file, then commits via importAtlasSources.
 *
 * Decode-stage (allSettled): if ANY file rejects, close every fulfilled
 * bitmap in the batch and surface the error without importing.
 * Commit-stage: importAtlasSources returns false on failure; the store already
 * closed the uncommitted bitmaps — surface atlasError without re-closing.
 */
export function AtlasPanel() {
  const atlasSources = useEditorStore((s) => s.atlasSources);
  const atlasError = useEditorStore((s) => s.atlasError);
  const importAtlasSources = useEditorStore((s) => s.importAtlasSources);
  const removeAtlasSource = useEditorStore((s) => s.removeAtlasSource);
  const setAtlasError = useEditorStore((s) => s.setAtlasError);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList | File[]) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setDecodeError(null);
    setAtlasError(null);

    const results = await Promise.allSettled(
      fileArray.map((f) => decodeImageFile(f)),
    );

    // Decode-stage: if ANY rejected, close all fulfilled bitmaps and abort.
    const hasReject = results.some((r) => r.status === "rejected");
    if (hasReject) {
      for (const r of results) {
        if (r.status === "fulfilled") {
          r.value.bitmap.close();
        }
      }
      const firstRejection = results.find((r) => r.status === "rejected");
      const msg =
        firstRejection?.status === "rejected"
          ? firstRejection.reason instanceof Error
            ? firstRejection.reason.message
            : String(firstRejection.reason)
          : "Unknown decode error";
      setDecodeError(msg);
      return;
    }

    // All fulfilled — commit the batch. Store closes bitmaps on failure.
    const decoded = results.map((r) => {
      // We know all are fulfilled at this point.
      return (
        r as PromiseFulfilledResult<Awaited<ReturnType<typeof decodeImageFile>>>
      ).value;
    });

    importAtlasSources(decoded);
    // On false return, atlasError is already set in the store — UI surfaces it.
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.currentTarget.files) {
      void handleFiles(e.currentTarget.files);
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
    if (e.dataTransfer.files) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13, color: "#e6e6ee", fontWeight: 600 }}>
        Textures
      </p>

      <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
        Importing replaces the model&apos;s textures.
      </p>
      <p style={{ margin: 0, fontSize: 11, color: "#9a9aa5" }}>
        Texture changes aren&apos;t undoable yet.
      </p>

      {/* Drop zone + file input trigger */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `1px dashed ${dragOver ? "#6a6aff" : "#2a2b33"}`,
          borderRadius: 4,
          padding: "12px 8px",
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
        multiple
        style={{ display: "none" }}
        onChange={onFileInputChange}
      />

      {/* Decode-stage error */}
      {decodeError && <p style={errorStyle}>{decodeError}</p>}
      {/* Commit-stage error (from store) */}
      {atlasError && <p style={errorStyle}>{atlasError}</p>}

      {/* Source list */}
      {atlasSources.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {atlasSources.map((src) => (
            <li
              key={src.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "4px 0",
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
                  {src.name}
                </span>
                <span style={labelStyle}>
                  {src.width}&times;{src.height}
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeAtlasSource(src.id)}
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
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
