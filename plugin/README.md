# Iki — Claude Code plugin

Make a rigged, animated 2D character by asking for one.

```
"make me an iki character: silver-haired swordswoman, flat cel shading"
   → part art → composed canvas layers → auto-rig → hero.iki
```

The result is a `.iki` model that blinks (eyelid fold), gazes, lip-syncs, turns,
nods and tilts its head with hair that sways behind it, and emotes with its
brows — playable in the browser with [`@ikijs/engine`](https://www.npmjs.com/package/@ikijs/engine).

## What's in it

| Component                          | What it does                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **`iki-character`** (skill)        | One pass: generate role-separated part PNGs → compose to canvas layers → auto-rig to a renderable `.iki`          |
| **`iki-character-loop`** (skill)   | Generator/critic loop that refines a character against a reference until it is worth shipping                     |
| **`iki-character-artist`** (agent) | Draws, composes, tunes `LAYOUT`, re-rigs — the loop's generator half                                              |
| **`iki-character-critic`** (agent) | Scores a rubric and emits typed findings — the loop's discriminator half                                          |
| **`iki` MCP server**               | [`@ikijs/mcp`](https://www.npmjs.com/package/@ikijs/mcp) over `npx`: read/validate `.iki`, `auto_rig_from_layers` |

The skills carry the hard-won part: the prompt patterns that get _clean
role-separated_ art out of an image model (an eyeless face base, an iris-free
white sclera), and the geometry checks that catch the defects which cost real
regeneration rounds to find by eye.

## Install

```
/plugin marketplace add zeikar/iki
/plugin install iki@iki
```

Then just ask for a character. The MCP server comes with the plugin — no
separate setup.

## Prerequisites

- **An image generator.** The prompts were tuned against the `codex-image`
  skill (Codex CLI's built-in `image_generation`), but anything that returns
  transparent, role-separated PNGs works. Generation is billed and takes
  minutes.
- **`sharp`**, for the bundled composer and geometry checker. Install it once in
  the scratch dir you work from (`npm i sharp`) — the skill explains how to point
  `NODE_PATH` at it.

## Known limits

- **Render verification needs an [`iki`](https://github.com/zeikar/iki)
  checkout.** The last step loads the model in the repo's playground via the
  repo-local `iki-visual-test` skill. Standalone, load the `.iki` in your own
  viewer and drive the same parameters.
- **`sharp` is not vendored.** The composer runs as a plain script; folding it
  into the MCP server (where sharp already lives) would remove the ad-hoc
  install.

## Versioning

`.mcp.json` pins the server to a compatible `@ikijs/mcp` range. The skills
document that server's tool schema and role table, so the pin moves with them —
when `auto_rig_from_layers` or the role set changes, the skill text and the pin
change together.

MIT © [Zeikar](https://github.com/zeikar)
