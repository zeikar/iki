# Corpus

Committed part layers for three characters, used as a regression baseline for the auto-rig. Each character has `layers/*.png` (the role-named parts), `style.json` and, for mint, `patches.json`.

- `pnpm corpus` re-rigs every character, rewrites `examples/playground/public/<name>.iki` and `corpus/<name>/metrics.json`.
- `pnpm corpus:check` re-rigs into `.corpus-check/` and diffs against the committed files.

The rig options are the ones the character loop rigs with: `quantizeColors` 256, `style` from `style.json` (`{}` for all three, the profile's defaults), `patches` from `patches.json`, through the same `autoRigFromLayers` path as the MCP `auto_rig_from_layers` tool. All three draw the lip-set mouth, the blush (`shy`, `ParamCheek`), lower lashes and both hair layers (hair physics).

| Character   | Provenance                                                                           | Canvas              | Covers                                  |
| ----------- | ------------------------------------------------------------------------------------ | ------------------- | --------------------------------------- |
| bob         | The hero's layers with the 2026-10-10 lip set and the hero's blush                   | 1100x1100 bust      | Bust framing, no arms                   |
| mint        | The 2026-10-15 restart with the user-tuned layout and 4 accepted `eyeWarp_R` patches | 1100x3692 full body | Arms, pose forearm (Wave), patch replay |
| silver-hood | The 2026-10-11 run                                                                   | 1100x4014 full body | Arms, pose forearm, no patches          |

At commit time the mint and silver-hood baselines are byte-identical to the models the character loop last accepted for them. Bob's is a new baseline: the lip-set layers plus the hero's blush, a combination no earlier model was rigged from (its last loop rig, `bob-lips2-parab.iki`, had no blush and no `quantizeColors`).

The legacy `mouth.png` + `mouth_open.png` crossfade (still in `hero.iki`) is deliberately not covered.
