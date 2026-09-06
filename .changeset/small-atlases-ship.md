---
"@ikijs/mcp": minor
---

`auto_rig_from_layers` takes an optional `quantizeColors` (2..256) that
palette-quantizes the embedded atlas PNG. Flat-shaded character art keeps its
look at 256 colours while the model drops to roughly a quarter of its lossless
size — the hero demo went from 3.5MB to 0.9MB — which is what makes a generated
model shippable on a page. Omitted, the atlas is lossless as before.
