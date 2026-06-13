## sample-psd fixture

A minimal valid PSD file for the PSD import end-to-end test (plan Task 6).

`sample.psd` is an 8-bit RGB, 320×320 document with four top-level raster layers
named `face`, `eye_L`, `eye_R`, and `mouth` — the canonical roles recognised by
`parseLayerRoles`. Each layer is a small solid-colour rect at a distinct position
so the importer's alpha-bbox detection and layer placement have real geometry to work with.

To regenerate the fixture:

```
node generate.mjs
```

**Manual smoke acceptance:** import `sample.psd` via the editor's "Import layer set"
button → a rigged model with face / eye_L / eye_R / mouth appears, same as when
importing the PNG sample set from `../sample-layers/`.
