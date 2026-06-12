#!/usr/bin/env bash
# Removes old versioned desktop release artifacts from the update-feed directory.
# Keeps manifests and stable aliases because they do not carry embedded versions.
set -euo pipefail

DESKTOP_DIR="${1:-.}"
KEEP_VERSIONS="${2:-${DESKTOP_RELEASE_KEEP_VERSIONS:-5}}"

if ! [[ "$KEEP_VERSIONS" =~ ^[0-9]+$ ]] || [ "$KEEP_VERSIONS" -lt 1 ]; then
  echo "KEEP_VERSIONS must be a positive integer, got: $KEEP_VERSIONS" >&2
  exit 1
fi

mkdir -p "$DESKTOP_DIR"
cd "$DESKTOP_DIR"

declare -A SEEN_VERSIONS=()
VERSIONS=()

while IFS= read -r -d '' FILE; do
  NAME="${FILE#./}"
  if [[ "$NAME" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    VERSION="${BASH_REMATCH[1]}"
    if [ -z "${SEEN_VERSIONS[$VERSION]+x}" ]; then
      SEEN_VERSIONS["$VERSION"]=1
      VERSIONS+=("$VERSION")
    fi
  fi
done < <(find . -maxdepth 1 -type f -print0)

if [ "${#VERSIONS[@]}" -le "$KEEP_VERSIONS" ]; then
  echo "Desktop artifact pruning skipped: ${#VERSIONS[@]} version(s), keeping $KEEP_VERSIONS."
  exit 0
fi

mapfile -t SORTED_VERSIONS < <(printf '%s\n' "${VERSIONS[@]}" | sort -V)

declare -A KEEP=()
START_INDEX=$((${#SORTED_VERSIONS[@]} - KEEP_VERSIONS))
for ((INDEX = START_INDEX; INDEX < ${#SORTED_VERSIONS[@]}; INDEX++)); do
  KEEP["${SORTED_VERSIONS[$INDEX]}"]=1
done

REMOVED=0
while IFS= read -r -d '' FILE; do
  NAME="${FILE#./}"
  if [[ "$NAME" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    VERSION="${BASH_REMATCH[1]}"
    if [ -z "${KEEP[$VERSION]+x}" ]; then
      if [ "${DRY_RUN:-}" = "1" ]; then
        echo "Would remove old desktop artifact: $NAME"
      else
        rm -f -- "$FILE"
        echo "Removed old desktop artifact: $NAME"
      fi
      REMOVED=$((REMOVED + 1))
    fi
  fi
done < <(find . -maxdepth 1 -type f -print0)

printf 'Kept desktop release versions:'
for VERSION in "${SORTED_VERSIONS[@]:START_INDEX}"; do
  printf ' %s' "$VERSION"
done
printf '\n'

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "Would remove $REMOVED old desktop artifact file(s)."
else
  echo "Removed $REMOVED old desktop artifact file(s)."
fi
