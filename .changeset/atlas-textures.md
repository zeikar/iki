---
"@iki/format": minor
"@iki/engine": minor
---

Add atlas + UV-rect textures: optional `textures` on the model and `texture` { index, uv } on parts (back-compat, no IKI_FORMAT_VERSION bump); the engine's `load()` is now async and samples atlas sub-rects with `color` as a tint multiplier.
