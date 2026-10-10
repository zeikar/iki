---
"@ikijs/editor": minor
---

A lip-set rig can carry teeth and a tongue: the optional layers `mouth_teeth` (riding the upper line) and `mouth_tongue` (riding the opening's bottom edge), clipped to `mouth_inner` and moving with their edge without deforming. Rigging throws on either without the lip set. Exports `LIP_INSIDE_ROLES`, `LipInsideRole` and `isLipInsideRole`.

The closed line is shaped by hand. The upper line, and any interior or teeth tucked under it, is thinned to 0.7 of its height at every key (`UPPER_THIN`). The closed line's ends are tapered, and a drawn flick at an end is pulled in and thinned. The skin's overlap follows the thinned line, measured up from the closed line's bottom.

API changes: `mouthFold` now returns `[dx, dy]` instead of a number; `mouthRestShift` takes the canvas pixel's `row` as well as its column, reads the mesh per triangle, and returns `undefined` outside the part's box; `Opening` gains `line(col)`.

This is a pre-1.0 change to the rig: re-rigging the same lip-set layers with this release gives a different line, overlap and dead zone (the `MouthOpen` range with no slit) from the rig @ikijs/editor 0.22.0 wrote. An existing `.iki` keeps its baked keyforms and renders as it did (no engine change). Every legacy `mouth` / `mouth_open` rig is byte-identical.
