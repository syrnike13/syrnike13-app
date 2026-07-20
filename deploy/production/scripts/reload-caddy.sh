#!/usr/bin/env bash
set -euo pipefail

candidate_path="${1:-Caddyfile}"
active_path="${CADDYFILE_PATH:-Caddyfile}"
container_candidate_path="/tmp/syrnike13-Caddyfile.candidate"
lock_path="${CADDY_RELOAD_LOCK_PATH:-/tmp/syrnike13-caddy-reload.lock}"

exec 9>"$lock_path"
flock --exclusive 9

committed=false
config_update_attempted=false
config_file_existed=false
backup_path=""
env_backup_path=""
env_file_existed=false

on_exit() {
  local status=$?
  trap - EXIT

  if (( status != 0 )) && [[ "$committed" != "true" ]]; then
    if [[ "$config_update_attempted" == "true" ]]; then
      if [[ "$config_file_existed" == "true" ]]; then
        echo "Restoring the previous Caddyfile after a failed update." >&2
        cp -- "$backup_path" "$active_path" || true
      else
        rm -f -- "$active_path" || true
      fi
    fi

    if [[ -n "$env_backup_path" ]]; then
      if [[ "$env_file_existed" == "true" ]]; then
        cp -- "$env_backup_path" .env.web || true
      else
        rm -f -- .env.web || true
      fi
    fi
  fi

  if [[ -n "$env_backup_path" ]]; then
    rm -f -- "$env_backup_path" || true
  fi

  exit "$status"
}
trap on_exit EXIT

upsert_env() {
  local file="${1:?env file is required}"
  local key="${2:?env key is required}"
  local value="${3:?env value is required}"

  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf "%s=%s\n" "$key" "$value" >> "$file"
  fi
}

if [[ -n "${CADDY_ADMIN_HOSTNAME:-}${CADDY_NIGHTLY_HOSTNAME:-}${CADDY_NIGHTLY_ADMIN_HOSTNAME:-}" ]]; then
  env_backup_path="$(mktemp /tmp/syrnike13-env-web.XXXXXX)"
  if [[ -f .env.web ]]; then
    cp -- .env.web "$env_backup_path"
    env_file_existed=true
  fi

  if [[ -n "${CADDY_ADMIN_HOSTNAME:-}" ]]; then
    upsert_env .env.web ADMIN_HOSTNAME "$CADDY_ADMIN_HOSTNAME"
  fi
  if [[ -n "${CADDY_NIGHTLY_HOSTNAME:-}" ]]; then
    upsert_env .env.web NIGHTLY_HOSTNAME "$CADDY_NIGHTLY_HOSTNAME"
  fi
  if [[ -n "${CADDY_NIGHTLY_ADMIN_HOSTNAME:-}" ]]; then
    upsert_env .env.web NIGHTLY_ADMIN_HOSTNAME "$CADDY_NIGHTLY_ADMIN_HOSTNAME"
  fi
fi

if [[ ! -f "$candidate_path" ]]; then
  echo "Caddyfile candidate does not exist: $candidate_path" >&2
  exit 1
fi

candidate_path="$(realpath "$candidate_path")"
active_path="$(realpath -m "$active_path")"

if [[ -e "$active_path" && ! -f "$active_path" ]]; then
  echo "Active Caddyfile path is not a regular file: $active_path" >&2
  exit 1
fi

if [[ ! -f "$active_path" ]]; then
  # Compose cannot create a one-off validation container while its service has
  # a missing file bind mount. On a first deploy there is no live config to
  # preserve, so install the candidate temporarily and remove it if validation
  # fails.
  config_update_attempted=true
  cp -- "$candidate_path" "$active_path"
fi

echo "Validating the candidate Caddy configuration."
if ! docker compose run --rm --no-deps \
  --volume "${candidate_path}:${container_candidate_path}:ro" \
  caddy caddy validate \
  --config "$container_candidate_path" \
  --adapter caddyfile; then
  exit 1
fi

config_changed=true
if [[ -f "$active_path" ]] && cmp --silent "$candidate_path" "$active_path"; then
  config_changed=false
fi

if [[ "$config_changed" == "true" ]]; then
  if [[ -f "$active_path" ]]; then
    backup_path="${active_path}.pre-reload-$(date +%Y%m%d%H%M%S).bak"
    cp -- "$active_path" "$backup_path"
    config_file_existed=true
  fi

  # Keep the existing file inode when it is bind-mounted into the live
  # container. Replacing the path with mv can leave the container reading the
  # old inode and make the subsequent reload use stale configuration.
  config_update_attempted=true
  cp -- "$candidate_path" "$active_path"
fi

if ! docker compose ps --status running --quiet caddy | grep -q .; then
  echo "Caddy is not running; starting it with the validated configuration."
  docker compose up -d --no-deps caddy
  committed=true
  exit 0
fi

caddy_env_args=()
if [[ -f .env.web ]]; then
  for key in HOSTNAME ADMIN_HOSTNAME NIGHTLY_HOSTNAME NIGHTLY_ADMIN_HOSTNAME; do
    value="$(sed -n "s/^${key}=//p" .env.web | tail -n 1)"
    if [[ -n "$value" ]]; then
      caddy_env_args+=(--env "${key}=${value}")
    fi
  done
fi

echo "Reloading Caddy without restarting the container."
if docker compose exec -T "${caddy_env_args[@]}" caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  committed=true
  exit 0
fi

exit 1
