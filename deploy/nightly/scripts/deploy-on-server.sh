#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SYRNIKE_DOMAIN:-}" ]]; then
  echo "SYRNIKE_DOMAIN is required" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on this server" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not available on this server" >&2
  exit 1
fi

retry() {
  local attempts="${1:?attempt count is required}"
  local delay="${2:?retry delay is required}"
  shift 2

  local attempt=1
  until "$@"; do
    if (( attempt >= attempts )); then
      return 1
    fi

    echo "Command failed, retrying in ${delay}s (${attempt}/${attempts}): $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

edge_network="${SYRNIKE_EDGE_NETWORK:-syrnike13-edge}"

if ! docker network inspect "$edge_network" >/dev/null 2>&1; then
  echo "Creating shared edge Docker network: $edge_network"
  docker network create "$edge_network" >/dev/null
fi

if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "Logging in to ghcr.io for private image pulls."
  retry 3 5 sh -c 'printf "%s" "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin >/dev/null'
fi

if [[ ! -f secrets.env || ! -f Syrnike.toml || ! -f livekit.yml ]]; then
  echo "Nightly config is missing; generating server-local config for ${SYRNIKE_DOMAIN}."
  export LIVEKIT_RTC_PORT_RANGE_START="${LIVEKIT_RTC_PORT_RANGE_START:-50101}"
  export LIVEKIT_RTC_PORT_RANGE_END="${LIVEKIT_RTC_PORT_RANGE_END:-50200}"
  export LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7882}"
  export LIVEKIT_TURN_UDP_PORT="${LIVEKIT_TURN_UDP_PORT:-3479}"
  export LIVEKIT_TURN_RELAY_RANGE_START="${LIVEKIT_TURN_RELAY_RANGE_START:-30101}"
  export LIVEKIT_TURN_RELAY_RANGE_END="${LIVEKIT_TURN_RELAY_RANGE_END:-30200}"
  printf "n\nY\n" | ./generate_config.sh "$SYRNIKE_DOMAIN"
else
  echo "Existing nightly config found; keeping server-local secrets and generated config."
fi

if [[ -n "${DEPLOY_SERVICES:-}" ]]; then
  read -r -a services <<< "$DEPLOY_SERVICES"
  echo "Deploying nightly services: ${services[*]}"
  retry 3 5 docker compose pull "${services[@]}"
  docker compose up -d --no-deps "${services[@]}"
  docker compose ps "${services[@]}"
else
  echo "Deploying the full nightly stack."
  retry 3 5 docker compose pull
  docker compose up -d --remove-orphans
  docker compose ps
fi
