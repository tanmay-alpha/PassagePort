#!/usr/bin/env bash
#
# End-to-end smoke test against a running PassagePort server in local mode:
# create a collection, upload a document, wait for indexing, search it, resolve the citation.
#
# Usage: scripts/smoke.sh [BASE_URL=http://127.0.0.1:8000]
# Needs: curl, jq. Works with any embedding backend (CI uses PP_EMBEDDING_BACKEND=hashing).

set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8000}"
BASE_URL="${BASE_URL%/}"
MARKER="quillfeather"

workdir="$(mktemp -d)"
collection_id=""

cleanup() {
  if [[ -n "$collection_id" ]]; then
    curl --silent --output /dev/null --max-time 10 -X DELETE \
      -H "X-PassagePort-CSRF: 1" "$BASE_URL/api/collections/$collection_id" || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAILED: $*" >&2
  if [[ -f "$workdir/body" ]]; then
    echo "last response body:" >&2
    head -c 2000 "$workdir/body" >&2
    echo >&2
  fi
  exit 1
}

# request EXPECTED_STATUS CURL_ARGS... -> prints the response body, fails on any other status.
request() {
  local expected="$1"
  shift
  local status
  status="$(curl --silent --show-error --max-time 30 --output "$workdir/body" \
    --write-out '%{http_code}' -H "X-PassagePort-CSRF: 1" "$@")" || fail "request failed: $*"
  [[ "$status" == "$expected" ]] || fail "expected HTTP $expected, got $status: $*"
  cat "$workdir/body"
}

echo "1. health"
[[ "$(request 200 "$BASE_URL/api/health" | jq -r .status)" == "ok" ]] || fail "health is not ok"

echo "2. the web client is served from the same origin"
request 200 "$BASE_URL/" >"$workdir/index.html"
grep -qi "<!doctype html" "$workdir/index.html" || fail "/ did not return the web client"

echo "3. local mode rejects non-loopback Host headers"
status="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
  -H "Host: passageport.example.com" "$BASE_URL/api/collections")"
[[ "$status" =~ ^4 ]] || fail "a foreign Host header was answered with HTTP $status"

echo "4. create a collection"
collection_id="$(request 201 -X POST "$BASE_URL/api/collections" \
  -H "Content-Type: application/json" \
  --data "{\"name\": \"smoke-$(date +%s)-$RANDOM\", \"description\": \"created by scripts/smoke.sh\"}" |
  jq -er .id)"

echo "5. upload a document"
cat >"$workdir/lighthouse.txt" <<EOF
Harbour operations manual

The lighthouse keeper records the tide tables every morning before the ferry departs.
The $MARKER ledger is stored in the brass cabinet beside the signal lamp.

Maintenance

The signal lamp is inspected on the first Monday of each month.
EOF
document_id="$(request 201 -X POST "$BASE_URL/api/collections/$collection_id/documents" \
  -F "file=@$workdir/lighthouse.txt;type=text/plain" | jq -er .document.id)"

echo "6. wait for indexing"
status=""
for _ in $(seq 1 90); do
  status="$(request 200 "$BASE_URL/api/documents/$document_id" | jq -r .status)"
  case "$status" in
    indexed) break ;;
    failed) fail "indexing failed" ;;
  esac
  sleep 1
done
[[ "$status" == "indexed" ]] || fail "document was still '$status' after 90s"

echo "7. keyword search finds the passage, with citation metadata"
hit="$(request 200 -X POST "$BASE_URL/api/search" -H "Content-Type: application/json" \
  --data "{\"collection_id\": \"$collection_id\", \"query\": \"$MARKER ledger\", \"mode\": \"keyword\"}" |
  jq -ec '.results[0]')" || fail "keyword search returned no results"
jq -e --arg doc "$document_id" --arg marker "$MARKER" '
  .document_id == $doc
  and (.text | contains($marker))
  and (.chunk_id | length > 0)
  and (.document_title | length > 0)
  and (.page_label | length > 0)
  and .page_number >= 1' <<<"$hit" >/dev/null || fail "top hit lacks the expected citation: $hit"

echo "8. hybrid search returns results"
request 200 -X POST "$BASE_URL/api/search" -H "Content-Type: application/json" \
  --data "{\"collection_id\": \"$collection_id\", \"query\": \"where is the ledger kept\"}" |
  jq -e '.results | length >= 1' >/dev/null || fail "hybrid search returned no results"

echo "9. the citation resolves to the exact characters of the stored page"
chunk_id="$(jq -r .chunk_id <<<"$hit")"
chunk="$(request 200 "$BASE_URL/api/chunks/$chunk_id")"
page_number="$(jq -r .page_number <<<"$chunk")"
page_text="$(request 200 "$BASE_URL/api/documents/$document_id/pages/$page_number" | jq -r .text)"
jq -e --arg page "$page_text" '. as $c | $page[$c.char_start:$c.char_end] == $c.text' \
  <<<"$chunk" >/dev/null || fail "page text slice does not equal the chunk text"

echo "10. delete the collection"
request 204 -X DELETE "$BASE_URL/api/collections/$collection_id" >/dev/null
collection_id=""

echo "SMOKE OK"
