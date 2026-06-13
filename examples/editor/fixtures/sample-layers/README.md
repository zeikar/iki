## sample-layers fixtures

Named PNG layer set for the manual auto-rig import end-to-end test (plan Task 8).

Each file name is the canonical role string recognised by `parseLayerRoles` (e.g. `face.png`, `eye_L.png`, `eye_R.png`, `mouth.png`, `hair_back.png`). To verify the import flow, drag all PNGs into the editor's "Import layer set" picker and confirm the auto-rigged document loads with textures applied to each part.

To regenerate the fixture images:

```
node generate.mjs
```
