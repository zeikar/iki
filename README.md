# Iki

[![@ikijs/engine on npm](https://img.shields.io/npm/v/@ikijs/engine?label=%40ikijs%2Fengine&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/engine)
[![@ikijs/format on npm](https://img.shields.io/npm/v/@ikijs/format?label=%40ikijs%2Fformat&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/format)
[![@ikijs/mcp on npm](https://img.shields.io/npm/v/@ikijs/mcp?label=%40ikijs%2Fmcp&color=cb3837&logo=npm)](https://www.npmjs.com/package/@ikijs/mcp)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=anthropic&logoColor=white)](./plugin)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](./plugin#codex)
[![Live demo](https://img.shields.io/badge/demo-zeikar.dev%2Fiki-E9A23B)](https://zeikar.dev/iki/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with HyperClaude](https://img.shields.io/badge/Built%20with-HyperClaude-D97757?logo=anthropic&logoColor=white)](https://zeikar.dev/hyperclaude/)

<p align="center">
  <img src="./.github/assets/hero.gif" width="360" alt="An Iki character turning its head, blinking and talking, rendered by the engine." />
  <br />
  <sub>Parts drawn by an image model and rigged by Iki's auto-rigger, with no hand rigging. <a href="https://zeikar.dev/iki/">See it live</a>.</sub>
</p>

<h3 align="center">The open Live2D alternative that rigs itself.</h3>

> 息 (breath) · 生き (life) · 粋 (chic)

**Iki** is a free, MIT-licensed engine that plays animated 2D characters in a
web page — an alternative to Live2D and [Inochi2D](https://inochi2d.com/). Its
auto-rigger takes a character split into parts (face, eyes, mouth, hair…) and
wires them to move, which is what "rigging" means here: the character blinks,
looks around, talks, turns and nods, with hair that sways. Start from whichever
you have:

- **A sentence** — AI rigging, in Claude Code or Codex (the AI coding
  assistants). Install the [plugin](#make-a-character-with-ai), ask for a
  character, and an image model [draws every part](#draw-every-part).
- **One finished picture** — AI rigging, in Claude Code or Codex. The plugin
  [cuts a front-facing bust into parts](#cut-a-picture-you-already-have) and
  paints in what each part hides.
- **Layers you already have** — only a browser. One PNG per part, or a simple
  PSD of the same layers, is
  [rigged in the editor](#auto-rig-layers-you-already-have): no AI, no install,
  no upload.

**Try it now, no install:**
[watch the editor rig a sample character](https://zeikar.dev/iki/editor/?sample)
· [drive a finished one in the playground](https://zeikar.dev/iki/playground/)

<p align="center">
  <img src="./.github/assets/import.gif" width="680" alt="A finished front-facing picture of a twin-tailed girl, still on the left; on the right the same picture rigged by Iki, turning its head, blinking and talking." />
  <br />
  <sub>One finished picture, left, and the model cut from it, right: the hero's character, made the other way.</sub>
</p>

Whichever way, you get one `.iki` file: plain JSON you own, textures included.
The WebGL runtime [plays it in any browser](#play-a-model), and your app drives
it by setting its mouth, gaze and expression, as
[Charivo](https://github.com/zeikar/charivo), a framework for talking AI
characters, does: in its live demo you can talk to
[Twin](https://charivo.vercel.app/?character=twin), the character above, or
to [Mint](https://charivo.vercel.app/?character=mint), a full body, with
chat, voice and lip-sync.

## Make a character with AI

Two of the three ways in go through one plugin: have an image model **draw every
part**, or **cut a picture you already have** into parts. Either way you get a
rigged `.iki` model. Install the plugin in
[Claude Code](https://github.com/anthropics/claude-code):

```
/plugin marketplace add zeikar/iki
/plugin install iki@iki
```

Or in [Codex](https://github.com/openai/codex):

```bash
codex plugin marketplace add zeikar/iki
codex plugin add iki@iki
```

Start a new Codex session to load it. Both get the same thing: the plugin's
instructions ("skills") and the tool server the assistant calls (an MCP
server). See the [plugin installation guide](./plugin#codex) for a local
checkout and prerequisites.

### Draw every part

Ask for a character — _"make me an iki character: short copper bob, green
eyes, school uniform"_. The plugin:

1. **Draws** each part on its own with an image model — face, eyes, irises,
   brows, mouth, nose, front and back hair, torso.
2. **Composes and checks** them on one canvas (`compose_layers_from_parts`,
   `measure_layers`), catching the geometry that would break in motion.
3. **Rigs** them (`auto_rig_from_layers`): eyelid-fold blink, gaze, lip-sync,
   head turn, nod and tilt, brows, breathing and hair physics, written to a
   `.iki` model.

The drawing runs through the [Codex CLI](https://github.com/openai/codex)'s
image tool, even from Claude Code, so it needs `codex login` on a ChatGPT plan.
Each image is billed and takes a few minutes, and a character is fifteen to
twenty images (some parts are drawn twice to pick the better one); without
Codex, the plugin hands you the prompts to run in another image tool. The tool
server needs Node 22 or later, and checking the renders needs Chrome, Edge or
Chromium.
See the plugin's [prerequisites](./plugin#prerequisites).

One pass gives a first draft, written to `iki-char/iki-character.iki` in the
folder you ran it from ([open it](#see-your-model-move); in a repository, add
`iki-char/` to `.gitignore`). The character at the top of this page started
as one and was refined with the plugin's `iki-character-loop`.

### Cut a picture you already have

Hand the plugin one finished, front-facing picture — _"rig this picture so it
moves: `my-character.png`"_ — as in the capture near the top of this page. Its
`iki-import-illustration` skill finds where the eyes, mouth and hair are on the picture (`view_illustration_grid`), cuts it into layers in place and
fills in what each layer hides (`cut_layers_from_illustration`), then rigs
them as above. The model keeps the picture's own pixels, so at rest it is your
picture; a closed mouth is stretched open to talk, and a generated mouth talks
more cleanly (the skill asks before drawing one).

It needs a front-facing bust on a transparent or one-colour background, with
both eyes uncovered and the face at least about a quarter of the picture's
width. A three-quarter view, a hand or a prop over the face, or a busy
background is turned away. In a full-body picture the arms stay painted on the
body and the face comes out too small, so crop it to a bust first, keeping a
little more below the chin than there is from the eyes to the chin: a crop that
ends just under the chin is turned away too.

## Auto-rig layers you already have

Art already separated into layers needs no AI and no install. Open the
[editor](https://zeikar.dev/iki/editor/), press **Import layer set** in the
right-hand panel, and pick one PNG per part, or a PSD of the same layers. The
auto-rigger measures them and rigs them in the browser, in seconds, and the
files never leave it. **Export .iki** downloads the model. No art at hand?
[Watch it rig a sample set](https://zeikar.dev/iki/editor/?sample), or press
**Try sample layers** in the editor.

Each layer's name says which part it is. All layers are the same size, each
part drawn where it sits on the character.
`Eye-L`, `eye l` and `eye_L.png` all read as `eye_L`; `_L` and `_R` are the
character's own left and right, so `eye_L` is on the viewer's right.

| Layer                                                            | What it is                                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `face` (required)                                                | The head's skin, drawn without the eyes                                                                                                                                                                   |
| `eye_L`, `eye_R` (required)                                      | Each eye. With `iris_*`, `lash_*` and `lash_lower_*` as layers of their own, the eye white alone: it folds shut under the lash, and the iris (with optional `pupil_*` and `highlight_*`) follows the gaze |
| `mouth`, or `mouth_inner` + `lip_lower` + `lip_upper` (required) | A closed mouth, with an optional `mouth_open` to cross-fade to; or a lip set that folds open, with optional `mouth_teeth` and `mouth_tongue`                                                              |
| `brow_L`, `brow_R`                                               | Brows, raised and angled by expressions                                                                                                                                                                   |
| `nose`                                                           | A nose drawn apart from the face, so it leads the head turn                                                                                                                                               |
| `hair_front`, `hair_back`, `hair_side_L`, `hair_side_R`          | Bangs and back hair, which sway on springs, and the locks beside the ears, rooted under the bangs (they need `hair_front`)                                                                                |
| `body`, `arm_L`, `arm_R`                                         | The torso, which breathes and turns, and hanging arms that raise and bend (they need `body`)                                                                                                              |
| `blush_L`, `blush_R`                                             | A cheek blush that rests faint and deepens with an expression                                                                                                                                             |
| `forearm_pose_L`, `forearm_pose_R`                               | A second forearm drawn raised, which swaps in to wave (they need the arm)                                                                                                                                 |

The rig is only as good as the separation: a face with the eyes painted on, or
hair in one piece, has nothing to move apart. A PSD has to be a plain stack of
those layers: every layer one visible raster part, named for its part, at normal
blend and full opacity. Delete a background or sketch layer, and merge groups,
masks, clipped layers and effects into their part; text, shape, smart-object
and adjustment layers are refused too, each by name (8-bit RGB, up to 64
megapixels, no PSB). For one flattened picture, use
[the cut](#cut-a-picture-you-already-have) above.

An agent or a script does the same from PNG paths with `auto_rig_from_layers`
in [`@ikijs/mcp`](./packages/mcp), and the function under both is
`generateIkiFromLayerSet` in [`@ikijs/editor`](./packages/editor#auto-rig).

## See your model move

Every way in ends with a `.iki` file: the editor's **Export .iki** downloads
it, and the plugin writes it in the folder you ran it from, usually under
`iki-char/`. Open the [playground](https://zeikar.dev/iki/playground/) and
choose **Load a .iki file…** in the **Model** list. Leave **Idle** on to watch it blink
and look around, press an expression, or drag a slider to pose it yourself
(that turns Idle off). To put it
in your own page, see [Play a model](#play-a-model).

## Play a model

A `.iki` file is played by [`@ikijs/engine`](./packages/engine), a WebGL2
runtime, on a `<canvas>` in your own page:

```bash
npm install @ikijs/engine @ikijs/format
```

```ts
import { IkiMotion, IkiPlayer } from "@ikijs/engine";
import { loadIkiModel, StandardParameter } from "@ikijs/format";

const canvas = document.querySelector("canvas")!;
// Your own file, or this one to start with: the character at the top of the page.
const url = "https://zeikar.dev/iki/playground/hero.iki";
const model = loadIkiModel(await (await fetch(url)).text());

const player = new IkiPlayer(canvas);
await player.load(model);

// Alive on its own: blinking, breathing, a wandering gaze, hair physics.
const motion = new IkiMotion(
  model,
  (id) => player.getParameter(id),
  (id, value) => player.setParameter(id, value),
);

let mouthOpen = 0; // 0 to 1, from your lip-sync

const tick = (now: number) => {
  motion.update(now);
  // What your app drives goes after update(), so it wins.
  player.setParameter(StandardParameter.MouthOpen, mouthOpen);
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
// Started after the tick, so each frame is drawn with the pose just set.
player.start();
```

That is the whole integration, in a module script. Give the canvas a CSS size
and the player fills it. The engine knows nothing about your app: you set
parameters (named sliders such as mouth open or head angle), and it draws.
Every auto-rigged model answers to the same
[standard parameter ids](./packages/format/src/parameters.ts), so nothing is
wired per model, and `motion.playExpression("smile")` or
`motion.playMotion("Nod", 0)` plays what the model declares.
`motion.setGazeTarget(x, y)` holds the eyes on a point, each from -1 to 1,
and the head follows them. A full-body model
is framed with `player.setView` ([`@ikijs/engine`](./packages/engine#usage)).

It runs wherever WebGL2 does: a browser, an Electron window, an OBS browser
source. There is no native or Unity runtime.

For a character that talks, you do not have to write that loop. In a Charivo
app, [`@charivo/render-iki`](https://www.npmjs.com/package/@charivo/render-iki)
is the renderer for a `.iki` model, and Charivo's chat, voice, lip-sync and
expressions drive it.

## What it is not, yet

Iki is early (0.x). It rigs and plays characters; it is not a VTuber app.
There is no webcam face tracking, so something has to drive the character:
your code, or a host app such as [Charivo](https://github.com/zeikar/charivo).
Characters are front views that turn about 30° either way, not full 3D turns.
It cannot load Live2D models. And until 1.0 the `.iki` format can still change:
a newer release may refuse a model an older one saved
([details](./packages/format#stability)).

## How Iki compares

Live2D Cubism is the industry standard, and it is far more mature than Iki in
every dimension that matters to an artist — editor, tooling, ecosystem, and the
quality ceiling of what you can rig with it. [Inochi2D](https://inochi2d.com/)
is the established open-source project in this space. Iki is not trying to
replace either. It exists because three things it wanted never lined up in one
place: a permissive license, a plain-text format, and a rig an agent can build.

- **Characters an AI agent can build.** Part images in, a rigged model out,
  through the Claude Code / Codex plugin or any MCP client. That is the part
  Iki is really exploring.
- **Free for commercial use.** MIT: no publication license, no revenue tiers.
- **Open format.** The `.iki` model is plain, typed and validated JSON you
  own, which is what makes generating one tractable in the first place.
- **Web-native.** A WebGL runtime in TypeScript, with no native toolchain.

|                          | Live2D Cubism                                                                                                                                            | Inochi2D                     | Iki                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| License                  | Proprietary SDK license; a publication license is required to distribute, with exemptions for individuals and small businesses ([terms][live2d-license]) | BSD-2-Clause                 | **MIT** — free for commercial use                                                                 |
| Editor                   | Cubism Editor (paid PRO tier, free tier)                                                                                                                 | Inochi Creator (open source) | A browser editor that auto-rigs layers, and an editing library for tools (early)                  |
| Model format             | `.moc3`, compiled and proprietary                                                                                                                        | Open                         | Plain JSON, typed and validated                                                                   |
| Runtime                  | Native SDKs, including a Web SDK                                                                                                                         | Native (D)                   | TypeScript + WebGL2, `npm install`                                                                |
| An AI agent can build it | —                                                                                                                                                        | —                            | Yes: a Claude Code / Codex plugin that draws a character, or cuts one from a picture, and rigs it |
| Maturity                 | Industry standard                                                                                                                                        | Established                  | Early (0.x, schema still settling)                                                                |

[live2d-license]: https://www.live2d.com/en/sdk/license/

If you need production-grade 2D rigging today, use Cubism. If you want an open
web format you can script against, that is what this is.

## Packages

| Package                                          | What it is                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [`@ikijs/engine`](./packages/engine)             | The WebGL2 runtime that plays a `.iki` model                                                                |
| [`@ikijs/format`](./packages/format)             | The `.iki` format: types, loader and validator                                                              |
| [`@ikijs/editor`](./packages/editor)             | The auto-rigger and an editing core with no screen of its own (commands, undo and redo), for building tools |
| [`@ikijs/mcp`](./packages/mcp)                   | The tool server an AI assistant calls (MCP): compose and check parts, cut a picture, rig, render poses      |
| [`plugin/`](./plugin)                            | The Claude Code / Codex plugin: the character skills and the tool server in one install                     |
| [Playground](https://zeikar.dev/iki/playground/) | Sliders on six test models, or a `.iki` file of your own ([source](./examples/playground))                  |
| [Editor](https://zeikar.dev/iki/editor/)         | Auto-rig layers, edit parts, deformers and physics, export a `.iki` ([source](./examples/editor))           |

## Quick start (this repo)

Needs Node 22.13 or later and pnpm 11.

```bash
pnpm install
pnpm build
pnpm playground   # open the Vite URL and drag the sliders
```

## The `.iki` format

A model is one JSON document: a flat list of parts drawn back to front, the
parameters that move them, and optional deformers, physics, expressions and
motion clips. One the tools write also records which versions made it
(`generator`). The schema's types, a small hand-written example, the left/right
convention and the stability rules are in
[`@ikijs/format`](./packages/format#the-model).

## FAQ

**Can I use this commercially?** Yes — MIT, for everything in this repo. Models
you make are yours.

**Is this AI rigging?** The rigging is automatic, and an AI agent drives it: it
draws or cuts the parts, reads the checks, tunes the rig's settings and rigs
the parts that have no standard name, such as twin tails. The rigger itself is
geometry measured from the layers' pixels, with no model to download, which is
why it also runs in the browser with no AI at all.

**Can it auto-rig a PSD?** Yes, a simple one: layers named by part, with
groups, masks and effects merged in. See
[Auto-rig layers you already have](#auto-rig-layers-you-already-have).

**Can it rig a single image?** Yes, through the plugin, which
[cuts one finished, front-facing picture](#cut-a-picture-you-already-have)
into layers and rigs those. It needs an AI coding assistant to read the
picture; there is no one-click upload.

**Can it load Live2D models?** No. `.moc3` is a proprietary compiled format;
Iki has its own open format and no importer for it.

**Do I need the editor to use it?** No. `@ikijs/engine` and `@ikijs/format`
are enough to [play a model](#play-a-model). The editor app is where you
auto-rig layers, and `@ikijs/editor` is for building authoring tools.

## Roadmap

[ROADMAP.md](./ROADMAP.md) tracks what has landed and what is deferred.

## License

MIT © Zeikar
