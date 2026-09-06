---
name: iki-character-loop
description: Drive a generator/critic loop that refines a rigged Iki character (`.iki`) until it matches a reference illustration. Generates a reference with codex-image, then alternates the iki-character-artist agent (draws, composes, tunes, rigs) with the iki-character-critic agent (scores a rubric, emits typed findings) until the critic says ship or a cap is hit. Use when a generated character is renderable but not good-looking enough, or when the user asks to iterate a character toward a target look.
---

# Iki Character Loop (generator ↔ critic)

`iki-character` produces a _renderable_ character in one pass. This skill makes
one that is _good_, by giving the process the two things a single pass lacks: a
fixed target to aim at, and someone to say how far off it is.

```
reference (codex-image, once)
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
| Iris reads as a bead in white | `compose.cjs` iris constant      | no                     |
| Head slides off the shoulders | auto-rig `translateX` binding    | no                     |
| Brows invisible               | draw order vs. hairstyle         | no                     |
| Lash misaligned from sclera   | a careless `LAYOUT` edit         | no                     |
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

### Step 0 — reference

Generate 2–3 candidates with the **codex-image** skill and let the user pick, or
accept a reference the user supplies. It must be a single front-facing character
in the target style. Keep it at `<workdir>/reference.png` — everything is judged
against it, so changing it mid-loop invalidates every prior score.

### Step 1 — round

1. Dispatch **iki-character-artist** with `reference`, `workdir`, `round`, and
   the critic's findings (none on round 1). It returns a rigged `.iki`.
2. **Render it yourself.** Copy the model to
   `examples/playground/public/<name>.iki`, load it via the **iki-visual-test**
   skill, and screenshot at least: rest, head-turn (`ParamAngleX` near its
   limit), blink (`ParamEyeLOpen` ≈ 0), gaze (`ParamEyeBallX` near its limit).
   The turn and blink poses are where rig defects surface — a front-facing
   screenshot hides most of them.
   **The rest shot must be untouched**: `reset()` and screenshot, nothing set
   afterwards. Every proportion the critic measures is measured against it, so a
   flattering hero pose saved as `rest.png` silently invalidates the whole round
   — that has already happened once, and two rounds of "it looks like the
   reference" were judged against a head turned nine degrees.
   Rendering stays with you because the Playwright browser is a single shared
   resource; two agents driving it collide.
3. Dispatch **iki-character-critic** with `reference`, `layers`, the render
   paths and `round`. It returns scores and typed findings.
4. Route: `regenerate` and `retune` go back to the artist. Handle `escalate`
   yourself — decide whether the package change is warranted, and if it is,
   make it as normal code work with a test and a changeset. Never let the loop
   edit `packages/`.

### Step 2 — stop

Stop on the first of:

- critic returns `ship`
- critic returns `stop`
- **3 rounds that spent generation** (the billed cap)
- two consecutive rounds with no total-score improvement

Then report to the user: the final render, the score trajectory across rounds,
what remains unfixed, and every escalation with your recommendation.

## Escalations you should expect

The rig constants were tuned when nothing on screen held still. Anything that
now looks wrong _relative to the body_ is likely a rig constant, not art — the
head-turn sideways travel already needed this treatment once. Treat a repeated
`rig` escalation as a signal to fix the package, not to keep re-rolling art.

## Do not

- Let either agent edit `packages/`.
- Change the reference mid-loop.
- Regenerate the whole part set because one part is wrong.
- Run the loop when `codex login status` reports the quota exhausted — it will
  fail every generation job in seconds and burn rounds doing nothing.
