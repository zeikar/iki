---
name: iki-character-loop
description: Drive a generator/critic loop that refines a rigged Iki character (`.iki`) until it matches a reference illustration. Generates a reference with codex-image, then alternates the iki-character-artist agent (draws, composes, tunes, rigs) with the iki-character-critic agent (scores a rubric, emits typed findings) until the critic says ship or a cap is hit. Use when a generated character is renderable but not good-looking enough, or when the user asks to iterate a character toward a target look.
---

# Iki Character Loop (generator ↔ critic)

`iki-character` produces a _renderable_ character in one pass. This skill makes
one that is _good_, by giving the process the two things a single pass lacks: a
fixed target to aim at, and someone to say how far off it is.

```
references (codex-image, once)
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
11 parts × 2 variants = 22 jobs.

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
them; the compose tool never creates directories, and `gen-parts.sh` dies on a
missing parts dir. The `iki` repo ignores `iki-char/`; in any other project add
it to `.gitignore` before the first run, or the generated art lands in a commit.

```bash
mkdir -p iki-char/parts iki-char/layers iki-char/renders/debug
[ -f iki-char/layout.json ] || echo '{}' > iki-char/layout.json
[ -f iki-char/style.json ] || echo '{}' > iki-char/style.json
```

The two seed lines only write a file that is missing, so re-entering or
restarting the loop keeps the tuning you already paid for — the workdir is
gitignored, so an overwrite here has no repository copy to recover it from.
`style.json` is the per-character rig tuning surface: the `style` knobs of
`auto_rig_from_layers` (their defaults and ranges are in the **iki-character**
skill, Step 3), where `{}` is the measured Live2D profile every character
starts from. Only the artist edits it, and only on a critic `retune`.

If `<workdir>/reference.png` and `reference-30.png` already exist (a restart),
reuse them — do not regenerate. Otherwise, generate 2–3 reference candidates
with the **codex-image** skill and let the user pick, or accept a reference
the user supplies. It must be a single front-facing character in the target
style. Then run `gen-turn-reference.sh <workdir>/reference.png <workdir>` once
to produce `<workdir>/reference-30.png`: the same character turned to the
rig's own `ParamAngleX` limit (30°). It is a style check, nothing more — the
critic reads it by eye to judge how this character's turn should look, and
nothing measures it. Drawn at 30° so the comparison is like for like: a
drawing at 45° over-asks a 30° rig by ~1.7x (measured, not derived). Redo the
generation if both eyes are not fully visible, the torso turned with the head,
or any attribute drifted from the front reference.

A restarted workdir may still hold a `turn-targets.json` from an earlier
version of this loop; it is ignored.

Then go to Step 1. `reference.png` and `reference-30.png` are frozen, because
everything is judged against them and changing either of them mid-loop or on
a restart invalidates every prior score.

### Step 1 — round

1. Dispatch **`iki:iki-character-artist`** with `reference` (the front view
   only — `gen-parts.sh` attaches it to every job), `workdir`, `round`,
   `style` (the contents of `<workdir>/style.json`, which its rig step passes
   to `auto_rig_from_layers` when it is not empty), and the critic's findings
   (none on round 1). Both agents ship inside this plugin, so the dispatch name carries
   its namespace; a bare `iki-character-artist` does not resolve.

   **Expect several dispatches per round.** Generation runs as backgrounded
   jobs and a subagent cannot wait on them, so the artist returns while the
   batch is still in flight. That is not a failed round: wait for the parts to
   land, then resume the SAME agent — it holds the round's context — rather
   than dispatching a fresh one. If it returns reporting a usage limit instead,
   the round is over: take the reset time and go to Step 2.

   **An artist that returns no model ends the round the same way** — a
   refused rig leaves nothing to render. Skip the render and the critic (there
   is nothing to score), keep its escalation, and go to Step 2.

2. **Render it yourself.** Load the artist's `.iki` through the Model picker's
   "Load a .iki file…" entry — the same on both paths; only the load order and
   how you address parameters (id vs. panel label) differ.
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
   `ParamAngleZ` 30 at once: the torso's neck stays still while the face
   slides, turns and rolls over it, and a neck drawn too wide or too low shows
   its flat top beside the jaw only when all three peak together.
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
3. Dispatch **`iki:iki-character-critic`** with `reference`, `reference-30`, `layers`,
   `renders` (the render paths), `turn-pair` (`<workdir>/renders/rest.png`,
   `turn-m30.png` and `turn-p30.png`), `round`, `scores` (the previous rounds' `SCORES:` lines),
   and `turn-clamped` (this round's artist's own `TURN:` line, verbatim — its
   `turn.achieved`, `turn.clamped` and `turn.strandOverlap`, or "none" when no
   turn was solved) so the critic can check the render against the rig's own
   report and tell a clamp this art forced from a new turn defect. It returns
   scores and typed findings.
4. Route: `regenerate` and `retune` go back to the artist — a `retune` names a
   `layout.json` key, a `mirror-parts.json` entry or a `style.json` knob.
   Handle `escalate` yourself — decide whether the package change is
   warranted, and if it is, make it as normal code work with a test and a
   changeset. A render-vs-report `escalate` (the critic's Δ beyond ±0.05)
   comes off the palette-quantized model, so confirm it losslessly before
   deciding: call `auto_rig_from_layers` yourself on the same layers (every
   `<workdir>/layers/*.png` but `preview.png`) with the same `style`, no
   `quantizeColors`, and `outputPath: <workdir>/iki-character-lossless.iki`;
   load that file and capture the same three poses as in step 2, decoding them
   into `<workdir>/renders/lossless/`; then measure them as the critic's Step 1
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

The rig's defaults are not constants tuned by eye: they are the Live2D profile
measured on the Cubism sample models (`packages/editor/AUTO-RIG.md`). So a turn
that reads wrong against `reference-30.png` — too weak or too strong, the
features leading the face too much or too little, the hair following it too
much or too little — is first a `style` retune, free and per character. A rig
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
