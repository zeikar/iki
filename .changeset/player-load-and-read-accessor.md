---
"@ikijs/engine": minor
---

Close four gaps in `IkiPlayer`, and stop keeping two copies of the fixed-timestep integrator.

- **`getParameter(id)`** — the player exposed `setParameter` and the parameter descriptors, but no way to read a live value, so every host had to shadow the store to feed the motion drivers and hand-maintain a clamp that matched `ParameterStore`. Both examples dropped their mirrors (and their local `clamp`) for this accessor.
- **`load()` reports oversized and failed texture uploads.** An atlas past the device's `MAX_TEXTURE_SIZE`, or an out-of-memory upload, left a non-null but unsamplable texture that was counted as a success and rendered black. Both are now checked and reported through `failedTextures`.
- **`IkiLoadResult.superseded`** distinguishes "a newer `load()` overtook this one" from "everything loaded". The losing call returned an empty `failedTextures`, which a caller could not tell from a clean load.
- **`start()` is a no-op after `destroy()`**, instead of scheduling a render loop against a deleted program and buffers.

Internally, `clamp` (5 copies), `MAX_DT_MS` (3) and the fixed-step accumulator (2) now live in `math.ts` and `frame-clock.ts`. The physics drivers still do not import from each other; behavior is unchanged.
