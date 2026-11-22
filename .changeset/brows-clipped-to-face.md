---
"@ikijs/editor": minor
"@ikijs/mcp": patch
---

The auto-rig clips a brow to the face (`clip: { masks: ["face"] }`) when every opaque pixel of the brow lies on the face's. A brow slides farther on a head turn than the face's edge does, so the end of a brow drawn out to the temple used to show over the hair beside the face at a wide turn; now the face cuts it there. A brow drawn past the face's paint, or measured without `rowRuns`, is left whole. The rest pose keeps every opaque pixel of the brow; a soft edge pixel of a brow that lies on the face's own soft edge can be cut. `createLayerSetMeasurer` records `rowRuns` for `brow_L` and `brow_R`.

A clipped part cannot occlude, so a custom part's `occlusion.by` that names the role of a brow drawn on the face is now refused where it was accepted. `render_poses` with `hideParts: ["face"]` now asks for such brows to be hidden with it, as it does for any clip mask.
