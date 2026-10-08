---
name: iki-create-image
description: Draw the images an Iki character is built from — the front reference, the role-separated part PNGs drawn against it, the 30° turned reference, and for a full-body character the full-body reference drawn from the front one and the waving reference drawn from that — with the Codex CLI's image tool on a model the plugin pins, or hand the user the prompts to run in another image tool when Codex is not set up. Used by the iki-character and iki-character-loop skills; not for general image requests.
user-invocable: false
---

# Iki Create Image

The image leg of the Iki character pipeline. The **iki-character** skill owns
_what_ to draw — the part prompts, their filenames and their pitfalls. This
skill owns _how_ it gets drawn: the scripts, the model they run on, and what to
do when Codex is not there.

## The scripts

They sit beside this file, in `${CLAUDE_SKILL_DIR}`:

| Command                                                            | Draws                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-images.sh --check`                                            | nothing — runs the preflight alone and prints the model the jobs would use                                                                                                                           |
| `gen-images.sh [--ref <png>] <work_dir> "<prompt>::<out.png>" ...` | a batch, up to five jobs at once. Without `--ref`, from the prompt alone: the front reference. With it, every job sees it: the parts                                                                 |
| `gen-turn-reference.sh <reference.png> <work_dir>`                 | `<work_dir>/reference-30.png`: the same character with the head turned 30° (the **iki-character-loop**'s style check)                                                                                |
| `gen-full-reference.sh <reference.png> <work_dir> [outfit]`        | `<work_dir>/reference-full.png`: the same character drawn full body, head to toe, from the bust — only for a full-body character; `[outfit]` names the bottoms, socks and shoes the bust cannot show |
| `gen-wave-reference.sh <reference-full.png> <work_dir>`            | `<work_dir>/reference-wave.png`: the full-body reference with the right hand raised in a wave — only for a full body that gets a pose forearm; what `forearm_pose.png` is drawn against              |

All four shell out to `codex exec` with Codex's built-in `image_generation`
tool, write into `<work_dir>` (which must already exist) and keep each job's
transcript in `<work_dir>/.gen-logs/`. **Billed, minutes per image** — confirm
the user is OK spending before the first job. Run them as background Bash jobs
and let the completion notice say when a batch is done; do not sleep-poll.

## Before the first job

Run `${CLAUDE_SKILL_DIR}/gen-images.sh --check`. It stops on the three things
that mean Codex cannot draw on this machine at all:

- `codex CLI not found in PATH`
- `codex not logged in — run: codex login`
- `codex image_generation feature is off — run: codex features enable image_generation`

On any of them, do not retry. Tell the user and offer the two ways on: set
Codex up (install the Codex CLI, `codex login` with a ChatGPT plan, the command
the message names) and run again, or the hand-off below. A generation script
stops with the same three messages before its first job; treat them the same
way there.

## The model

Jobs run on **`gpt-6-luna` at `model_reasoning_effort=low`**. The model only has
to call the image tool, so a bigger one buys nothing but cost — and left to
itself, Codex runs whatever `~/.codex/config.toml` names, usually a large
reasoning model. To use another one:

- one run: `CODEX_IMAGE_MODEL=<slug> gen-images.sh …`
- every run on a machine: export `CODEX_IMAGE_MODEL` from the shell profile, or
  set it under `"env"` in Claude Code's `settings.json`
- the plugin's own default: the one `CODEX_IMAGE_MODEL=` line in `codex.sh`

Models are account-gated: a slug the plan does not carry fails the job with a
`400` in its log, with no fallback to another model. That is when to override.

## The front reference

Every part is drawn against one reference, so the set reads as one character:
parts drawn from a style string alone drift (a photoreal iris on a flat
cel-shaded face). Draw it **without** `--ref`, into the workdir. The skeleton
below is the framing the part prompts and the rig assume, as the hero bob and
the long-haired character were drawn:

> Front-facing bust portrait of an ORIGINAL anime `<character>` (not any
> existing character), `<STYLE>`, soft muted grey-blue plain background, square
> image. Head perfectly front-facing and level, looking straight at the viewer,
> shoulders squared. Hair: `<hairstyle and colour>`, bangs ending ABOVE the
> eyebrows so both eyes and brows are fully clear. `<eye colour>` eyes, gentle
> closed-mouth smile, small delicate anime nose. Visible neck. Simple outfit:
> `<outfit>`. Single character, upper chest up, no text, no watermark.

Draw it again if the head came out turned or tilted, the bangs cover an eye or
a brow, or the neck is hidden: every part inherits it. A reference the user
supplies replaces the draw. Never use a licensed model's art as one (the
**iki-character** pitfalls).

## The full-body reference

Only for a full-body character (the **iki-character** skill's `full-body.md`),
and drawn FROM the front reference once that one is final:
`gen-full-reference.sh <workdir>/reference.png <workdir>` writes
`<workdir>/reference-full.png`, the same character head to toe on a 1:3
portrait, arms hanging in a slight A-pose. A full body alone would not do:
drawn whole, the face is a fraction of the image, too small to draw the face
parts or score the face against. So the front reference stays the master,
and this one is drawn from it with it attached.

The optional third argument is one sentence naming what the bust cannot show:
the bottoms, socks and shoes. The bust has no lower body, and unnamed the
model invents it (a tee-only bust came back with a yellow skirt and loafers).
`full-body.md` Step 0 writes the sentence to `<workdir>/outfit.txt`; pass it
as `"$(cat <workdir>/outfit.txt)"`. The prompt also keeps the hair as drawn:
tied hair (a ponytail, a bun, a braid) keeps its length and place, and only
loose hair the bust's frame cuts off continues down.

Draw it again if the head, the outfit or the colours drifted from the front
reference, an arm touches the torso, the legs have no gap between them, or a
foot or the crown is cut by the image's edge: the body and the arm parts
inherit it.

It drives the body and arm parts, where the body is placed on the tall canvas,
and the critic's body score. The front reference stays the face's: the face
and hair parts, the face layout, the turned reference and the face score.

## The waving reference

Only for a full body that gets a pose forearm (`forearm_pose.png`, the
**iki-character** skill's `full-body.md`), and drawn FROM `reference-full.png`
once that one is final: `gen-wave-reference.sh <workdir>/reference-full.png
<workdir>` writes `<workdir>/reference-wave.png`, the same figure with its right
hand (on the viewer's left) raised in a wave. It is one more billed image, and
the pose forearm is drawn against it because it shows the raised forearm
itself — the sleeve's cuff, the skin, the line and the hand's pose at the
figure's proportions — where `arm.png`'s reference shows a hanging arm the
model tends to redraw hanging, and `reference-full.png` shows no raised
forearm at all. It is also the critic's target for the pose forearm.

Draw it again if the raised hand's thumb faces out (away from the body), the
upper arm left the torso, or the outfit drifted from `reference-full.png`.
When it does not come back usable, `reference-full.png` stands in as the
pose forearm's reference.

## Failed jobs and quota

**You cannot check quota up front.** `codex login status` reports
authentication only — identical output before and after the limit is hit — and
`--check` cannot see it either. A refused job exits non-zero with `You've hit
your usage limit` and a reset time in its log, so on a big set fire one job and
read it before firing the rest. Out of quota, report the reset time; the
hand-off below is the other way on.

The model is told not to save anything: the scripts take each image from where
the image tool stores it, `~/.codex/generated_images/<session>/`, and copy it to
its path (the job's log notes `[gen] collected …`). Asked to save it itself,
`gpt-6-luna` answered with the path without copying, or wrote the image back
out as base64 chunks. A job marked `[fail]` leaves an older file at its path as
it was; read its log. When the log ends in `[gen] copy failed`, the image was
drawn and only the copy failed: copy it from the path that line names rather
than paying to draw it again. Otherwise the job drew nothing — retry that job
alone. The script exits non-zero when any job failed.

## Without Codex: the hand-off

Anything that returns transparent, role-separated PNGs works; the prompts are
the substance, the driver is not. When Codex cannot draw here, or the user would
rather use another tool, write `<workdir>/prompts.md` and stop:

- a header: draw the reference first (for a full body, then the full-body
  reference with it attached), then every part **with its reference
  attached** in a tool that takes one, asking for the same character in the
  same drawing style — in ChatGPT, the same conversation; ask for a transparent
  background (a part on plain white still composes, since the composer keys
  near-white to alpha, but a white highlight can be keyed out with it);
- one entry per image: the exact path to save it at (the composer reads parts
  by filename), which reference to attach — none for the front reference,
  `reference.png` for the turned and full-body references and the face and hair
  parts, `reference-full.png` for a full body's `body.png` and `arm.png`, and
  `reference-wave.png` for its `forearm_pose.png` — and
  the prompt verbatim with `<STYLE>` filled in: for the turned reference, the
  prompt inside `gen-turn-reference.sh`; for the full-body reference, the one
  inside `gen-full-reference.sh`, with the outfit sentence in place of its
  default outfit line; for the waving reference, the one inside
  `gen-wave-reference.sh` (attach `reference-full.png`).

Tell the user where the file is and wait. When they say the images are in
place, check every path is there and a PNG (`file <path>`), then continue from
the step that needed them.
