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

if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "Logging in to ghcr.io for private image pulls."
  retry 3 5 sh -c 'printf "%s" "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin >/dev/null'
fi

reverse_proxy="${SYRNIKE_REVERSE_PROXY:-false}"
video_enabled="${SYRNIKE_VIDEO_ENABLED:-true}"
edge_network="${SYRNIKE_EDGE_NETWORK:-syrnike13-edge}"
admin_domain="${SYRNIKE_ADMIN_DOMAIN:-admin.${SYRNIKE_DOMAIN}}"

if ! docker network inspect "$edge_network" >/dev/null 2>&1; then
  echo "Creating shared edge Docker network: $edge_network"
  docker network create "$edge_network" >/dev/null
fi

if [[ ! -f Syrnike.toml && -f Revolt.toml ]]; then
  echo "Migrating existing Revolt.toml to Syrnike.toml."
  cp Revolt.toml "Revolt.toml.pre-syrnike-$(date +%Y%m%d%H%M%S).bak"
  cp Revolt.toml Syrnike.toml
fi

if [[ -f secrets.env ]] && grep -q '^REVOLT__' secrets.env; then
  echo "Migrating secrets.env from REVOLT__ keys to SYRNIKE__ keys."
  cp secrets.env "secrets.env.pre-syrnike-$(date +%Y%m%d%H%M%S).bak"
  perl -pi -e 's/^REVOLT__/SYRNIKE__/g' secrets.env
fi

if [[ ! -f secrets.env || ! -f Syrnike.toml || ! -f livekit.yml ]]; then
  echo "syrnike13 config is missing; generating initial server-local config for ${SYRNIKE_DOMAIN}."

  reverse_proxy_answer="n"
  if [[ "$reverse_proxy" == "true" || "$reverse_proxy" == "1" || "$reverse_proxy" == "yes" ]]; then
    reverse_proxy_answer="y"
  fi

  video_answer="Y"
  if [[ "$video_enabled" == "false" || "$video_enabled" == "0" || "$video_enabled" == "no" ]]; then
    video_answer="n"
  fi

  printf "%s\n%s\n" "$reverse_proxy_answer" "$video_answer" | ./generate_config.sh "$SYRNIKE_DOMAIN"
else
  echo "Existing syrnike13 config found; keeping server-local secrets and generated config."
fi

CADDY_ADMIN_HOSTNAME="$admin_domain" \
  ./scripts/reload-caddy.sh "${CADDYFILE_CANDIDATE:-Caddyfile}"

if [[ -n "${DEPLOY_SERVICES:-}" ]]; then
  read -r -a services <<< "$DEPLOY_SERVICES"
  echo "Deploying services: ${services[*]}"

  deploy_database=false
  application_services=()
  for service in "${services[@]}"; do
    if [[ "$service" == "database" ]]; then
      deploy_database=true
    else
      application_services+=("$service")
    fi
  done

  if [[ "$deploy_database" == "true" ]]; then
    echo "Reconciling MongoDB before application services."
    retry 3 5 docker compose pull database
    docker compose up -d --no-deps --wait --wait-timeout 120 database
  fi

  if (( ${#application_services[@]} > 0 )); then
    retry 3 5 docker compose pull "${application_services[@]}"
    docker compose up -d --no-deps "${application_services[@]}"
  fi

  docker compose ps "${services[@]}"
else
  echo "Deploying the full production stack."
  retry 3 5 docker compose pull
  docker compose up -d --remove-orphans
  docker compose ps
fi
