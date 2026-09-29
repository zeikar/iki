---
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

Models rigged from this release turn differently in two places; a model
already rigged is untouched until it is rigged again.

`mouthWarp` gains columns over the mouth drawings' own extent, capping each
cell there at 32 px, whenever a cell was wider — its outer columns, tilt and
width are unchanged. A cell 133.8 px wide let a mouth's chord miss the
jaw-tapered turn surface it should sit on, drawing the mouth toward the near
side; the hero's grid goes from 5×5 to 9×5 nodes (`describe_iki` now reports
`gridX` 8 for it), its worst mouth-vertex miss on the turn falls from 5.29 to
0.22 model px at ±30 and from 2.74 to 0.11 at ±15, and its far/near
half-widths at ±30 go from 26.7/39.8 to 31.3/35.1 px (the surface's own
31.45/34.98). Wherever the two mouth drawings share a
centre x the turn cues are unchanged.

With a face row profile — which every `auto_rig_from_layers` rig measures —
bangs hanging below the face's widest row now hold as that row does, instead
of reading their own (jaw-tapered) row. A side lock that follows the jaw
below that row no longer creases there: the hero's crease at ±30 falls from
≈12° to 0.3°, and its below-chin slide moves from −35/+36 to −64/+64 render
px at −30/+30. Hair below the chin or on the chest now follows the head as
the widest row does, and a lock that hugs the jaw no longer rides it below
the widest row (up to ≈12 px of drift at ±30 on a test fixture; nothing on
the hero, whose locks keep ≥ 72 px of margin there). The hero's turn cues:
eyeShift 0.1803 → 0.1829 (farEyeRatio 0.670 and silhouetteRatio 1.000
unchanged), the solve's radius 351.40 → 352.03.

No public API and no `.iki` format change.

`@ikijs/mcp`'s `auto_rig_from_layers` rigs with both fixes, since this
release raises its `@ikijs/editor` floor to `^0.8.1`.
