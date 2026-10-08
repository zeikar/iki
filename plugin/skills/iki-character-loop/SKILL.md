---
name: iki-character-loop
description: Drive a generator/critic loop that refines a rigged Iki character (`.iki`) until it matches a reference illustration. Draws a reference with the iki-create-image skill, then alternates the iki-character-artist agent (draws, composes, tunes, rigs) with the iki-character-critic agent (scores a rubric, emits typed findings) until the critic says ship or a cap is hit. Use when a generated character is renderable but not good-looking enough, or when the user asks to iterate a character toward a target look.
---

# Iki Character Loop (generator ↔ critic)

`iki-character` produces a _renderable_ character in one pass. This skill makes
one that is _good_, by giving the process the two things a single pass lacks: a
fixed target to aim at, and someone to say how far off it is.

```
references (iki-create-image, once)
      │
      ▼
  ┌─► artist ──► rigged .iki ──► orchestrator renders ──► critic ──┐
  │                                                                │
  └──────────────── typed findings ◄───────────────────────────────┘
```

**You are the orchestrator.** You spawn both agents, carry artifacts between
them, drive the browser render, arbitrate escalations, and enforce the caps.
Neither agent talks to the other directly.

## Why a reference at all

Parts are generated independently, so nothing ties them together but a style
string — and that is not enough. Real drift from an unanchored run: a photoreal
macro-photograph iris on a flat cel-shaded face; orange highlights in the front
hair and none in the back. A reference image is a shared anchor every part is
drawn against.

## Why the critic is typed

The obvious loop — "compare, then regenerate" — cannot converge, because most
defects are not art defects. From one real session, six defects:

| Defect                        | Actual cause                     | Regeneration fixes it? |
| ----------------------------- | -------------------------------- | ---------------------- |
| Iris reads as a bead in white | the composer's iris ratio        | no                     |
| Head slides off the shoulders | auto-rig `translateX` binding    | no                     |
| Brows invisible               | draw order vs. hairstyle         | no                     |
| Lash misaligned from sclera   | a careless `layout.json` edit    | no                     |
| Straight seam on head turn    | art cut through by its own frame | yes                    |
| Photoreal iris on a flat face | art style drift                  | yes                    |

Four of six were code or constants. A critic that can only say "try again" would
have burned the quota and never fixed them. So findings are typed —
`regenerate` (billed), `retune` (free), `escalate` (orchestrator only) — and the
artist routes on the type.

## This is not really a GAN

The analogy is useful for the shape and misleading about the mechanism. A
discriminator hands the generator a gradient; here the signal is prose into a
black box with weak prompt adherence, so rounds can wander instead of descend.
That is why the caps below are not optional, and why the critic is asked to call
`stop` when it cannot name a change likely to raise a score.

## Cost

Every `regenerate` is a billed `codex exec` taking minutes. A full part set is
11 parts × 2 variants = 22 jobs. A full body adds `reference-full.png` (one
job) and `arm.png` (two).

**You cannot check the quota up front.** `codex login status` reports
authentication and nothing else — its output is byte-identical before and after
the limit is hit — so no precheck stops a run from dying halfway and leaving a
half-updated parts dir. Quota is only observable by attempting a generation: a
refused job exits non-zero and its log carries `You've hit your usage limit`
and a reset time. So fire ONE job and read its result before firing the rest —
a limit hit there costs one job instead of a batch, and the reset time is what
you hand back to the user.

`retune` rounds cost nothing: composing and measuring are pure local computation.
Prefer them, and let the artist exhaust them before spending on generation.

## Procedure

### Step 0 — workdir and references

`<workdir>` is `iki-char/` **inside the project directory** — build its tree
before anything else. Every compose and rig call goes through the MCP server,
which confines what it writes to its own cwd, so a `/tmp` workdir fails all of
them; the compose tool never creates directories, and `gen-images.sh` dies on
a missing parts dir. The `iki` repo ignores `iki-char/`; in any other project add
it to `.gitignore` before the first run, or the generated art lands in a commit.

