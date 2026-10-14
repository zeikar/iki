---
name: iki-character-loop
description: Drive a generator/critic loop that refines a rigged Iki character (`.iki`) until it matches a reference illustration. Draws a reference with the iki-create-image skill, then alternates the iki-character-artist agent (draws, composes, tunes, rigs) with the iki-character-critic agent (scores a rubric, emits typed findings) until the critic says ship and the user has nothing to add, or a cap is hit. The iki-character-appeal-critic judges the renders for appeal without the reference each round. Use when a generated character is renderable but not good-looking enough, or when the user asks to iterate a character toward a target look.
---

# Iki Character Loop (generator ↔ critic)

`iki-character` produces a _renderable_ character in one pass. This skill makes
one that is _good_, by giving the process the two things a single pass lacks: a
fixed target to aim at, and someone to say how far off it is.

```
references (iki-create-image, once)
      │
      ▼
  ┌─► artist ──► rigged .iki ──► orchestrator renders ──┬─► critic ────────┐
  │                                                     └─► appeal critic ─┤
  │                                                                        │
  └───────────────────── typed findings ◄──────────────────────────────────┘
```

**You are the orchestrator.** You spawn the three agents, carry artifacts between
them, render each round, arbitrate escalations, and enforce the caps.
No agent talks to another directly.

## Host dispatch

- **Claude Code:** dispatch the bundled agents as `iki:iki-character-artist`
  and `iki:iki-character-critic`, and `iki:iki-character-appeal-critic` fresh
  each round with only its inputs in the prompt.
- **Codex:** the Markdown files in `agents/` are role instructions, not
  registered agent types. Resolve the plugin root two directories above this
  skill's directory. Spawn a standard subagent for each role and tell it to
  read the body of [the artist](../../agents/iki-character-artist.md) or
  [the critic](../../agents/iki-character-critic.md) or
  [the appeal critic](../../agents/iki-character-appeal-critic.md), passing the
  absolute plugin root and the round's inputs. Their YAML `tools`, `model` and
  `color` fields are Claude metadata; use Codex's available tools and inherited
  model. Resume the same artist or critic subagent for later work. Spawn the
  appeal critic without the parent's history (`fork_turns: "none"`) and never
  resume it: a forked subagent inherits this conversation, references and the critic's judgments
  included, which would end its blindness. If subagents are unavailable,
  perform the artist and critic steps sequentially with the same ownership
  rules, rubric and caps, and the appeal checklist after the critic's step; it
  is not reference-blind (you have seen the reference), so say so in item
  4's message to the user rather than claim it.

MCP tool prefixes vary by host: resolve the bundled `iki` server's tools by
their tool names. The render step needs no browser automation in either host.

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
11 parts × 2 variants = 22 jobs; the mouth's two parts are `mouth_keyed.png` and
`mouth_interior.png` (a style that cannot fold draws `mouth.png` and
`mouth_open.png` instead). A full body adds `reference-full.png` (one
job), `arm.png` (two), and, with a pose forearm, `reference-wave.png` (one) and
`forearm_pose.png` (two).

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
`outfit.txt` and `figure.json`, as the other two. A full body with a pose
forearm also draws `<workdir>/reference-wave.png` from `reference-full.png`
with the **iki-create-image** skill's `gen-wave-reference.sh` (the
**iki-character** skill's `full-body.md` Step 0 says how), reused on a restart
and frozen like the other references. The `canvas.json` written there is
provisional until round 1's measuring compose corrects it (`full-body.md`
Step 2); from round 2 on the artist edits its `canvasHeight` only on a critic
`retune`, as it does `style.json`.

Then go to Step 1. `reference.png` and `reference-30.png` (and, for a full
body, `reference-full.png` and `reference-wave.png`) are frozen, because every round reads them and
changing any of them mid-loop or on a restart invalidates every prior score.

### Step 1 — round

