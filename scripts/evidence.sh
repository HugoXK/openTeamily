#!/usr/bin/env bash
# One command per evidence slice: before/after arms of one route with a
# restricted or full grid, PNGs copied into evidence/<issue>/, one report.json.
#
#   bash scripts/evidence.sh <issue> <base-sha|-> <head-sha|-> "<routes>" ["states"] [extra shots.mjs flags]
#
# Grid defaults to the owner rule (1440x900 + 390x844) x (zh-CN + en) x
# (light + dark). Restrict it per pass with:
#   GRID_VIEWPORTS=1440x900 GRID_LOCALES=zh-CN GRID_THEMES=light
# Other env:
#   MERGE=1        keep the existing evidence/<issue>/ and add this pass to its
#                  report.json (shoot states in several passes without losing frames)
#   NAMES=flat     include the slug+arm in the file name (default: plain
#                  <locale>__<theme>__<viewport>__<route>__<state>.png, one folder per arm)
#   STATE_FILE=... pass --state-file for custom states
#
# A dash means "that arm is not ready"; the pass then shoots only the other arm.
# Extra arguments after the five positional ones go to shots.mjs unchanged
# (for example --probes '#a;.b' or --allow-status 401).
set -euo pipefail
issue="${1:?issue}"; base="${2:?-}"; head="${3:?-}"; routes="${4:?routes}"
states="${5:-default}"; shift 5 2>/dev/null || shift 4
slug="ev$issue"
viewports="${GRID_VIEWPORTS:-1440x900,390x844}"
locales="${GRID_LOCALES:-zh-CN,en}"
themes="${GRID_THEMES:-light,dark}"

args=(--slug "$slug" --routes "$routes" --states "$states"
      --viewports "$viewports" --locales "$locales" --themes "$themes"
      --wait-until domcontentloaded)
[ "${NAMES:-plain}" = "flat" ] && args+=(--flat)
[ -n "${STATE_FILE:-}" ] && args+=(--state-file "$STATE_FILE")
[ "$base" != "-" ] && args+=(--before "$base")
[ "$head" != "-" ] && args+=(--after "$head")

rc=0
node scripts/shots.mjs "${args[@]}" "$@" || rc=$?

if [ "${MERGE:-0}" = "1" ]; then
  mkdir -p "evidence/$issue"
else
  rm -rf "evidence/$issue"
  mkdir -p "evidence/$issue"
fi
# The shots report lists images relative to .shots/<slug>/, so copy each arm's
# PNGs into the same relative folder and let report.json keep those paths.
for arm in before after current merged; do
  [ -d ".shots/$slug/$arm" ] || continue
  mkdir -p "evidence/$issue/$arm"
  cp -f ".shots/$slug/$arm/"*.png "evidence/$issue/$arm/" 2>/dev/null || true
done
if [ -f ".shots/$slug/diff.json" ]; then cp ".shots/$slug/diff.json" "evidence/$issue/diff.json"; fi

node scripts/evidence-report.mjs "$issue" ".shots/$slug/report.json"

echo "evidence/$issue ready: $(find "evidence/$issue" -name '*.png' | wc -l) png, arms=${base}..${head}, grid=${viewports} x ${locales} x ${themes}"
exit "$rc"
