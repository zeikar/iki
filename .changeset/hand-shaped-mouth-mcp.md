---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` cuts the interior's light paint (luma 100 and over) into `mouth_teeth` (above each column's middle) and `mouth_tongue` (below it) on `mouth_inner`'s frame; both are listed in `skipped` when the interior has no light paint. `mouth_inner` keeps the dark cavity, with the light paint replaced by the cavity's fill and a soft edge from the key's coverage (under alpha 128, so the fold's contract reads it as before). `preview.png` and `preview-pose.png` draw the closed line as the rig shapes it, thinned and tapered; the flick's sideways pull is not previewed.

`measure_layers` gains three checks on `mouth_teeth` / `mouth_tongue`: present without the lip set, not on the canvas size, and a box reaching outside `mouth_inner`'s.

This is a pre-1.0 change to the composed output: recomposing the same parts with this release writes a different `mouth_inner`, the two new layers and different previews from @ikijs/mcp 0.22.0's. Layers already on disk are unchanged until recomposed. Parts drawn for 0.22.0 keep composing (an interior with no light paint writes no teeth or tongue), and every legacy parts dir composes byte-identically.
