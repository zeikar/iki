---
"@iki/engine": minor
---

Render clip masks via the WebGL2 stencil buffer. A part carrying `clip.masks` is drawn only where its mask parts' opaque coverage marks the stencil, using each mask's per-frame deformed geometry (so clipping stays correct under warp/gaze deformation). Mask parts still render normally in their own order slot. The context now requests a stencil buffer; if one isn't granted, models that use clipping render unclipped with a console error rather than failing silently.
