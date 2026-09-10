---
"@ikijs/mcp": patch
---

Stop two geometry warnings from prescribing the wrong fix.

`measure_layers` flagged a lash as out of sync with its sclera whenever the lash's ink was asymmetric inside the frame it shares with the white — a flick that runs one way costs a pixel or two of centre drift while the layout entry is perfectly in sync, so the warning named a retune that could not be made. The centre tolerance now scales with the eye width; the top-edge check, which is the edge the blink fold actually rides, stays strict.

An opaque canvas edge was always reported as "the art is cut off — regenerate with empty margin", but a part whose own source has margin can still be clipped by where the layout puts it, and regenerating reproduces that exactly. The two are distinguishable from what the report already measures — a canvas-clipped edge leaves no margin on that side — so the warning now names which one it is, and points at a free retune or a billed regeneration accordingly.
