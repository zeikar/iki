---
"@ikijs/editor": patch
---

The auto-rig's front hair no longer kinks at the bottom of its cap on the turn. Below a cap row at or below the plate's top that blends toward the back hair's motion, the blend ramps out evenly to the eyes' top (where the far eye's lead is whole) instead of stepping to the face's ride in one vertex row, and no cap row blends less than the one under it. Blunt bangs lean across those rows on the turn instead of bending in one, and a cap row the back hair does not back takes the ramp too. From the first vertex row at or below the eyes' top down the front hair moves as before, and a model whose cap blends nothing (the hero) is unchanged. `@ikijs/mcp` picks this up through its `workspace:^` dependency, on top of its own patch.
