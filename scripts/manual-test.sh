#!/usr/bin/env bash
#
# Manual, human-watchable test of the sliding window rate limiter.
# Hits the REAL running server with curl -- this is not the unit-test style
# check in scripts/verify-limiter.js (which calls the middleware directly
# with fake req/res objects). This one proves the whole HTTP path works.
#
# Prerequisite: the server is already running in another terminal:
#   npm run dev
#
# Usage:
#   ./scripts/manual-test.sh
#   BASE_URL=http://localhost:4000 ./scripts/manual-test.sh   # different port
#   LIMIT=10 GAP_SECONDS=10 ./scripts/manual-test.sh          # match a custom server config
#
# --- why two bursts, not one --------------------------------------------
# A single fast burst (everything fired in the same fraction of a second)
# is the wrong test for "does the window roll smoothly, one slot at a time,
# instead of resetting all at once". Every request in a sub-second burst
# expires at nearly the same instant too, so waiting it out frees the WHOLE
# burst simultaneously -- which looks identical to a fixed window resetting.
# That does not prove anything about sliding vs fixed behavior.
#
# So this script fires two bursts, GAP_SECONDS apart. The first burst's
# timestamps expire together, GAP_SECONDS before the second burst's do.
# Watching only PART of the window's usage free up -- while requests from
# the second burst are still counted -- is what actually demonstrates a
# sliding window instead of a fixed one.
#
# All "expect" numbers below are computed from the headers the server
# actually returns during the run, not from fixed arithmetic -- so the
# predictions stay correct even if this IP already had some usage before
# the script started (e.g. you ran it twice within one window).

set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT="$BASE_URL/api/data"
LIMIT="${LIMIT:-10}"              # should match the server's configured max
GAP_SECONDS="${GAP_SECONDS:-10}"  # time between the two bursts; must be « the window

PHASE1_COUNT=$((LIMIT / 2))                    # roughly half the limit
PHASE2_COUNT=$((LIMIT - PHASE1_COUNT + 3))     # enough to overflow by a few

HDR_FILE="$(mktemp)"
trap 'rm -f "$HDR_FILE"' EXIT

hr() { printf '%.0s-' {1..72}; echo; }

LAST_STATUS=""
LAST_REMAINING=""
LAST_RETRY_AFTER=""

do_request() {
  local label="$1"
  local status remaining retry_after

  status=$(curl -s -o /dev/null -D "$HDR_FILE" -w '%{http_code}' "$ENDPOINT")
  remaining=$(grep -i '^X-RateLimit-Remaining:' "$HDR_FILE" | tr -d '\r' | awk '{print $2}')
  retry_after=$(grep -i '^Retry-After:' "$HDR_FILE" | tr -d '\r' | awk '{print $2}')

  LAST_STATUS="$status"; LAST_REMAINING="$remaining"; LAST_RETRY_AFTER="$retry_after"

  if [ "$status" = "200" ]; then
    printf '%-24s HTTP %s   remaining=%-3s\n' "$label" "$status" "${remaining:-?}"
  elif [ "$status" = "429" ]; then
    printf '%-24s HTTP %s   remaining=%-3s retry-after=%ss\n' "$label" "$status" "${remaining:-0}" "${retry_after:-?}"
  else
    printf '%-24s HTTP %s   (server not reachable at %s?)\n' "$label" "${status:-???}" "$BASE_URL"
  fi
}

hr
echo "Target: $ENDPOINT   |   assuming server limit = $LIMIT per window"
echo "(if this doesn't match src/server.js, re-run with LIMIT=<actual value>)"
hr

health_status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/health" 2>/dev/null)
if [ "$health_status" != "200" ]; then
  echo "Could not reach $BASE_URL/health (got HTTP ${health_status:-none})."
  echo "Start the server first in another terminal:  npm run dev"
  exit 1
fi

# --- Phase 1: use up roughly half the limit --------------------------------

echo "PHASE 1 -- $PHASE1_COUNT requests right now:"
phase1_successes=0
for i in $(seq 1 "$PHASE1_COUNT"); do
  do_request "  phase1 request $i"
  [ "$LAST_STATUS" = "200" ] && phase1_successes=$((phase1_successes + 1))
done
free_after_phase1="${LAST_REMAINING:-0}"
echo "-> $phase1_successes/$PHASE1_COUNT succeeded. These are the OLDEST timestamps in the window."
echo "   ($free_after_phase1 slots free going into phase 2)"
hr

echo "Waiting ${GAP_SECONDS}s before phase 2 (so phase 1's timestamps age separately"
echo "from phase 2's -- this gap is what makes the partial-expiry step meaningful)..."
sleep "$GAP_SECONDS"

# --- Phase 2: push past the limit ------------------------------------------

echo
echo "PHASE 2 -- $PHASE2_COUNT more requests right now:"
phase2_successes=0
for i in $(seq 1 "$PHASE2_COUNT"); do
  do_request "  phase2 request $i"
  [ "$LAST_STATUS" = "200" ] && phase2_successes=$((phase2_successes + 1))
done
echo "-> $phase2_successes/$PHASE2_COUNT succeeded (expected around $free_after_phase1, i.e."
echo "   exactly the slots phase 1 left free), then 429 for the rest."
hr

if [ -z "${LAST_RETRY_AFTER:-}" ]; then
  echo "No 429 seen in phase 2 -- the window isn't full yet."
  echo "Re-run with a bigger PHASE2_COUNT, e.g.: LIMIT=$LIMIT GAP_SECONDS=$GAP_SECONDS ./scripts/manual-test.sh"
  echo "(increase the +3 margin in the script, or lower LIMIT to match the real server config)"
  exit 1
fi

# --- Wait for phase 1 (only) to expire -------------------------------------

wait_secs=$((LAST_RETRY_AFTER + 1))
echo
echo "Waiting ${wait_secs}s (Retry-After was ${LAST_RETRY_AFTER}s) -- long enough for"
echo "PHASE 1's timestamps to fall out of the window, but NOT phase 2's (they're"
echo "only ${GAP_SECONDS}s younger, still well inside the window)..."
sleep "$wait_secs"

hr
do_request "boundary request"
expected_remaining=$((LIMIT - phase2_successes - 1))
echo "-> HTTP $LAST_STATUS, remaining=$LAST_REMAINING   (predicted: $expected_remaining)"
echo
echo "This should be HTTP 200 with remaining=$expected_remaining:"
echo "  -- NOT $((LIMIT - 1)) (that would mean the ENTIRE window reset -- fixed-window behavior)"
echo "  -- NOT 0 (that would mean nothing expired at all)"
echo "  remaining=$expected_remaining means exactly phase 1's timestamps freed, while"
echo "  phase 2's $phase2_successes requests are still being counted. That's the sliding window."
hr

# --- Drain whatever just freed, then confirm the window is full again ------

drain_count="${LAST_REMAINING:-0}"
if [ "$drain_count" -gt 0 ]; then
  echo
  echo "Using up the rest of what just freed ($drain_count more requests):"
  for i in $(seq 1 "$drain_count"); do
    do_request "  drain request $i"
  done
fi
do_request "  one more (should now fail)"
echo "Expect: the last line -> 429 (phase 2's requests still fill the rest of the window)."
hr
