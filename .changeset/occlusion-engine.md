---
"@ikijs/engine": minor
---

Draw `IkiPart.occlusion`: a part is hidden where its `by` parts cover it (their drawn alpha at least 0.5), by an amount keyed linearly on a parameter. The part is drawn outside the coverage at full strength and inside it at `1 − amount` through the stencil buffer, so there is no seam; at amount 0, or without a stencil buffer (`load()` logs it), it draws as before. A model without the field takes the same path as before. New export `occlusionAmount(occlusion, value)`.
