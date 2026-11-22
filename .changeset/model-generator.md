---
"@ikijs/format": minor
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

A model can say what generated it. `IkiModel.generator` is an optional `{ tool, rigger?, plugin? }`, each a label such as `@ikijs/mcp@0.39.0` (not blank, at most 128 characters, no control character); `parseIkiModel` validates it and keeps it, so it survives a load and a save, and nothing reads it to draw. It is written once: a later edit in another tool keeps it as it is. `parseIkiGenerator` validates one on its own. The format version stays 1: a model without the field loads as before, and an older `@ikijs/format` loads a model that carries it and drops the field.

`@ikijs/editor` exports `EDITOR_VERSION`, its own version, for a host to record as the rigger.

`@ikijs/mcp`'s `auto_rig_from_layers` tool writes `generator` into every model: itself as `tool`, the installed `@ikijs/editor` as `rigger`, and as `plugin` the label in the server's `IKI_PLUGIN` environment variable when a plugin sets it (a value that is no label refuses the rig as `INVALID`). It is not a tool input. `describe_iki` returns it in the summary. The library function `autoRigFromLayers` writes one only when passed `generator` (`toolGenerator()` builds the tool's), so the same layers still give the same bytes across releases.
