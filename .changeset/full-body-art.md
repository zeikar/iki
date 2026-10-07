---
"@ikijs/mcp": minor
"@ikijs/editor": minor
---

The art pipeline learns a full body: a taller canvas and one mirrored arm.

- `@ikijs/mcp`: `compose_layers_from_parts` takes an optional even
  `canvasHeight` (1100..4096, default 1100 — the output is byte-identical
  without it); the canvas grows downward, so every part keeps its place. One
  `arm.png` (the arm on the screen left) composes into `arm_R` as drawn and a
  mirrored `arm_L`, hung on the body box's shoulder corners by the rig's own
  pivot rule unless `layout.arm_L` / `layout.arm_R` place them; an arm needs
  `body.png`. `measure_layers` warns of feet cut by a tall canvas's bottom and
  of an arm whose shoulder cap does not reach under the torso's edge, and skips
  every `preview*.png`. `auto_rig_from_layers` decodes up to 128 Mi px and
  embeds an atlas up to 12 MiB.
- `@ikijs/editor`: `armGeometry` and `ArmGeometry` are exported.

**An atlas page over 4096 px on either side is now refused**, even where the
old area check accepted it. `IKI_FORMAT_VERSION` and the `.iki` format are
unchanged.
