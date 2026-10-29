---
"@ikijs/mcp": minor
---

`render_poses` takes an opt-in `sweep` (the `turn` preset): an eased ±30 `ParamAngleX` turn with the hair physics running and the idle off, written to `<outDir>/<name>/` as 90 frames, `manifest.json`, a nine-frame `sheet.png`, an eye-row `kymograph.png` and a flipbook `index.html`, framed by a fixed `crop` or the standard shots. The text lists its paths and adds report-only `SWEEP` lines (amplitude, centre-crossing kink, lead over the face plate, pop) computed from the engine's geometry with the new `landParts`, which the Node bundle now carries; the result gains `sweep`. A server before this version strips the `sweep` input and renders the stills alone.
