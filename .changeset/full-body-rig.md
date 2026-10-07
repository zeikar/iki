---
"@ikijs/format": minor
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

The auto-rig learns a full body: a body warp that follows the head a
little, and arms with an elbow.

- `@ikijs/format`: seven standard parameter ids — `ParamBodyAngleX/Y/Z`
  (±10, Live2D's convention: + turns the body to screen right / moves it up /
  tilts it clockwise) and `ParamArmL/R` and `ParamElbowL/R` (degrees; + raises
  the arm outward and bends the forearm the same way, mirrored per side).
- `@ikijs/editor`: every layer set with a `body` now rigs one root
  `bodyWarp` in place of `bodyDeformer`. It breathes, turns on
  `ParamBodyAngleX/Y/Z`, follows the head's turn and tilt a little, and keeps
  everything below the hips planted; the head hangs from it, with its own
  breath and roll reduced so the head moves as before. New `arm_L` / `arm_R`
  roles each become an upper arm and a forearm (`forearm_L/R`) on shoulder and
  elbow rotations, and need a `body`. `partIdsOfRole` names the parts a role
  layer becomes; `LayerGeometryError` reports art the rig cannot build on (a
  body whose hips leave no row line under its pivots, or too little room for
  its motion; an arm too short for its width). The layer measurer records `rowRuns` for the body and the arms.
- `@ikijs/mcp`: `auto_rig_from_layers` rigs arm PNGs, texturing both arm
  parts from one crop; an arm without a body, or art the rig cannot build
  on, comes back as `{ ok: false }`. `list_standard_parameters` returns 24
  ids.

**Busts change on their next re-rig:** the torso now follows the head a
little. Rigged models with a body use a matrix deformer under a warp and
several 1D grid warps on one deformer, so a host needs `@ikijs/format` ≥ 0.5.0
and `@ikijs/engine` ≥ 0.5.0 to load them. `IKI_FORMAT_VERSION` is unchanged
(v1 is unstable before 1.0).