```bash
mkdir -p iki-char/parts iki-char/layers iki-char/renders/debug
[ -f iki-char/layout.json ] || echo '{}' > iki-char/layout.json
[ -f iki-char/style.json ] || echo '{}' > iki-char/style.json
[ -f iki-char/canvas.json ] || echo '{}' > iki-char/canvas.json
```

The seed lines only write a file that is missing, so re-entering or
restarting the loop keeps the tuning you already paid for — the workdir is
gitignored, so an overwrite here has no repository copy to recover it from.
`style.json` is the per-character rig tuning surface: the `style` knobs of
`auto_rig_from_layers` (their defaults, and the recommended ranges a retune
stays inside, are in the **iki-character** skill, Step 3), where `{}` is the
profile every character starts from. Only the artist
edits it, and only on a critic `retune`. `canvas.json` stays `{}` for a bust;
a full body writes its `canvasHeight` there (below).

Every image in the loop goes through the **iki-create-image** skill. Run its
`--check` before the first one: without Codex on this machine, each billed
draw below becomes that skill's hand-off to the user, and the artist returns
`BLOCKED` with the prompts it needs written out instead of drawing.

If `<workdir>/reference.png` and `reference-30.png` already exist (a restart),
reuse them — do not regenerate. Otherwise, draw 2–3 reference candidates
with that skill's front-reference prompt and let the user pick, or accept a
reference the user supplies. It must be a single front-facing character in the
target style. Then run that skill's
`gen-turn-reference.sh <workdir>/reference.png <workdir>` once to produce
`<workdir>/reference-30.png`: the same character turned to the rig's own
`ParamAngleX` limit (30°). It is a style check, nothing more — the
critic reads it by eye for whether the character still looks like itself
turned, and nothing measures it. Nothing fits the rig to it or picks a knob's
value from it: every turn amount stays inside the recommended ranges in the
**iki-character** skill's knob table (Step 3). Drawn at 30° so the
comparison is like for like: a drawing at 45° over-asks a 30° rig by ~1.7×
(measured, not derived). Redo the generation if both eyes are not fully
visible, the torso turned with the head, or any attribute drifted from the
front reference.

A restarted workdir may still hold a `turn-targets.json` from an earlier
version of this loop; it is ignored.

**A full-body character** (only when the user asked for one) also needs
`<workdir>/reference-full.png` and the canvas's height. Once `reference.png`
is picked, draw `reference-full.png` and write `<workdir>/outfit.txt`, `<workdir>/figure.json` (the figure's
measurements) and `<workdir>/canvas.json` as the **iki-character** skill's
`full-body.md` Step 0 says. On a restart, reuse an existing `reference-full.png`,
`outfit.txt` and `figure.json`, as the other two. The `canvas.json` written there is
provisional until round 1's measuring compose corrects it (`full-body.md`
Step 2); from round 2 on the artist edits its `canvasHeight` only on a critic
`retune`, as it does `style.json`.

Then go to Step 1. `reference.png` and `reference-30.png` (and, for a full
body, `reference-full.png`) are frozen, because every round reads them and
changing any of them mid-loop or on a restart invalidates every prior score.

### Step 1 — round

