#!/usr/bin/env bash
#
# Wait until a URL answers with a 2xx status.
#
# Usage: scripts/wait-for-http.sh URL [TIMEOUT_SECONDS=60]

set -euo pipefail

url="${1:?usage: wait-for-http.sh URL [TIMEOUT_SECONDS]}"
timeout="${2:-60}"
deadline=$((SECONDS + timeout))

until curl --silent --fail --max-time 3 --output /dev/null "$url"; do
  if ((SECONDS >= deadline)); then
    echo "error: $url did not become ready within ${timeout}s" >&2
    exit 1
  fi
  sleep 1
done
echo "$url is ready"
