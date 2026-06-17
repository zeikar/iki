---
"@iki/mcp": minor
---

Add an `auto_rig_from_layers` MCP tool: an agent passes role-named PNG file paths (face, eye_L/eye_R, mouth required; iris/brow/hair/lash optional) and gets back a renderable, validated `.iki` written to disk. The tool decodes, alpha-bboxes, crops, and atlases the layers in Node (via a new `sharp` dependency confined to `@iki/mcp`), reusing the pure `@iki/editor-core` model/atlas math (`generateIkiFromLayerSet`, `packAtlas`, `uvRectFor`, `EditorDocument.applyAtlas`) so the browser and Node paths stay in sync. The atlas is embedded as a base64 `data:image/png` texture and the model is `parseIkiModel`-validated before writing; the result returns the output path + summary stats rather than inlining the multi-MB model. No `.iki` schema change (no `IKI_FORMAT_VERSION` bump).