1. Dispatch **`iki:iki-character-artist`** with `reference` (the front view
   only — `gen-images.sh --ref` attaches it to every job), `workdir`, `round`,
   `style` (the contents of `<workdir>/style.json`, which its rig step passes
   to `auto_rig_from_layers` when it is not empty), and the critic's findings
   (none on round 1). Both agents ship inside this plugin, so the dispatch name carries
   its namespace; a bare `iki-character-artist` does not resolve. A full body
   also passes `reference-full` (`<workdir>/reference-full.png`, which its
   `body.png` and `arm.png` jobs attach instead) and `canvas` (the contents of
   `<workdir>/canvas.json`, whose `canvasHeight` its compose step passes;
   `<workdir>/figure.json` sits beside it).

   **Expect several dispatches per round.** Generation runs as backgrounded
   jobs and a subagent cannot wait on them, so the artist returns while the
   batch is still in flight. That is not a failed round: wait for the parts to
   land, then resume the SAME agent — it holds the round's context — rather
   than dispatching a fresh one. If it returns reporting a usage limit instead,
   the round is over: take the reset time and go to Step 2.

   **An artist that returns `BLOCKED` on a hand-off file** (no Codex here,
   see Step 0) has not finished the round: give the user that file as the
   **iki-create-image** skill's hand-off says, wait until they say the images
   are in place, then resume the SAME artist to pick, compose and rig them.

   **An artist that returns no model otherwise ends the round the same way** —
   a refused rig leaves nothing to render. Skip the render and the critic (there
   is nothing to score), keep its escalation, and go to Step 2.

