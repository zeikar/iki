---
"@ikijs/editor": minor
---

`options.customParts` adds a part the auto-rigger has no role for (twin tails, a hairpin). Each entry names its own layer, an `anchor` role, a `tie` point and the role it is drawn `after`; the part joins the model unrigged, on `headDeformer`, with a plain grid mesh, and nothing else in the model changes but the `order` of each part drawn after an inserted one. A malformed entry throws `CustomPartError`, path-qualified. `CustomPart` and `CustomPartError` are exported. A set rigged without `customParts` (absent or empty) is byte-identical.