1. Dispatch **the artist** (see Host dispatch) with `reference` (the front view
   only — `gen-images.sh --ref` attaches it to every job), `workdir`, `round`,
   `style` (the contents of `<workdir>/style.json`, which its rig step passes
   to `auto_rig_from_layers` when it is not empty), and both critics' findings
   (none on round 1). A full body
   also passes `reference-full` (`<workdir>/reference-full.png`, which its
   `body.png` and `arm.png` jobs attach instead), `reference-wave`
   (`<workdir>/reference-wave.png`, which its `forearm_pose.png` jobs attach), and `canvas` (the contents of
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

2. **Render it** with the `iki` server's `render_poses` tool:
   `render_poses { modelPath: <workdir>/iki-character.iki, outDir: <workdir>/renders }`
   (`outDir` must already exist and sit under the server's cwd; Step 0 makes
   it). It needs `@ikijs/mcp` 0.24.0+, Node 22+ and an installed Chrome, Edge
   or Chromium (`CHROME_PATH` for a non-standard install); `stress` and the
   fold report need 0.25.0+. A server without `render_poses` predates 0.24.0,
   and a result with no `stress.png` and no line starting `FOLD` predates
   0.25.0: update the plugin, whose `.mcp.json` pin moves when it adopts a
   release. A server before 0.25.0 still renders every other pose, so the
   round goes on, with `folds` passed as `unavailable`. On an `INVALID:`
   refusal (no browser, a bad `CHROME_PATH`, Node < 22) give the user its
   message and render again once it is fixed: the round waits, it is not over.
   The model decides the set: a full body when the canvas is taller than wide,
   the mouth crops centred on the rigged mouth part, the `full-pose-*` poses
   when `ParamArmPoseR` is declared. Called with `poses` (each
   `{ name, values, crop? }`, the `crop` in model px from the top-left — the
   frame of `describe_iki`'s boxes and the `FOLD` lines — and clamped to the
   canvas) it renders those alone and adds them to the fold sweep; that needs
   0.26.0+, and an older server strips the field silently and renders the
   standard set, so after every call with `poses` compare the returned pose
   names with the ones passed: a mismatch means an old server, and the patch
   gate is unavailable. The result lists the written paths, then
   ends with the model's fold report: a `FOLD` line per warp grid or mesh part
   that flips or collapses at some pose, or `FOLDS: none over N poses`, and a
   `FOLDS expected:` line for the closures the rig draws on purpose (an eye or
   the mouth shut). A fold never stops the round: it is the critic's input
   (Step 3). A non-empty `failedTextures` means atlas pages did not load and
   their parts are missing: render once more; if pages still fail, escalate,
   because the critic does not score renders with parts missing.
   The rest shot is untouched by construction, which matters because every
   proportion the critic measures is measured against it.
   The poses: `rest`, `turn-m30`, `turn-p30`, `turn-15`, `nod-15`, `blink`,
   `blink-half`, `gaze`, `combined`, `stress` (every head angle at −30, the
   mouth open, both eyes at 0.5, the brows at opposite extremes and each
   declared body angle at −10); the 15 `mouth-*` crops
   (`mouth-open-{0,0.3,0.6,1}-form-{m1,0,p1}`, `mouth-laugh`,
   `mouth-surprised`, `mouth-turn-p30-half`); on a full body `full-rest`,
   `full-turn-p30`, `full-body-{x,y,z}-{m10,p10}`, `full-arm-{l,r}-{16,32}`,
   `full-elbow-{l,r}-{m10,45,90}`, and with a pose forearm `full-pose-l`,
   `full-pose-r`, `full-pose-r-angle-m15`, `full-pose-r-angle-p15`,
   `full-pose-r-half`.
3. Dispatch **the critic** (see Host dispatch) with `reference`, `reference-30`, `layers`,
   `renders` (the returned paths other than `mouth-*` and `full-*`; each input
   below is a subset of the returned paths, so a stale file from an earlier
   round is never picked up), `turn-pair` (`<workdir>/renders/rest.png`,
   `turn-m30.png` and `turn-p30.png`), `mouth-renders` (the 15 `mouth-*.png`
   crops), `round`, `scores` (the previous rounds' `SCORES:` lines),
   and `turn-clamped` (this round's artist's own `TURN:` line, verbatim — its
   `turn.achieved`, `turn.clamped` and `turn.strandOverlap`, or "none" when no
   turn was solved) so the critic can check the render against the rig's own
   report and tell a clamp this art forced from a new turn defect, and `folds`
   (Step 2's fold report, verbatim and complete: every `FOLD` line or the one
   `FOLDS: none …` line, and the `FOLDS expected:` line when there is one; or
   `unavailable` from a server before 0.25.0). It returns
   scores and typed findings. A full body also passes `reference-full`, `figure` (the
   contents of `<workdir>/figure.json`) and `body-renders` (the whole-canvas `full-*.png` poses) and, with a pose forearm,
   `reference-wave`; its `renders` and
   `turn-pair` are the bust crops.

   In parallel (neither needs the other), dispatch **the appeal critic** with
   `renders` (`<workdir>/renders/rest.png`, `turn-p30.png`,
   `mouth-open-0-form-0.png`, `mouth-open-0.6-form-0.png`; a full body also
   `full-rest.png`), `layout` (the contents of `<workdir>/layout.json`) and
   `round` — and nothing else in its prompt: no reference, no `layers`, no
   `preview.png`, nothing of the critic's report.

   When both reports are back, type any `refer` on the closed mouth by the
   model's mouth route, read off this round's `<workdir>/layers/` file names
   (`mouth_inner.png` / `lip_*.png` is the lip set; `mouth.png` with
   `mouth_open.png` is the legacy pair).
   Legacy pair: the closed mouth is `mouth.png` as drawn, the rig bends
   nothing, so a V or over-lifted corners is the drawing: a `regenerate` of
   `mouth.png` with a gentle closed curve, never a rig escalation. Lip set: the
   artist rigged it on the pinned server, so its closed line is already the
   current rig's closing of the drawn arc (a smooth parabola, sag capped at
   `CLOSED_SAG_MAX`, a drawn kink closed away); a model left by a restart from
   an older rig is re-rigged by the artist first, since its V may be one the
   rig no longer draws. Then route by the critic's own closed-line check of the
   same round: if it names a `regenerate` of `mouth_keyed.png` or an `escalate`
   on `packages/editor/src/auto-rig/mouth.ts`, the `refer` rides on that
   finding (the appeal critic's direction wins on the mouth's expression, item 5's
   rule; item 4 names the combined fix as one job for the user's OK); if it names nothing, read the closed crop against the critic's
   rules. A line inside them (sag within the cap, ends tapered, no tick) that
   still reads V or over-lifted is the drawn arc's depth: a `regenerate` of
   `mouth_keyed.png` drawn shallower at the centre with the upper line flatter.
   A line outside them (a surviving kink, a sag past the cap) is the rig: an
   `escalate` on `mouth.ts`. Never type a lip set
   by whether the closed line matches the drawing; the rig smooths it on
   purpose.

4. Ask the user, every round whatever the verdict, once both critics
   have returned and the `refer` is typed, before the critic's verdict is acted on and before Step 2: list the
   absolute paths of `<workdir>/renders/rest.png`, `turn-p30.png` and
   `mouth-open-0-form-0.png` (a full body also `full-rest.png`) for the user
   to open — sent as files too where the host offers a tool for it — with the
   critic's `SCORES:` and `VERDICT:` lines and the appeal critic's `IMPRESSION:`
   and `APPEAL:` lines, and ask for a one-line reaction ("fine" if none). When the appeal
   critic named a `regenerate`, or its `refer` was typed as one above, the same
   question names the part and the billed job once (a `refer` riding on the
   critic's `regenerate` is one combined job); that finding goes to the
   artist only on the user's OK, and a declined one is dropped (the user's word
   stands for Step 2's stop rule). The appeal critic's `retune`s are free and
   need no OK. A reaction that names a change becomes a finding of the type it
   implies — a `retune` naming the layout key, or a `regenerate` of
   the part — marked as the user's. The user's eye overrides a ratio that
   passes and a `ship` or `stop` verdict: the loop runs another round, within
   Step 2's caps. "fine" adds nothing.
5. Route: `regenerate` and `retune` go back to the artist — a `retune` names a
   `layout.json` key, a `mirror-parts.json` entry or a `style.json` knob, or on
   a full body `canvas.json`'s `canvasHeight`. The appeal critic's `retune`s go
   with them, marked as its own, and so does a `regenerate` item 4 approved; a
   `refer` typed as an `escalate` is handled as the critic's are. The reference
   keeps identity (hair, outfit, palette, the style the features are drawn in),
   so the critic wins there where the two disagree; on proportions,
   placement and expression within that look the appeal critic wins; the
   user's reaction (item 4) overrides both.
   Handle `escalate` yourself — decide whether the package change is
   warranted, and if it is, make it as normal code work with a test and a
   changeset. A render-vs-report `escalate` (the critic's Δ beyond ±0.05)
   comes off the palette-quantized model, so confirm it losslessly before
   deciding: call `auto_rig_from_layers` yourself on the same layers (every
   `<workdir>/layers/*.png` but the previews, `preview.png` and `preview-pose.png`) with the same `style`, no
   `quantizeColors`, and `outputPath: <workdir>/iki-character-lossless.iki`;
   call `render_poses` on that file into `<workdir>/renders/lossless/` (`mkdir -p` first);
   then measure them as the critic's Step 1
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

- critic returns `ship` or `stop`, the appeal critic's line ends in `stop` (or
  the user said in item 4 to leave what it still names), and the user's
  reaction (Step 1, item 4) named nothing to act on
- **3 rounds that spent generation** (the billed cap)
- two consecutive rounds in which **no axis reached a new maximum** — keep a
  high-water mark per axis, because an unweighted total nets a real `rig` 3→4
  against a `palette` 4→3 drift and reads as no progress; each of the nine
  `APPEAL:` scores is its own axis too, never their total

A round run on the user's finding counts like any other: toward the billed cap
when it spends generation, and a new maximum on any axis resets the
no-new-maximum streak.

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
