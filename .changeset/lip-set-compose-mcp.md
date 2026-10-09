---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` takes `mouth_keyed.png` (the open mouth, its inside flat #00FF00) and `mouth_interior.png` (the cavity, teeth and tongue), and writes `mouth_inner`, `lip_lower` and `lip_upper` on one frame (`layout.mouth_inner`, in `mouth_open`'s place by default). The keyed mouth is keyed at the source size, each mixed pixel read against the far end of its own colour ramp, so the line's antialiasing becomes alpha and no opaque fringe is left. It is split at the composed size, so the fold's per-column contract holds by construction, and the composer asserts it through the editor's own reader. The interior is trimmed of any lips it drew and fitted into the opening over a cavity fill, grown sideways only under ink and never up. An opaque-on-white interior keeps its near-white teeth, since only the border-connected white ground is keyed.

The composer refuses one file without the other, a mix with `mouth.png` or `mouth_open.png`, no green, green outside the opening, an outline that is not closed, an opening too small to fold, more than one opening, no skin under the opening, and an interior that is only lips, opaque on a non-white ground, or on a white ground too noisy or shaded to key (a fake-transparency checkerboard, for one). `preview.png` and `preview-pose.png` show the lip set closed as the rig draws the rest pose, each column shifted by the fold's fractional amount.

`measure_layers` gains the lip checks: a partial or mixed set, canvas sync, the per-column contract (gap, no line, skin gap, no interior), an opening too narrow or too short, an upper line under 2 px, green left over, and an interior with holes. It reports the opening's size and the fold's dead zone (`lips: opening W px wide, H px tall at its centre under a L px line — no slit below MouthOpen v`). The lip roles are exempt from the edge and flat-cut checks.

This is a pre-1.0 change to the parts dir: `mouth.png` is no longer unconditionally required, and a parts dir needs `mouth.png` or the keyed pair. Every parts dir that composed before composes byte-identically.
