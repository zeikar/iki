---
"@iki/format": minor
---

Pin down which side `Left`/`Right` name in `StandardParameter`. They are the CHARACTER's own side, not the viewer's — matching Live2D, whose ids these deliberately echo — so the character's left eye/brow is the part at POSITIVE x (screen right). The frame was never stated, and the two producers in this repo had already diverged: auto-rig treats `*_L` role layers as the character's left, while both hand-authored sample models bound `EyeOpenLeft` to their screen-left eye. A host winking one eye therefore closed the opposite eye depending on where the model came from.
