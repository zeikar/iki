# Corpus

Committed part layers for three characters, used as a regression baseline for the auto-rig. Each character has `layers/*.png` (the role-named parts), `rig-plan.json` and, when a character has accepted patches, `patches.json` (none does today).

- `pnpm corpus` re-rigs every character, rewrites `examples/playground/public/<name>.iki` (bob's is `hero.iki`, the site's hero) and `corpus/<name>/metrics.json`.
- `pnpm corpus:check` re-rigs into `.corpus-check/` and diffs against the committed files.

The rig options are the ones the character loop rigs with: `quantizeColors` 256, `rigPlan` from `rig-plan.json` (`{}` for all three, the profile's defaults), `patches` from `patches.json`, through the same `autoRigFromLayers` path as the MCP `auto_rig_from_layers` tool. All three draw the lip-set mouth, the blush (`shy`, `ParamCheek`), lower lashes and both hair layers (hair physics).

| Character   | Provenance                                                                                              | Canvas              | Covers                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| bob         | The hero's layers with the 2026-10-10 lip set and the hero's blush                                      | 1100x1100 bust      | Bust framing, no arms; the site's hero |
| mint        | The 2026-10-15 restart with the user-tuned layout; since 2026-10-30 its eyes 10% smaller and no patches | 1100x3692 full body | Arms, pose forearm (Wave)              |
| silver-hood | The 2026-10-11 run                                                                                      | 1100x4014 full body | Arms, pose forearm, no patches         |

When first committed, the mint and silver-hood baselines are byte-identical to the models the character loop last accepted for them. Bob's is a new baseline: the lip-set layers plus the hero's blush, a combination no earlier model was rigged from (its last loop rig, `bob-lips2-parab.iki`, had no blush and no `quantizeColors`).

Mint's four `eyeWarp_R` patches were dropped on 2026-10-30: they existed only at `ParamAngleX` −30 with `ParamAngleY` −30 and 0, so a nod with the head turned slid the far eye in and out (the gap between the eyes breathed by about 12 px); with the eyes made smaller the far eye clears the ear without them. The corpus no longer replays a patch; the patch layer's own tests cover it.

The legacy `mouth.png` + `mouth_open.png` crossfade is deliberately not covered; no committed model uses it.
