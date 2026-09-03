---
"@ikijs/format": minor
---

Reject a `canvas.width`/`canvas.height` of zero or below. Only finiteness was checked, so meaningless extents validated cleanly and then produced silently wrong output rather than an error: one zero dimension renders the model at the wrong scale (the fit `Math.min` absorbs the infinity), both zero renders nothing, and negative extents mirror the whole character.

**Schema tightening.** This rejects models an earlier build accepted. `IKI_FORMAT_VERSION` stays at 1: before 1.0 the v1 schema may still tighten without a bump, and such changes are called out here instead.