2. **Render it yourself.** Load the artist's `.iki` through the Model picker's
   "Load a .iki file…" entry — the same on both paths; only the load order and
   how you address parameters (id vs. panel label) differ. A full-body model
   loads the same way but is sized and captured by its own recipe, **A
   full-body model** at the end of this step.
   **Standalone (default):** open https://zeikar.dev/iki/playground/
   (Playwright MCP) and **uncheck Idle before loading anything** — `load()`
   resets every parameter to its default, and idle only restarts if the
   checkbox is still checked at load time, so unchecking first is what makes
   the rest screenshot genuine. Unchecking Idle _after_ loading is too late:
   idle has already written a live pose by then, and this build has no
   `reset()` to undo it. With Idle off, open the Model select, choose the
   trigger entry, and pick the model's **absolute** path (`browser_file_upload`
   requires one — e.g. the absolute path to `<workdir>/iki-character.iki`).
   The panel's sliders carry no `id`/`data-*`, only each parameter's label
   (`ParamAngleX` = "Head Angle", `ParamAngleY` = "Head Angle Y",
   `ParamEyeLOpen` = "Eye L", `ParamEyeBallX` = "Gaze X"), so find the
   `.control` block whose label matches, set that block's `input[type=range]`
   value, and dispatch an `input` event (`browser_evaluate`).
   **Inside an `iki` checkout:** `pnpm playground`, load the same file through
   the same picker, then drive `window.__iki.setParam` / `reset` / `nextFrame`
   by id per the **iki-visual-test** skill (repo-local, not part of this
   plugin).
   Either way, screenshot at least: rest, head-turn (`ParamAngleX` near its
   limit), blink (`ParamEyeLOpen` ≈ 0), gaze (`ParamEyeBallX` near its limit),
   and the poses **midway between the rig's keyform stops** on each moving axis
   — the turn and nod stops sit at 0 and ±30, so that is `ParamAngleX` at 15,
   `ParamAngleY` at 15, and (its stops being 0 and 1) `ParamEyeLOpen` at 0.5.
   Add one combined pose, `ParamAngleX` 30 with `ParamAngleY` 30 and
   `ParamAngleZ` 30 at once: the torso's neck follows only a little while the
   face slides, turns and rolls over it, and a neck drawn too wide or too low
   shows its flat top beside the jaw only when all three peak together.
   Rig breakage surfaces in the turn and blink poses, which a front-facing
   screenshot hides; the between-stop poses expose interpolation defects that
   the endpoint shots miss (the engine blends linearly between authored
   keyforms), so both sets need looking at.
   **The rest shot must be untouched**: standalone, that means Idle was
   already off before the model loaded and no slider has been touched since;
   in a checkout, `reset()` and screenshot, nothing set afterwards. Every
   proportion the critic measures is measured against it, so a flattering
   hero pose saved as `rest.png` silently invalidates the whole round — that
   has already happened once, and two rounds of "it looks like the reference"
   were judged against a head turned nine degrees.
   Besides the screenshots, also capture the poses `measure_turn_reference`
   needs: `canvas.toDataURL("image/png")` at `ParamAngleX` 0 (the untouched
   rest pose), at −30 and at +30 (the rig's own limit, both ways, because its
   `turn.achieved` is the mean of the two directions), via `browser_evaluate`
   — not a screenshot, because a screenshot carries the page under the canvas
   and the measurement needs the render's own transparency to tell foreground
   from background.
   **Standalone:** the prior screenshots already moved sliders, so load the
   `.iki` file through the picker once more (same flow as above, Idle already
   off) to get back to the untouched rest pose, then drive `ParamAngleX`
   through the same "Head Angle" `.control` block used above — set its
   `input[type=range]` value and dispatch an `input` event — waiting two
   animation frames before each capture so the engine has actually rendered
   the pose:
   ```js
   async () => {
     const canvas = document.getElementById("iki");
     const nextFrame = () =>
       new Promise((r) =>
         requestAnimationFrame(() => requestAnimationFrame(r)),
       );
     await nextFrame();
     const rest = canvas.toDataURL("image/png");
     const input = [...document.querySelectorAll(".control")]
       .find((c) => c.querySelector("label span")?.textContent === "Head Angle")
       .querySelector("input[type=range]");
     input.value = "-30";
     input.dispatchEvent(new Event("input", { bubbles: true }));
     await nextFrame();
     const turnM30 = canvas.toDataURL("image/png");
     input.value = "30";
     input.dispatchEvent(new Event("input", { bubbles: true }));
     await nextFrame();
     const turnP30 = canvas.toDataURL("image/png");
     return JSON.stringify({ rest, "turn-m30": turnM30, "turn-p30": turnP30 });
   };
   ```
   **Inside an `iki` checkout:** the model is already loaded, and
   `window.__iki` gives the same three by id, no reload needed:
   ```js
   async () => {
     const api = window.__iki;
     const canvas = document.getElementById("iki");
     api.reset();
     await api.nextFrame();
     const rest = canvas.toDataURL("image/png");
     api.setParam("ParamAngleX", -30);
     await api.nextFrame();
     const turnM30 = canvas.toDataURL("image/png");
     api.setParam("ParamAngleX", 30);
     await api.nextFrame();
     const turnP30 = canvas.toDataURL("image/png");
     return JSON.stringify({ rest, "turn-m30": turnM30, "turn-p30": turnP30 });
   };
   ```
   Pass `filename` to `browser_evaluate` so the JSON lands in a file instead
   of inline in the response — it lands in the CURRENT WORKING DIRECTORY (the
   repo root, for a checkout), not `.playwright-mcp/`, so move it into
   `<workdir>` before decoding. Then
   `node decode-renders.cjs <the moved file> <workdir>/renders/` writes
   `<workdir>/renders/rest.png`, `turn-m30.png` and `turn-p30.png`, beside the
   `debug/` dir Step 0 made for the critic's measurement overlays.
   Rendering stays with you because the Playwright browser is a single shared
   resource; two agents driving it collide.
   **A full-body model** (its `canvas.json` sets a `canvasHeight`, H). The
   playground frames a taller-than-wide model in a view 2.5 × its width, with
   room each side for the arms' reach in any combined pose, so a raised arm
   shows whole. Size the canvas to that view at a bust's scale before loading
   it — standalone once Idle is unchecked, in a checkout once `pnpm playground`
   is up — 1400 px wide and ceil(560·H/1100) px tall, with `browser_evaluate`:
   ```js
   () => {
     const H = 3694; // canvas.json's canvasHeight
     const canvas = document.getElementById("iki");
     canvas.style.width = "1400px";
     canvas.style.height = `${Math.ceil((560 * H) / 1100)}px`;
   };
   ```
   The engine fits the view to the canvas's client size every frame, by the
   width at exactly 560/1100: the head keeps a bust's scale, the model's box
   sits in the canvas's middle two fifths, and its top 1100 rows are the
   square at the canvas's top starting three tenths of its width in, as a bust's
   square canvas holds them. Then load the `.iki` as above and check the build
   with `browser_evaluate`:
   `() => document.getElementById("iki").classList.contains("full-body")`. True
   means the playground frames the view (a checkout always does). False means
   the deployed playground predates it: the engine then fits the model's box by
   the canvas's height, still centred and 0.05 % larger than a bust's, so the
   arms still show whole and the same crops hold the face within a pixel;
   proceed and say so in the round's report. With no slider touched, capture
   every pose in ONE `browser_evaluate`: its first capture is the untouched
   rest. Take no screenshots, as the page cannot show a canvas this tall at
   once, and the capture JSON runs to about 80 MB for a figure street's size. Each pose
   is a PNG data URL, taken two frames after it is set: the whole canvas for a
   body pose, and for a bust pose the model's square, drawn onto a 2D canvas
   of that size — the pixels a bust's render would hold, so the face
   is judged and measured exactly as on a bust. The snippet runs on both
   paths: it drives `window.__iki` by id in a checkout, and the panel's sliders
   by label standalone, where `window.__iki` does not exist. Every pose is
   reset to the defaults before the next.
   ```js
   async () => {
     const api = window.__iki; // a checkout's dev API; absent standalone
     const canvas = document.getElementById("iki");
     const nextFrame = () =>
       new Promise((r) =>
         requestAnimationFrame(() => requestAnimationFrame(r)),
       );
     const LABEL = {
       ParamAngleX: "Head Angle",
       ParamAngleY: "Head Angle Y",
       ParamAngleZ: "Head Angle Z",
       ParamEyeLOpen: "Eye L",
       ParamEyeBallX: "Gaze X",
       ParamBodyAngleX: "Body Angle X",
       ParamBodyAngleY: "Body Angle Y",
       ParamBodyAngleZ: "Body Angle Z",
       ParamArmL: "Arm L",
       ParamArmR: "Arm R",
       ParamElbowL: "Elbow L",
       ParamElbowR: "Elbow R",
     };
     const set = (id, value) => {
       if (api) return api.setParam(id, value);
       const input = [...document.querySelectorAll(".control")]
         .find((c) => c.querySelector("label span")?.textContent === LABEL[id])
         .querySelector("input[type=range]");
       input.value = String(value);
       input.dispatchEvent(new Event("input", { bubbles: true }));
     };
     const whole = () => canvas.toDataURL("image/png");
     const bust = () => {
       // The model's square: two fifths of the canvas, three tenths in.
       const side = (canvas.width * 2) / 5;
       const x0 = (canvas.width * 3) / 10;
       const crop = document.createElement("canvas");
       crop.width = crop.height = side;
       crop
         .getContext("2d")
         .drawImage(canvas, x0, 0, side, side, 0, 0, side, side);
       return crop.toDataURL("image/png");
     };
     const poses = [
       ["turn-m30", bust, { ParamAngleX: -30 }],
       ["turn-p30", bust, { ParamAngleX: 30 }],
       ["turn-15", bust, { ParamAngleX: 15 }],
       ["nod-15", bust, { ParamAngleY: 15 }],
       ["blink", bust, { ParamEyeLOpen: 0 }],
       ["blink-half", bust, { ParamEyeLOpen: 0.5 }],
       ["gaze", bust, { ParamEyeBallX: 1 }],
       [
         "combined",
         bust,
         { ParamAngleX: 30, ParamAngleY: 30, ParamAngleZ: 30 },
       ],
       ["full-turn-p30", whole, { ParamAngleX: 30 }],
       ["full-body-x-m10", whole, { ParamBodyAngleX: -10 }],
       ["full-body-x-p10", whole, { ParamBodyAngleX: 10 }],
       ["full-body-y-m10", whole, { ParamBodyAngleY: -10 }],
       ["full-body-y-p10", whole, { ParamBodyAngleY: 10 }],
       ["full-body-z-m10", whole, { ParamBodyAngleZ: -10 }],
       ["full-body-z-p10", whole, { ParamBodyAngleZ: 10 }],
       ["full-arm-l-16", whole, { ParamArmL: 16 }],
       ["full-arm-l-32", whole, { ParamArmL: 32 }],
       ["full-arm-r-16", whole, { ParamArmR: 16 }],
       ["full-arm-r-32", whole, { ParamArmR: 32 }],
       ["full-elbow-l-m10", whole, { ParamElbowL: -10 }],
       ["full-elbow-l-45", whole, { ParamElbowL: 45 }],
       ["full-elbow-l-90", whole, { ParamElbowL: 90 }],
       ["full-elbow-r-m10", whole, { ParamElbowR: -10 }],
       ["full-elbow-r-45", whole, { ParamElbowR: 45 }],
       ["full-elbow-r-90", whole, { ParamElbowR: 90 }],
     ];
     if (api) api.reset();
     await nextFrame();
     const shots = { rest: bust(), "full-rest": whole() };
     for (const [pose, capture, values] of poses) {
       for (const [id, value] of Object.entries(values)) set(id, value);
       await nextFrame();
       shots[pose] = capture();
       for (const id of Object.keys(values))
         set(id, id === "ParamEyeLOpen" ? 1 : 0);
     }
     return JSON.stringify(shots);
   };
   ```
   The bust poses are this step's own, as the model's square: `rest`; the turn pair
   `measure_turn_reference` reads (`rest`, `turn-m30`, `turn-p30`, the last
   also the head-turn); `blink`, `gaze`, the between-stop `turn-15`, `nod-15`
   and `blink-half`, and `combined`. The body poses are the whole canvas, 2.5 × the
   model's width with the figure in the middle: `full-rest`; `full-turn-p30` (`ParamAngleX` 30: the body follows the head a
   little); `ParamBodyAngleX`, `ParamBodyAngleY` and `ParamBodyAngleZ` at ±10
   ("Body Angle X", "Body Angle Y", "Body Angle Z"); `ParamArmL` and
   `ParamArmR` at 16 and 32 ("Arm L", "Arm R"; `full-arm-{l,r}-16`,
   `full-arm-{l,r}-32`); and `ParamElbowL` and `ParamElbowR` at −10, 45 and 90
   ("Elbow L", "Elbow R"; `full-elbow-{l,r}-m10`, `-45`, `-90`). Standalone,
   the arm span (−8..32) and the elbow span (−10..90) put every pose and 0 on
   a slider step, so each lands exactly and a reset returns to 0. They come
   last because a pose's values are set and cleared one after another. Pass `filename`, move the
   file and decode it into `<workdir>/renders/` with `decode-renders.cjs` as
   for the turn pair; it runs to about 80 MB. The bust crops are the critic's
   `renders` and `turn-pair`, the `full-*.png` its `body-renders`.
