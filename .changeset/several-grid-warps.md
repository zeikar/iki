---
"@ikijs/format": minor
"@ikijs/editor": patch
---

A warp deformer may carry several 1D grid warps, summed.

- `@ikijs/format`: `warps` on a warp deformer may now hold several entries,
  one per parameter; each is clamped and interpolated on its own parameter
  and their offsets are added to the rest grid (`@ikijs/engine` already
  summed them, so the runtime is unchanged). A repeated parameter, or
  `warps` together with `warp2d`, is rejected with a path-qualified
  `IkiFormatError`. `IKI_FORMAT_VERSION` is unchanged (v1 is unstable before
  1.0), but **a model that uses this is rejected by an earlier
  `@ikijs/format`**, so a host on an older format cannot load it.
- `@ikijs/editor`: `CaptureGridKeyform` refuses a warp deformer that carries
  several grid warps, before the model or the undo stack changes.
