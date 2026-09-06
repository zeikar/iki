---
"@ikijs/format": minor
"@ikijs/engine": minor
"@ikijs/editor": minor
"@ikijs/mcp": patch
---

Head tilt reaches the idle motion and the hair.

- `@ikijs/engine`: `IdleMotion` now sways `ParamAngleZ` too — the smallest and
  slowest of the three head axes (±1.1° over 11.3 s), so an idle character
  tilts as gently as it breathes. Models without the parameter ignore the
  writes, as with AngleX/Y.
- `@ikijs/format`: adds `StandardParameter.HairSwayZ` (`ParamHairSwayZ`), a
  physics output for hair swinging behind a head tilt, alongside `HairSwayX`.
- `@ikijs/editor`: when a `hair_front` layer is present the auto-rigger now
  emits a second spring rig, `hairTilt`, that lags `AngleZ` onto `HairSwayZ`
  and declares the parameter. Two rigs because a rig has exactly one input
  and one output. Hair sway is no longer a `rotate`/`translateX` binding on
  the front hair — parts have no pivot, so that turned the bangs about their
  centre and lifted the roots off the hairline. Both hair layers now carry
  root-pinned sway warps (`bakeHairSwayWarp`, exported) on `HairSwayX` and
  `HairSwayZ`: the top row stays put and the ends swing 9% of the part's
  height at full sway, so the long back hair swings further than the bangs.
  `hair_back` is a mesh part for this; it still hangs from `headDeformer`
  with no cylinder bend.
- `@ikijs/mcp`: `list_standard_parameters` lists the new parameter and spells
  out AngleZ's sign convention.
