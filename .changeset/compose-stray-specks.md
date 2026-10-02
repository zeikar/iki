---
"@ikijs/mcp": patch
---

`compose_layers_from_parts` no longer lets a stray speck beside a part's drawing set the part's box. A faint mark detached from the drawing, one that never reaches alpha 128 and covers under 1 % of the part's pixels, such as residue a background removal left, is cut out with the margin it widened, so it can no longer pull the part off its `cx`/`cy` or shrink it under its `w`. On one generated torso it had placed the torso 32 px off centre. A part with such a speck now composes centred and at its full size. Every other part composes byte-identically, and a detached stroke that reaches alpha 128 (a wisp, a strand) is kept.
