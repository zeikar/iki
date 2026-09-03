---
"@ikijs/engine": patch
---

`IkiPlayer.load` now reports a lost WebGL context and detects failed mesh-buffer uploads.

A non-numeric `MAX_TEXTURE_SIZE` has exactly one cause — the context is gone — and the code read that signal and discarded it, then drained the single `CONTEXT_LOST_WEBGL` the spec guarantees. For a model of implicit quads (no mesh parts) the load would then complete and adopt, reporting every texture in `failedTextures` as if they had merely failed to decode. It now says so.

`bufferData` was also unchecked: only the `createBuffer` allocation was tested for null, so an `OUT_OF_MEMORY` upload left a valid-but-empty buffer that draws garbage or nothing. This class documents a mesh-buffer failure as fatal _because_ it has no `failedTextures`-style reporting surface, which only holds if the failure is detected — it now is, and throws with the existing cleanup.
