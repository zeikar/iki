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
9 parts × 2 variants = 18 jobs. **Check the quota before starting** — a run that
dies halfway leaves a half-updated parts dir:

```bash
codex login status
```

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
mkdir -p iki-char/parts iki-char/layers
[ -f iki-char/layout.json ] || echo '{}' > iki-char/layout.json
```

The `layout.json` line only seeds the file when it is missing, so re-entering
or restarting the loop keeps the tuning you already paid for — the workdir is
gitignored, so an overwrite here has no repository copy to recover it from.

If `<workdir>/reference.png` and `reference-34.png` already exist (a restart),
reuse them and skip straight to Step 1 — do not regenerate. Otherwise, generate
2–3 reference candidates with the **codex-image** skill and let the user pick,
or accept a reference the user supplies. It must be a single front-facing character
in the target style. Then generate one image of the SAME character at roughly
3/4 view — a head turn judged against a front-facing drawing has no target. Keep
them at `<workdir>/reference.png` and `<workdir>/reference-34.png`; both are
frozen, because everything is judged against them and changing either mid-loop
or on a restart invalidates every prior score.

### Step 1 — round

1. Dispatch **iki-character-artist** with `reference` (the front view only —
   `gen-parts.sh` attaches it to every job), `workdir`, `round`, and the
   critic's findings (none on round 1). It returns a rigged `.iki`.
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
   — the stops sit 15° apart, so that is `ParamAngleX` at 7.5 and at 22.5,
   `ParamAngleY` at the same two, and (its stops being 0 and 1) `ParamEyeLOpen`
   at 0.5. Rig breakage surfaces in the turn and blink poses, which a
   front-facing screenshot hides; the between-stop poses expose interpolation
   defects that the endpoint shots miss (the engine blends linearly between
   authored keyforms), so both sets need looking at.
   **The rest shot must be untouched**: standalone, that means Idle was
   already off before the model loaded and no slider has been touched since;
   in a checkout, `reset()` and screenshot, nothing set afterwards. Every
   proportion the critic measures is measured against it, so a flattering
   hero pose saved as `rest.png` silently invalidates the whole round — that
   has already happened once, and two rounds of "it looks like the reference"
   were judged against a head turned nine degrees.
   Rendering stays with you because the Playwright browser is a single shared
   resource; two agents driving it collide.
3. Dispatch **iki-character-critic** with `reference`, `reference-34`, `layers`,
   `renders` (the render paths), `round` and `scores` (the previous rounds'
   `SCORES:` lines). It returns scores and typed findings.
4. Route: `regenerate` and `retune` go back to the artist. Handle `escalate`
   yourself — decide whether the package change is warranted, and if it is,
   make it as normal code work with a test and a changeset. Never let the loop
   edit `packages/`.

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

The rig constants were tuned when nothing on screen held still. Anything that
now looks wrong _relative to the body_ is likely a rig constant, not art — the
head-turn sideways travel already needed this treatment once. Treat a repeated
`rig` escalation as a signal to fix the package, not to keep re-rolling art.

## Do not

- Let either agent edit `packages/`.
- Change either reference mid-loop.
- Use a licensed sample model's art as a reference — see the iki-character
  pitfalls.
- Regenerate the whole part set because one part is wrong.
- Run the loop when `codex login status` reports the quota exhausted — it will
  fail every generation job in seconds and burn rounds doing nothing.
