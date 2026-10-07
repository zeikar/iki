---
"@ikijs/editor": minor
"@ikijs/format": minor
"@ikijs/mcp": patch
---

The full body's finishing pass: the elbow cap becomes its own part, and the
elbow bends the other way.

- `@ikijs/editor`: the elbow cap is its own part `elbow_L` / `elbow_R`, drawn
  behind the upper arm with an outlined rim along the arm's own contour (a
  model with arms gains two parts). The arm and elbow ranges shrink around the
  drawn pose: `ParamArmL/R` −8..32 (was −30..150), `ParamElbowL/R` −10..90
  (was −30..150).
- `@ikijs/format`: the `StandardParameter` docs for the elbow follow the new
  direction.
- `@ikijs/mcp`: its standard-parameter descriptions follow.

**`ParamElbowL/R` + now bends the forearm toward the body, where it bent
outward.** The ids are unchanged, so a host driving the elbow flips its sign.
Only models rigged with arms are affected; re-rig to get the new parts, the
sign and the ranges. `IKI_FORMAT_VERSION` is unchanged.
