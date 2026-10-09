---
"@ikijs/editor": minor
---

Exports `mouthOpening`, `mouthFold`, `columnRuns`, `LIP_ROLES`, `LipRole`, `Opening` and `OpeningColumn`, so the composer's preview and `measure_layers` in `@ikijs/mcp` read the lip set's opening with the rig's own reader instead of a copy.

The lip set closes on one smooth line. The upper line's closing travel is one cubic pinned to zero at the opening's two end columns and fitted per column to 0.4 of the interior's span (the share, picked by eye on bob's regenerated mouth against the legacy closed drawing), and the opening's end columns are mesh knots, so the closed mouth is one smooth line ending where the line was drawn. `mouthRestShift` is exported: a lip's rest translate per column as the mesh renders it, for the composer's preview.

This is a pre-1.0 change to the rig: a lip set rigged by the released 0.21.0 closes on a different line from this release on. The fold's contract is unchanged, and the legacy `mouth` / `mouth_open` rigs are byte-identical.
