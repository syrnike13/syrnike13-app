#!/usr/bin/env bash
# Создаёт стабильные симлинки для лендинга:
#   syrnike13.dmg, syrnike13-setup.exe, syrnike13.AppImage
# Цели берутся из electron-updater манифестов latest*.yml в той же директории.
set -euo pipefail

DESKTOP_DIR="${1:-.}"
cd "$DESKTOP_DIR"

yml_path() {
  awk '$1 == "path:" { sub(/^path:[[:space:]]*/, ""); print; exit }' "$1"
}

yml_dmg_url() {
  awk '/url:.*\.dmg$/ { sub(/.*url:[[:space:]]*/, ""); print; exit }' "$1"
}

link_alias() {
  local alias="$1"
  local target="$2"

  if [ -z "$target" ]; then
    echo "No target resolved for $alias" >&2
    exit 1
  fi
  if [ ! -e "$target" ]; then
    echo "Target missing for $alias: $target" >&2
    exit 1
  fi

  ln -sfn "$target" "$alias"
  echo "$alias -> $target"
}

WIN_TARGET="$(yml_path latest.yml)"
LINUX_TARGET="$(yml_path latest-linux.yml)"
MAC_DMG="$(yml_dmg_url latest-mac.yml)"
if [ -z "$MAC_DMG" ]; then
  MAC_DMG="$(ls -1 *.dmg 2>/dev/null | head -1 || true)"
fi

link_alias syrnike13-setup.exe "$WIN_TARGET"
link_alias syrnike13.AppImage "$LINUX_TARGET"
link_alias syrnike13.dmg "$MAC_DMG"
