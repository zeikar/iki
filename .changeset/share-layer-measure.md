---
"@ikijs/editor": minor
"@ikijs/mcp": patch
---

`@ikijs/editor` now exports `createLayerSetMeasurer`, along with `RgbaLayer`,
`LayerSetMeasurer` and `LayerSetMeasurement`, and the seven pixel rules it
shares with `@ikijs/mcp`'s other tools — `ALPHA_OPAQUE`, `HEAD_BAND`,
`SPECK_CORE_FRACTION`, `denseCoreOf`, `isSpeckCore`, `foregroundSpan` and
`headHalfOf` — moved from `@ikijs/mcp`, where they lived beside the
pre-rig measurement they were tuned for.

`auto_rig_from_layers` now measures through it instead of its own inline
steps, with unchanged results: the playground hero re-rigs byte-identical,
and its turn report is unchanged. `measure-turn.ts` re-exports the moved
rules, so `compose_layers_from_parts`, `measure_layers` and mcp's own tests
keep importing them from the same place. This release raises mcp's
`@ikijs/editor` dependency to `^0.9.0`.

The editor example app's layer import now measures its layers the same
way, through the same accumulator, so a model it builds and one
`auto_rig_from_layers` builds from the same layers rig identically.

No `.iki` format change.
