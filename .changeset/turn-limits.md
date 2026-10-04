---
"@ikijs/editor": patch
---

**A model rigged from this release moves differently on the head turn in two cases: its front hair's cap, when its hair layers carry `rowRuns` (as the layer measurer gives them) and the bound bites, and its far ear, when its plate paints ear islands.** Models rigged earlier are untouched until they are rigged again, and the `.iki` format does not change. A layer set without `rowRuns` keeps its front hair, and a plate without ear islands keeps its face.

- **The cap.** On the front hair's cap (the rows above the far eye's), the turn never carries the outer edge further outside the back hair painted behind it than the nod alone puts it. That holds at every angle of the turn, the nod and the roll (the hair's sway springs are not bounded). The cap follows less than before where that back hair reaches less, and where the nod alone keeps the cap inside the back hair, it now never leaves it. The nod's own motion is unchanged. Rows the nod alone already shows outside the back hair, and rows whose back hair does not paint just inside their edge, are exempt; see AUTO-RIG.md. Below the cap the front hair moves as before.
- **The far ear.** It narrows to 0.83 of its width at ±30, as the Live2D samples' does, while its outer edge keeps its lag. Where the head moves less than the far ear's outer edge on the line under it (a plate without hair narrowing on the turn), the far ear moves rigidly at 0.44 of the face's slide and never widens.