3. Dispatch **`iki:iki-character-critic`** with `reference`, `reference-30`, `layers`,
   `renders` (the render paths), `turn-pair` (`<workdir>/renders/rest.png`,
   `turn-m30.png` and `turn-p30.png`), `round`, `scores` (the previous rounds' `SCORES:` lines),
   and `turn-clamped` (this round's artist's own `TURN:` line, verbatim — its
   `turn.achieved`, `turn.clamped` and `turn.strandOverlap`, or "none" when no
   turn was solved) so the critic can check the render against the rig's own
   report and tell a clamp this art forced from a new turn defect. It returns
   scores and typed findings. A full body also passes `reference-full`, `figure` (the
   contents of `<workdir>/figure.json`) and `body-renders` (the whole-canvas `full-*.png` poses); its `renders` and
   `turn-pair` are the bust crops.
4. Route: `regenerate` and `retune` go back to the artist — a `retune` names a
   `layout.json` key, a `mirror-parts.json` entry or a `style.json` knob, or on
   a full body `canvas.json`'s `canvasHeight`.
   Handle `escalate` yourself — decide whether the package change is
   warranted, and if it is, make it as normal code work with a test and a
   changeset. A render-vs-report `escalate` (the critic's Δ beyond ±0.05)
   comes off the palette-quantized model, so confirm it losslessly before
   deciding: call `auto_rig_from_layers` yourself on the same layers (every
   `<workdir>/layers/*.png` but the previews, `preview.png` and `preview-pose.png`) with the same `style`, no
   `quantizeColors`, and `outputPath: <workdir>/iki-character-lossless.iki`;
   load that file and capture the same three poses as in step 2, decoding them
   into `<workdir>/renders/lossless/` (a full body: on the canvas still sized
   as in step 2, the same bust crops, its snippet's `poses` cut to `turn-m30`
   and `turn-p30`); then measure them as the critic's Step 1
   does — rest against each turn, with the `iris` window its finding names and
   `debugDir: <workdir>/renders/lossless`, the overlays checked, the two
   directions averaged — against that rig's own `turn.achieved` (the artist's
   again: the report is read off the layers, not the atlas). A Δ that closes
   was the palette moving the iris detection, and the escalation drops. A Δ
   still beyond ±0.05 is a render-vs-report discrepancy, not yet a rig defect:
   the report lands each iris's painted span and the layers' silhouette edges,
   while the tool takes iris widths from colour blobs and the head span at the
   row of the irises it detected, so the two can disagree with the rig drawing
   correctly. Diagnose it before changing either side — the raw lines of the
   lossless calls (each image's iris widths and centres, eye row, head edges,
   half-width and pair centre) and their overlays against the lossless rig's
   result (`turn.achieved`, `headHalfWidth`, `headEdges`, `strandEdges`) say
   whether the rig's landing or the tool's detection is off. Never let the loop edit
   `packages/`. A turn the art has no room
   for — the far eye at the face plate's edge, the chin at the neck's, the far
   iris at the bangs' side strand — comes back CLAMPED, not refused, so the rig
   still built; the clamp and any `strandOverlap` reach the critic in the same
   `TURN:` line (`turn-clamped`).

### Step 2 — stop

Stop on the first of:

- critic returns `ship`
- critic returns `stop`
- **3 rounds that spent generation** (the billed cap)
- two consecutive rounds in which **no axis reached a new maximum** — keep a
  high-water mark per axis, because an unweighted total nets a real `rig` 3→4
  against a `palette` 4→3 drift and reads as no progress

Then report to the user: the final render, the per-axis score trajectory across
rounds, what remains unfixed, and every escalation with your recommendation.

## Escalations you should expect

The rig's defaults are constants picked by eye on our own characters
(`packages/editor/AUTO-RIG.md`). So a turn
whose amounts read wrong on the rig's own renders — too weak or too strong,
the features leading the face too much or too little, the hair following it
too much or too little — is first a `style` retune, free and per character,
inside the recommended ranges and never toward what `reference-30.png` shows. A rig
defect is the package escalation: a seam, a fold, a part detaching from the one
it sits on, or a nod that slides instead of tipping (no `style` knob reaches
`ParamAngleY`). A render that disagrees with the rig's own report even on a
lossless pair (the critic's render-vs-report delta, re-measured as in Step 1)
is a package escalation too, but a discrepancy to diagnose — the rig's
landing or the tool's detection — not a rig defect on sight. Treat a repeated `rig` escalation as a signal to fix
the package, not to keep re-rolling art or retuning style.

## Do not

- Let either agent edit `packages/`.
- Change a frozen reference mid-loop.
- Use a licensed sample model's art as a reference — see the iki-character
  pitfalls.
- Regenerate the whole part set because one part is wrong.
- Treat `codex login status` as a quota check. It reports authentication only —
  see Cost for what a refused job actually looks like.
