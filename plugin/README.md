# Iki — Claude Code and Codex plugin

Make a rigged, animated 2D character by asking for one.

```
"make me an iki character: silver-haired swordswoman, flat cel shading"
   → part art → composed canvas layers → auto-rig → hero.iki
```

The result is a `.iki` model that blinks (eyelid fold), gazes, lip-syncs, turns,
nods and tilts its head with hair that sways behind it, and emotes with its
brows — playable in the browser with [`@ikijs/engine`](https://www.npmjs.com/package/@ikijs/engine).
Drawn full body (opt-in), a character raises and bends its arms and turns its
body too, and with a pose forearm waves. It also declares head motions (Nod,
Shake, Tilt) and, with a pose forearm, a Wave, and up to six default
expressions (smile, laugh, angry, sad, surprised, shy; shy needs the cheek
blush), each with a description a host picks by.

## What's in it

| Component                          | What it does                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`iki-character`** (skill)        | One pass: generate role-separated part PNGs → compose to canvas layers → auto-rig to a renderable `.iki`                                                                                                   |
| **`iki-character-loop`** (skill)   | Generator/critic loop that refines a character against a reference until it is worth shipping                                                                                                              |
| **`iki-create-image`** (skill)     | Draws the reference and the parts through the Codex CLI's image tool, or hands you the prompts when Codex is not set up; the other two skills call it                                                      |
| **`iki-character-artist`** (agent) | Draws, composes, tunes `layout.json`, re-rigs — the loop's generator half                                                                                                                                  |
| **`iki-character-critic`** (agent) | Scores a rubric and emits typed findings — the loop's discriminator half                                                                                                                                   |
| **`iki` MCP server**               | [`@ikijs/mcp`](https://www.npmjs.com/package/@ikijs/mcp) over `npx`: read/validate `.iki`, `compose_layers_from_parts`, `measure_layers`, `auto_rig_from_layers`, `measure_turn_reference`, `render_poses` |

The skills carry the hard-won part: the prompt patterns that get _clean
role-separated_ art out of an image model (an eyeless face base, an iris-free
white sclera), and how to act on the server's geometry checks — the ones that
catch the defects which cost real regeneration rounds to find by eye.

## Install

### Claude Code

```
/plugin marketplace add zeikar/iki
/plugin install iki@iki
```

Then just ask for a character. The MCP server comes with the plugin — no
separate setup.

### Codex

```bash
codex plugin marketplace add zeikar/iki
codex plugin add iki@iki
```

Restart Codex or start a new session to load the three skills and the bundled
`iki` MCP server. Ask for a character or invoke `$iki:iki-character` or
`$iki:iki-character-loop`.

In a checkout of this repo, `.agents/plugins/marketplace.json` exposes the
plugin and `.codex/config.toml` enables `iki@iki` for the trusted project;
install the local plugin from the repository root instead:

```bash
codex plugin marketplace add .
codex plugin add iki@iki
```

Both hosts share `skills/` and `.mcp.json`. Claude Code registers the two
agent files directly; the loop skill tells Codex to pass those same role
instructions to standard subagents, or run the roles sequentially when
subagents are unavailable. The loop's renders need no browser automation in either host.

The Codex manifest and repo marketplace follow the
[official OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

## Prerequisites

- **An image generator.** The skills draw through the
  [Codex CLI](https://github.com/openai/codex)'s built-in image tool: install
  it and run `codex login` (a ChatGPT plan) once. Jobs run on `gpt-6-luna`,
  not your Codex default model; set `CODEX_IMAGE_MODEL` to use another one.
  Generation is billed and takes minutes. Without Codex, the skill writes out
  the prompts for you to run in any image tool that takes a reference image and
  returns transparent PNGs, then carries on from your files.
- **A Chromium-family browser** (Chrome, Edge or Chromium) and Node 22+ for the loop's
  renders; set `CHROME_PATH` for a non-standard install.

## Versioning

`.mcp.json` pins the server to a compatible `@ikijs/mcp` range. The skills
document that server's tool schema and role table, so the pin moves with them —
when a tool schema or the role set changes, the skill text and the pin change
together.

Keep the versions in `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json` in sync when updating the shared plugin.

MIT © [Zeikar](https://github.com/zeikar)
