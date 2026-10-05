#!/usr/bin/env bash
# gen-images.sh — draw Iki character images with Codex, optionally against a
# REFERENCE IMAGE.
#
# Without --ref it draws from the prompt alone: that is how the front reference
# itself is drawn. With --ref, `codex exec -i <ref>` puts the reference in front
# of every job, so every part is drawn while the model is looking at one
# character. That shared anchor is the point: parts generated independently
# drift in hue, line weight and rendering style (one run came back with a
# photoreal iris on a flat cel-shaded face), and no amount of prompt wording
# fixes drift that has no common target.
#
# Usage:
#   gen-images.sh --check
#   gen-images.sh [--ref <reference.png>] <work_dir> "<prompt>::<out.png>" [more...]
#
# --check runs only the preflight (codex installed, logged in, image tool on)
# and prints the model the jobs would run on.
#
# Outputs land in <work_dir>/; per-job transcripts in <work_dir>/.gen-logs/.
#
# NOTE: `-i` puts the reference in front of the model, which then writes the
# image_generation prompt. Whether that carries pixel-level style through to the
# generated part is UNVERIFIED (codex quota ran out before it could be tested).
# If parts come back ignoring the reference, fall back to the text style-bible
# in ../iki-character/SKILL.md and treat `-i` as a bonus rather than the
# mechanism.

set -u -o pipefail

readonly MAX_PARALLEL=5

. "$(dirname "$0")/codex.sh"

usage="usage: gen-images.sh --check | [--ref <reference.png>] <work_dir> \"<prompt>::<out.png>\" [more...]"

if [ "${1:-}" = "--check" ]; then
  [ $# -eq 1 ] || die "$usage"
  codex_preflight
  echo "[ok] codex ready — model: $CODEX_IMAGE_MODEL"
  exit 0
fi

ref=""
if [ "${1:-}" = "--ref" ]; then
  [ $# -ge 2 ] || die "$usage"
  ref=$2; shift 2
  [ -f "$ref" ] || die "reference image not found: $ref"
  ref=$(cd "$(dirname "$ref")" && pwd)/$(basename "$ref")
fi

[ $# -ge 2 ] || die "$usage"

work_dir=$1; shift
[ -d "$work_dir" ] || die "work_dir not found: $work_dir"
work_dir=$(cd "$work_dir" && pwd)

log_dir="$work_dir/.gen-logs"
mkdir -p "$log_dir"

codex_preflight

prompts=() outputs=()
for item in "$@"; do
  case "$item" in *"::"*) ;; *) die "item missing '::' separator: $item" ;; esac
  prompt=${item%%::*}
  output=${item#*::}
  [ -n "$prompt" ] && [ -n "$output" ] || die "empty prompt or output: $item"
  for seen in ${outputs[@]+"${outputs[@]}"}; do
    [ "$seen" = "$output" ] && die "duplicate output filename: $output"
  done
  prompts+=("$prompt")
  outputs+=("$output")
done

total=${#prompts[@]}
echo "[info] reference:   ${ref:-none}"
echo "[info] work_dir:    $work_dir"
echo "[info] model:       $CODEX_IMAGE_MODEL"
echo "[info] total jobs:  $total"
echo

run_one() {
  local idx=$1 prompt=$2 output=$3
  local tag; tag=$(printf '%03d' "$idx")
  local text

  if [ -n "$ref" ]; then
    text="The attached image is the REFERENCE CHARACTER. Study its hair colour and strand
shapes, eye shape and iris colour, line weight, shading style and palette.

Use the image generation tool to draw: '$prompt'

It must read as the SAME character and the SAME drawing style as the reference —
match the colours and line weight exactly."
  else
    text="Use the image generation tool to draw: '$prompt'"
  fi

  codex_image_exec "$work_dir" "$log_dir/$tag" "$ref" "$output" "$text"
  local rc=$?

  if [ $rc -eq 0 ] && [ -s "$work_dir/$output" ]; then
    echo "  [ok]   #$idx  $output  ($(wc -c <"$work_dir/$output" | tr -d ' ') bytes)"
    return 0
  fi
  echo "  [fail] #$idx  $output  (rc=$rc) — see $log_dir/$tag.stdout"
  return 1
}

overall_start=$(date +%s)
batch_no=1
total_failed=0
i=0
while [ $i -lt $total ]; do
  end=$(( i + MAX_PARALLEL ))
  [ $end -gt $total ] && end=$total

  echo "=== batch $batch_no — jobs $(( i + 1 ))..$end ==="
  pids=()
  for (( j = i; j < end; j++ )); do
    run_one "$(( j + 1 ))" "${prompts[$j]}" "${outputs[$j]}" &
    pids+=($!)
  done

  failed=0
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=$(( failed + 1 ))
  done
  echo "    failed $failed"
  echo
  total_failed=$(( total_failed + failed ))

  i=$end
  batch_no=$(( batch_no + 1 ))
done

echo "[done] total $(( $(date +%s) - overall_start ))s"
echo "[done] outputs: $work_dir"

# Non-zero on any failed job: a caller must not read a batch that is missing
# its reference, or a part, as a finished one.
[ $total_failed -eq 0 ] || die "$total_failed of $total jobs failed — see the [fail] lines above"
