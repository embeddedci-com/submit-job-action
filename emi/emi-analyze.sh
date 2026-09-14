#!/usr/bin/env bash
#
# Upload a board to the EmbeddedCI EMI Analyzer, wait for the rules tier, and gate the build on
# what it found.
#
# The whole flow is six REST calls. It is written out here rather than hidden behind an SDK
# because there is no EMI SDK to hide it behind, and a CI step that a reader can follow line by
# line is easier to debug from a failed workflow log than a bundled binary.
#
# The API key never reaches the log: it is passed in an env var, sent with `--header @-` on stdin
# so it does not appear in a process listing, and every response that could echo it is filtered.

set -euo pipefail

API_BASE="${EMI_API_BASE:-https://www.embeddedci.com}"
API_BASE="${API_BASE%/}"
BOARD="${EMI_BOARD:?board input is required}"
FAIL_ON="${EMI_FAIL_ON:-critical}"
TIMEOUT="${EMI_TIMEOUT:-300}"

die() { echo "::error::$*" >&2; exit 1; }
note() { echo "$*"; }

command -v jq >/dev/null 2>&1 || die "jq is required and was not found on this runner"
[ -n "${EMI_API_KEY:-}" ] || die "api_key is required. Generate one under Settings → API keys with the emi:analyze scope."
[ -f "$BOARD" ] || die "board file not found: $BOARD"

case "$FAIL_ON" in
  critical|warning|none) ;;
  *) die "fail_on must be one of: critical, warning, none (got '$FAIL_ON')" ;;
esac

PROJECT_NAME="${EMI_PROJECT:-}"
[ -n "$PROJECT_NAME" ] || PROJECT_NAME="${EMI_DEFAULT_PROJECT:-emi}"

SOURCE_KIND="${EMI_SOURCE_KIND:-}"
if [ -z "$SOURCE_KIND" ]; then
  # A .kicad_pcb is unambiguous. A zip could be either, and KiCad is the common case; the
  # server re-derives the truth from the archive contents anyway, so a wrong guess here is not
  # fatal — it only affects how the project is labelled.
  case "$BOARD" in
    *.kicad_pcb) SOURCE_KIND=kicad ;;
    *)           SOURCE_KIND=kicad ;;
  esac
fi

# --- request helpers -------------------------------------------------------------------------
#
# curl reads the Authorization header from stdin so the key is never an argv entry, which would
# be visible to anything that can list processes on the runner.

api() { # api <method> <path> [body-json]
  local method="$1" path="$2" body="${3:-}"
  local args=(--silent --show-error --fail-with-body
              --max-time 60
              --request "$method"
              --header @-
              --header "Accept: application/json")
  if [ -n "$body" ]; then
    args+=(--header "Content-Type: application/json" --data "$body")
  fi
  printf 'Authorization: ApiKey %s' "$EMI_API_KEY" | curl "${args[@]}" "${API_BASE}${path}"
}

# api_status is api() without --fail-with-body, for the poll loop where a non-2xx is worth
# reporting rather than aborting on.
api_status() { # api_status <method> <path>
  printf 'Authorization: ApiKey %s' "$EMI_API_KEY" \
    | curl --silent --show-error --max-time 60 --request "$1" \
           --header @- --header "Accept: application/json" \
           --write-out '\n%{http_code}' "${API_BASE}$2"
}

# --- 1. resolve the project ---------------------------------------------------------------
#
# Reused by name across runs, deliberately: the boards from every commit accumulate in one
# project, which is what lets a later run compare against an earlier one.

note "Resolving EMI project '${PROJECT_NAME}'…"
# The first call is also the reachability check, so its failure is worth telling apart: a
# refused connection and a refused credential need completely different fixes, and blaming the
# API key for a DNS problem sends the reader looking in the wrong place.
# `if ! cmd` would invert the status before $? could be read, so the exit code is captured
# directly instead.
set +e
projects="$(api GET "/api/emi/projects?limit=200")"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  case "$rc" in
    6|7)  die "could not reach ${API_BASE} (curl ${rc}). Check api_base and that the runner has network access." ;;
    28)   die "timed out reaching ${API_BASE}." ;;
    22)   die "${API_BASE} rejected the API key. Check it is valid, not revoked, and carries the emi:analyze scope." ;;
    *)    die "could not list EMI projects (curl ${rc})." ;;
  esac
fi

project_id="$(printf '%s' "$projects" | jq -r --arg n "$PROJECT_NAME" \
  '.projects // [] | map(select(.name == $n)) | first | .id // empty')"

if [ -z "$project_id" ]; then
  note "Creating project '${PROJECT_NAME}'"
  created="$(api POST /api/emi/projects \
    "$(jq -nc --arg n "$PROJECT_NAME" --arg k "$SOURCE_KIND" '{name:$n, source_kind:$k}')")" \
    || die "could not create the EMI project"
  project_id="$(printf '%s' "$created" | jq -r '.id // empty')"
fi
[ -n "$project_id" ] || die "could not resolve a project id"
note "Project: ${project_id}"

# --- 2. ask for an upload URL --------------------------------------------------------------
#
# The digest is sent up front. The server keys uploads by content hash, so re-running CI on a
# commit that did not touch the layout skips the transfer entirely — a board is tens of MB.

sha="$(sha256sum "$BOARD" | cut -d' ' -f1)"
filename="$(basename "$BOARD")"
note "Board ${filename} (sha256 ${sha:0:12}…)"

upload="$(api POST "/api/emi/projects/${project_id}/uploads" \
  "$(jq -nc --arg f "$filename" --arg s "$sha" \
        '{filename:$f, sha256:$s, content_type:"application/octet-stream"}')")" \
  || die "could not create an upload URL"

