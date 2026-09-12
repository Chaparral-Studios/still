#!/usr/bin/env bash
# Extract top domains (by visit count) from local browser history for the
# motion sweep. Writes tests/motion/sites-<source>.txt (gitignored).
#
#   ./tests/motion/history-sites.sh chrome    # every Chrome profile on this Mac, merged
#   ./tests/motion/history-sites.sh safari    # ~/Library/Safari/History.db (iCloud-synced
#                                             # iPhone history; needs Full Disk Access)
#   ./tests/motion/history-sites.sh all
set -euo pipefail
SRC="${1:-all}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LIMIT="${LIMIT:-200}"

# SQL that reduces a url column to a bare host, stripping a leading www.
host_sql () {
  local table="$1"
  echo "select case when h like 'www.%' then substr(h,5) else h end, visit_count from (select case when instr(substr(url,instr(url,'://')+3),'/')>0 then substr(substr(url,instr(url,'://')+3),1,instr(substr(url,instr(url,'://')+3),'/')-1) else substr(url,instr(url,'://')+3) end h, visit_count from $table);"
}

merge () { awk -F'|' 'NF==2 && $1!="" {c[$1]+=$2} END {for (h in c) print c[h]"|"h}' | sort -t'|' -k1,1nr | head -"$LIMIT"; }

do_chrome () {
  local out="$DIR/sites-chrome.txt" n=0
  : > "$out"
  for f in ~/Library/Application\ Support/Google/Chrome/*/History; do
    [ -f "$f" ] || continue
    cp "$f" /tmp/history-sites.db
    sqlite3 /tmp/history-sites.db "$(host_sql urls)" 2>/dev/null || true
    n=$((n+1))
  done | merge > "$out"
  echo "chrome: $(wc -l < "$out" | tr -d ' ') domains -> $out"
}

do_safari () {
  local out="$DIR/sites-safari.txt" db=~/Library/Safari/History.db
  if ! cp "$db" /tmp/history-sites.db 2>/dev/null; then
    echo "safari: cannot read $db — grant Full Disk Access to your terminal app, and make sure Safari iCloud sync is on (iPhone + Mac)" >&2
    return 1
  fi
  sqlite3 /tmp/history-sites.db "$(host_sql history_items)" | merge > "$out"
  echo "safari: $(wc -l < "$out" | tr -d ' ') domains -> $out"
}

# Screen Time's knowledge store. With "Share Across Devices" on, it holds
# website usage from every device on the Apple ID — including an iPhone whose
# Safari history never syncs. Domains only, weighted by seconds of use.
do_screentime () {
  local out="$DIR/sites-screentime.txt" db=~/Library/Application\ Support/Knowledge/knowledgeC.db
  if ! cp "$db" /tmp/history-sites.db 2>/dev/null; then
    echo "screentime: cannot read $db — grant Full Disk Access to your terminal app" >&2
    return 1
  fi
  sqlite3 /tmp/history-sites.db "select case when ZVALUESTRING like 'www.%' then substr(ZVALUESTRING,5) else ZVALUESTRING end, cast(sum(ZENDDATE-ZSTARTDATE) as integer) from ZOBJECT where ZSTREAMNAME='/app/webUsage' and ZVALUESTRING is not null group by 1;" | merge > "$out"
  local devices
  devices=$(sqlite3 /tmp/history-sites.db "select count(distinct ZSOURCE) from ZOBJECT where ZSTREAMNAME='/app/webUsage';" 2>/dev/null || echo '?')
  echo "screentime: $(wc -l < "$out" | tr -d ' ') domains from $devices source(s) -> $out  (more than 1 source = phone data is included)"
}

case "$SRC" in
  chrome) do_chrome ;;
  safari) do_safari ;;
  screentime) do_screentime ;;
  all) do_chrome; do_safari || true; do_screentime || true ;;
  *) echo "usage: $0 chrome|safari|screentime|all" >&2; exit 2 ;;
esac
rm -f /tmp/history-sites.db
