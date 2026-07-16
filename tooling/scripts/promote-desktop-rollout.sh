#!/usr/bin/env bash
set -euo pipefail

RELEASE_DIRECTORY="${1:?release directory is required}"
EXPECTED_VERSION="${2:?expected version is required}"
TARGET_PERCENTAGE="${3:?target percentage is required}"
ELIGIBLE_SESSIONS="${4:?eligible session count is required}"
SLO_APPROVED="${5:?SLO approval is required}"

if ! [[ "$ELIGIBLE_SESSIONS" =~ ^[0-9]+$ ]] || (( ELIGIBLE_SESSIONS < 100 )); then
  echo "At least 100 eligible native sessions are required; got $ELIGIBLE_SESSIONS" >&2
  exit 1
fi
if [[ "$SLO_APPROVED" != "true" ]]; then
  echo "Native runtime SLO approval is required before promotion" >&2
  exit 1
fi

case "$TARGET_PERCENTAGE" in
  25|50|100) ;;
  *) echo "Unsupported rollout percentage: $TARGET_PERCENTAGE" >&2; exit 1 ;;
esac

shopt -s nullglob
MANIFESTS=("$RELEASE_DIRECTORY"/latest*.yml "$RELEASE_DIRECTORY"/latest*.yaml)
if (( ${#MANIFESTS[@]} == 0 )); then
  echo "No desktop update manifests found in $RELEASE_DIRECTORY" >&2
  exit 1
fi

STAGING_DIRECTORY="$(mktemp -d "$RELEASE_DIRECTORY/.desktop-rollout.XXXXXX")"
trap 'rm -rf "$STAGING_DIRECTORY"' EXIT
STAGED_MANIFESTS=()

# Validate and render every feed before changing any public manifest. This
# prevents a bad second platform feed from leaving the first one promoted.
for MANIFEST in "${MANIFESTS[@]}"; do
  AGE_SECONDS="$(( $(date +%s) - $(stat -c %Y "$MANIFEST") ))"
  if (( AGE_SECONDS < 172800 )); then
    echo "$(basename "$MANIFEST") has been at its current stage for ${AGE_SECONDS}s; 172800s are required" >&2
    exit 1
  fi
  VERSION="$(awk -F': *' '$1 == "version" { gsub(/^["\047]|["\047]$/, "", $2); print $2; exit }' "$MANIFEST")"
  CURRENT="$(awk -F': *' '$1 == "stagingPercentage" { print $2; exit }' "$MANIFEST")"
  if [[ "$VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "$(basename "$MANIFEST") version mismatch: expected $EXPECTED_VERSION, got ${VERSION:-<missing>}" >&2
    exit 1
  fi

  case "${CURRENT:-missing}:$TARGET_PERCENTAGE" in
    5:25|25:50|50:100|25:25|50:50|100:100) ;;
    *)
      echo "Invalid rollout transition for $(basename "$MANIFEST"): ${CURRENT:-missing}% -> $TARGET_PERCENTAGE%" >&2
      exit 1
      ;;
  esac

  TEMP="$STAGING_DIRECTORY/$(basename "$MANIFEST")"
  awk -v percentage="$TARGET_PERCENTAGE" '
    $1 == "stagingPercentage:" { print "stagingPercentage: " percentage; found=1; next }
    { print }
    END { if (!found) print "stagingPercentage: " percentage }
  ' "$MANIFEST" > "$TEMP"
  chmod --reference="$MANIFEST" "$TEMP"
  STAGED_MANIFESTS+=("$TEMP")
done

for INDEX in "${!MANIFESTS[@]}"; do
  MANIFEST="${MANIFESTS[$INDEX]}"
  TEMP="${STAGED_MANIFESTS[$INDEX]}"
  mv -f "$TEMP" "$MANIFEST"
  echo "Promoted $(basename "$MANIFEST") to $TARGET_PERCENTAGE%"
done
