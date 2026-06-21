---
"@iki/format": minor
"@iki/editor-core": minor
"@iki/mcp": minor
---

Auto-rig now generates hair-sway secondary motion. `@iki/format` adds a `StandardParameter.HairSwayX` id (a physics-OUTPUT sway driver). `@iki/editor-core`'s `generateIkiFromLayerSet` now emits, when a `hair_front` layer is present, a `HairSwayX` parameter, a rotate + translateX sway binding on the front-hair part, and one `IkiPhysics` rig that lags `ParamAngleX` onto `HairSwayX` — so every auto-rigged / MCP-generated / skill-built character with front hair sways on head turn out of the box (no manual rigging). `@iki/mcp`'s `list_standard_parameters` now advertises `HairSwayX` (annotated as physics-output). No-hair models are unchanged (no extra param, no physics). Additive — no `IKI_FORMAT_VERSION` bump.
