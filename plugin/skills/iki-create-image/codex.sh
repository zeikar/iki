# codex.sh — sourced by gen-images.sh, gen-turn-reference.sh,
# gen-full-reference.sh and gen-wave-reference.sh: the model every image job
# runs on, the preflight, and the one `codex exec` call they share.

# The image model, kept here rather than left to Codex's own default: that is
# whatever ~/.codex/config.toml names, usually a large reasoning model, which
# bills far more per image for a job that only has to call the image tool.
# Change the default on this line; override one run, or a whole setup, with
# CODEX_IMAGE_MODEL=<slug>. Models are account-gated: a slug your plan does not
# carry comes back as a 400, not a fallback.
CODEX_IMAGE_MODEL="${CODEX_IMAGE_MODEL:-gpt-6-luna}"
# Seconds one job may take before it is stopped (an image takes about one
# minute).
CODEX_IMAGE_TIMEOUT="${CODEX_IMAGE_TIMEOUT:-600}"

die() { echo "[error] $*" >&2; exit 1; }

# Each failure here means Codex cannot draw on this machine at all, as opposed
# to a job that failed — SKILL.md routes these to the hand-off without Codex.
codex_preflight() {
  command -v codex >/dev/null 2>&1 || die "codex CLI not found in PATH"
  codex login status >/dev/null 2>&1 || die "codex not logged in — run: codex login"
  # Not grep -q: it exits on the first match, codex dies of SIGPIPE, and
  # pipefail (set by the callers) fails the whole check.
  codex features list 2>/dev/null | grep -E '^image_generation[[:space:]].*[[:space:]]true$' >/dev/null \
    || die "codex image_generation feature is off — run: codex features enable image_generation"
}

# codex_image_exec <work_dir> <log_base> <ref or ""> <output> <prompt>
#
# project_doc_max_bytes=0: the workdir lives inside a project, and codex walks
# up from --cd injecting that project's AGENTS.md + README.md into every job —
# ~19k tokens of repo rules to draw one eyeball, x10 jobs.
# model_reasoning_effort=low: the model's job is to call the image tool, not to
# reason, and a raised effort in ~/.codex/config.toml would otherwise carry over.
# The leading lines keep the job to one call of the built-in tool. Handed an
# attached image, the model read the request as an edit and took an `imagegen`
# skill's API script instead, which needs OPENAI_API_KEY, the openai package and
# a network the sandbox does not give it. And it is not asked to save anything:
# gpt-6-luna either answered with the path without copying the image, or wrote
# it back out as base64 chunks through python — the image is collected below.
# </dev/null: with stdin open and not a terminal, codex waits on "Reading
# additional input from stdin..." and never draws. A time limit, where the
# machine has `timeout`: a stuck session would otherwise hold its batch slot
# for good (--foreground keeps codex in the caller's process group, so
# stopping the caller stops it too; the long option, since GNU timeout took
# the short -f only in coreutils 9.6; -k kills a codex that ignores the stop).
# A job stopped by the limit may have drawn before it hung, so what its
# session holds is still collected.
codex_image_exec() {
  local work_dir=$1 log_base=$2 ref=$3 output=$4 prompt=$5
  local ref_args=() limit=()
  [ -n "$ref" ] && ref_args=(-i "$ref")
  command -v timeout >/dev/null 2>&1 &&
    limit=(timeout --foreground -k 30 "$CODEX_IMAGE_TIMEOUT")
  mkdir -p "$(dirname "$log_base")" || return
  ${limit[@]+"${limit[@]}"} codex exec \
    --sandbox workspace-write \
    --skip-git-repo-check \
    -c project_doc_max_bytes=0 \
    -c model_reasoning_effort=low \
    -m "$CODEX_IMAGE_MODEL" \
    --cd "$work_dir" \
    ${ref_args[@]+"${ref_args[@]}"} \
    -o "$log_base.md" \
    "Call your built-in image generation tool directly, once — not a script, an API or a skill.
Do not save, copy or write any file: the image is picked up from where the tool
stores it. When it is drawn, reply with one word: done.

$prompt" \
    </dev/null >"$log_base.stdout" 2>&1
  local rc=$?
  [ $rc -eq 0 ] || [ $rc -eq 124 ] || return $rc
  codex_collect_image "$log_base.stdout" "$work_dir/$output" && return 0
  [ $rc -eq 124 ] && return 124
  return 1
}

# Copies the job's image from ~/.codex/generated_images/<session>/ (the first,
# should the model have drawn more than one: a second call made to "hand the
# picture over" draws a different one, from a throwaway prompt) to <dest>,
# overwriting it. Fails when the session drew nothing, so an older file at
# <dest> never passes for this job's output.
codex_collect_image() {
  local log=$1 dest=$2 session src
  session=$(sed -n 's/^session id: //p' "$log" | head -1)
  [ -n "$session" ] && src=$(ls -tr "${CODEX_HOME:-$HOME/.codex}/generated_images/$session"/*.png 2>/dev/null | head -1)
  if [ -z "${src:-}" ]; then
    echo "[gen] no image in session ${session:-?}" >>"$log"
    return 1
  fi
  # Through a temp file beside <dest> and a rename, so a copy that fails partway
  # leaves an older file at <dest> whole.
  local tmp="$dest.tmp.$$"
  if ! { cp "$src" "$tmp" && mv -f "$tmp" "$dest"; } 2>>"$log"; then
    rm -f "$tmp"
    echo "[gen] copy failed: $src -> $dest (the image IS drawn: copy it, do not redraw)" >>"$log"
    return 1
  fi
  echo "[gen] collected $src -> $dest" >>"$log"
}
