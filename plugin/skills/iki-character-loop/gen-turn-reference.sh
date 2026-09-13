#!/usr/bin/env bash
# gen-turn-reference.sh — generate the 30-degree head-turn reference image.
#
# Same shape as ../iki-character/gen-parts.sh: one `codex exec -i <front>` job
# that draws the SAME character turned, using the already-generated front
# reference as the attachment.
#
# Three whys baked into this script:
#   -i <reference>       the attachment is what reproduces the character; a
#                         text-only prompt has nothing to redraw and drifts.
#   30 degrees, not 45   the angle is the rig's own ParamAngleX limit, so it is
#                         not a tunable parameter here — a 45-degree drawing
#                         over-asks a 30-degree rig by ~1.7x (measured, not
#                         derived: the feature slide a 45° drawing demands
#                         versus a 30° one).
#   no character detail  the prompt names no hairstyle, eye colour or outfit;
#                         the attached front reference already carries
#                         identity, so the prompt only has to describe the turn.
#
# Usage:
#   gen-turn-reference.sh <reference.png> <work_dir>
#
# Output: <work_dir>/reference-30.png. Per-job transcript in
# <work_dir>/.gen-logs/.

set -u -o pipefail

# Account-gated: a model slug your plan does not carry returns a 400, not a
# fallback. Override when this default is not available to you.
CODEX_IMAGE_MODEL="${CODEX_IMAGE_MODEL:-gpt-5.6-luna}"

die() { echo "[error] $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: gen-turn-reference.sh <reference.png> <work_dir>"

ref=$1
work_dir=$2
[ -f "$ref" ] || die "reference image not found: $ref"
ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")

[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

command -v codex >/dev/null 2>&1 || die "codex CLI not found in PATH"
codex login status >/dev/null 2>&1 || die "codex not logged in — run: codex login"

out="reference-30.png"

echo "[info] reference: $ref"
echo "[info] work_dir:  $work_dir"
echo "[info] output:    $out"
echo

# project_doc_max_bytes=0 / model_reasoning_effort=low: see gen-parts.sh — the
# same repo-doc-injection and reasoning-effort rationale applies to this single
# image job too.
codex exec \
  --sandbox workspace-write \
  --skip-git-repo-check \
  -c project_doc_max_bytes=0 \
  -c model_reasoning_effort=low \
  -m "$CODEX_IMAGE_MODEL" \
  --cd "$work_dir" \
  -i "$ref" \
  -o "$log_dir/reference-30.md" \
  "The attached image is the REFERENCE CHARACTER: a front-facing bust portrait.
Use the image generation tool to redraw the EXACT same character, same drawing
style, same line weight, same colours, same framing and crop, same square
canvas, same flat lavender-grey background, with ONE change: the head turned
about 30 degrees toward the viewer's left (the character's own right). This is
a modest turn, NOT a three-quarter view and NOT a profile: both eyes still
fully visible, the far (viewer's left) eye only slightly narrower than the
near eye, the nose tip shifted a little toward the near cheek, the far cheek
outline receding a touch, the near ear just starting to peek out under the
hair. The shoulders and torso stay facing the camera exactly as in the
reference; only the head and neck rotate. Same eye level and head size as the
reference so the two images can be overlaid. Keep every other attribute
exactly as in the attached image: hairstyle and hair colour, eye colour,
expression, clothing and accessories. Save it to ./$out. Reply with only the
file path on one line." \
  >"$log_dir/reference-30.stdout" 2>&1
rc=$?

if [ $rc -eq 0 ] && [ -s "$work_dir/$out" ]; then
  echo "[ok]   $out  ($(wc -c <"$work_dir/$out" | tr -d ' ') bytes)"
  exit 0
fi
echo "[fail] $out  (rc=$rc) — see $log_dir/reference-30.stdout" >&2
exit 1