input_key="$(printf '%s' "$upload" | jq -r '.key')"
already="$(printf '%s' "$upload" | jq -r '.already_uploaded // false')"

# --- 3. send the bytes, unless the server already has them ----------------------------------

if [ "$already" = "true" ]; then
  note "Server already holds these bytes — skipping the upload."
else
  upload_url="$(printf '%s' "$upload" | jq -r '.upload_url')"
  [ -n "$upload_url" ] && [ "$upload_url" != "null" ] || die "no upload URL in the response"
  note "Uploading…"
  # No Authorization header here: the URL is presigned, and adding one breaks the SigV4
  # signature rather than adding to it.
  curl --silent --show-error --fail --max-time 900 \
       --request PUT \
       --header "Content-Type: application/octet-stream" \
       --upload-file "$BOARD" \
       "$upload_url" >/dev/null || die "upload failed"
fi

# --- 4. register the board, which queues the ingest + rules run ------------------------------

note "Registering the board…"
board_resp="$(api POST "/api/emi/projects/${project_id}/boards" \
  "$(jq -nc --arg k "$input_key" --arg s "$sha" '{input_key:$k, sha256:$s}')")" \
  || die "could not register the board"

board_id="$(printf '%s' "$board_resp" | jq -r '.board.id // empty')"
run_id="$(printf '%s' "$board_resp" | jq -r '.run.id // empty')"
[ -n "$run_id" ] || die "no run was queued for the board"
note "Run: ${run_id}"

{
  echo "project_id=${project_id}"
  echo "board_id=${board_id}"
  echo "run_id=${run_id}"
} >> "$GITHUB_OUTPUT"

# --- 5. wait for it ---------------------------------------------------------------------------
#
# The rules tier is seconds. Anything longer usually means no EMI worker is online to pick the
# run up, so the timeout message says so rather than leaving the reader guessing.

note "Waiting for the analysis…"
deadline=$(( SECONDS + TIMEOUT ))
status=""
last_status=""
while [ $SECONDS -lt $deadline ]; do
  resp="$(api_status GET "/api/emi/runs/${run_id}")"
  code="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"

  if [ "$code" != "200" ]; then
    note "  (status check returned HTTP ${code}; retrying)"
    sleep 3
    continue
  fi

  status="$(printf '%s' "$body" | jq -r '.status // empty')"
  if [ "$status" != "$last_status" ]; then
    note "  ${status}"
    last_status="$status"
  fi

  case "$status" in
    done) break ;;
    failed|timed_out)
      err="$(printf '%s' "$body" | jq -r '.error // "no reason given"')"
      die "EMI run ${status}: ${err}" ;;
  esac
  sleep 3
done

if [ "$status" != "done" ]; then
  die "timed out after ${TIMEOUT}s waiting for the run (last status: ${status:-unknown}). If it never left 'new', no EMI worker was online to take it."
fi

# --- 6. read the findings ---------------------------------------------------------------------

artifact="$(api GET "/api/emi/runs/${run_id}/artifacts/rules.json")" \
  || die "the run finished but produced no rules.json"
rules_url="$(printf '%s' "$artifact" | jq -r '.url // empty')"
[ -n "$rules_url" ] || die "no download URL for rules.json"

rules_path="${RUNNER_TEMP:-/tmp}/emi-rules.json"
curl --silent --show-error --fail --max-time 120 "$rules_url" -o "$rules_path" \
  || die "could not download rules.json"

critical="$(jq -r '.summary.critical // 0' "$rules_path")"
warning="$(jq -r '.summary.warning // 0' "$rules_path")"
info="$(jq -r '.summary.info // 0' "$rules_path")"

{
  echo "critical=${critical}"
  echo "warning=${warning}"
  echo "info=${info}"
  echo "rules_json=${rules_path}"
} >> "$GITHUB_OUTPUT"

note ""
note "EMI findings: ${critical} critical, ${warning} warning, ${info} info"

# Annotate each finding so it appears against the workflow run rather than only in the log.
jq -r '.findings[]? | "\(.severity)\t\(.rule)\t\(.title)\t\(.detail // "")"' "$rules_path" \
| while IFS=$'\t' read -r sev rule title detail; do
    case "$sev" in
      critical) level=error ;;
      warning)  level=warning ;;
      *)        level=notice ;;
    esac
    echo "::${level} title=EMI ${rule}::${title}${detail:+ — ${detail}}"
  done

if [ "${EMI_SUMMARY:-true}" = "true" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## EMI analysis"
    echo
    echo "**${critical}** critical · **${warning}** warning · **${info}** info"
    echo
    if [ "$((critical + warning + info))" -gt 0 ]; then
      echo "| Severity | Check | Net | Finding |"
      echo "|---|---|---|---|"
      jq -r '.findings[]? | "| \(.severity) | `\(.rule)` | \(if .net == "" or .net == null then "—" else "`" + .net + "`" end) | \(.title) |"' "$rules_path"
      echo
    fi
    echo "[Open the board in the EMI Analyzer](${API_BASE}/tools/emi/${project_id})"
  } >> "$GITHUB_STEP_SUMMARY"
fi

case "$FAIL_ON" in
  critical) [ "$critical" -eq 0 ] || die "${critical} critical EMI finding(s)" ;;
  warning)  [ "$((critical + warning))" -eq 0 ] || die "${critical} critical and ${warning} warning EMI finding(s)" ;;
  none)     ;;
esac

note "EMI analysis passed."
