---
"@ikijs/format": minor
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

An auto-rigged model fades its blush on `ParamCheek` and declares default
expressions and head motions.

- `@ikijs/format`: adds `StandardParameter.Cheek` (`ParamCheek`), the cheek
  blush's strength, 0 .. 1, raised by an expression.
- `@ikijs/editor`: `generateIkiFromLayerSet` declares `ParamCheek` (0 .. 1,
  default 0) when a `blush_L` or `blush_R` layer is present and binds each
  blush part's opacity to it, from 0.4 at rest to 1, as drawn. **A rigged
  blush now rests at 0.4 opacity**, so an existing character with a blush
  looks fainter at rest once re-rigged; Cheek 1 shows it as before. Every
  rigged model now also carries `expressions` and `motions`: the one-clip
  head motion groups `Nod`, `Shake` and `Tilt`, and up to six described
  expressions (`smile`, `laugh`, `angry`, `sad`, `surprised`, `shy`). An
  expression whose look rests on a missing part is left out (`shy` needs a
  blush, `angry` and `sad` need brows), and a kept one keeps only its terms
  on parameters the model declares. The values were picked by eye on our own
  characters (`AUTO-RIG.md`).
- `@ikijs/mcp`: `list_standard_parameters` lists `ParamCheek` (17 entries).
  `describe_iki` summarises a model's expressions (`{ id, description }`) and
  motion clips (each group's clip descriptions, by index); `IkiSummary` gains
  the required fields `expressions` and `motions`, empty when a model
  declares none. `auto_rig_from_layers` writes the Cheek binding and the
  default expressions and motions above.
