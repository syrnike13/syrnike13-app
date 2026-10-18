#!/usr/bin/env bash
# Rolling updates for compose services, sourced by deploy-on-server.sh.
#
# A user-facing service is updated by starting a second container next to the
# running one, waiting until it accepts connections, and only then stopping
# the old container. Caddy reaches services through network aliases that both
# containers share, so requests and gateway connections move over without a
# gap. The events gateway hands its clients over during its stop grace period.

# Port each rolled service listens on inside its container.
declare -A ROLLOUT_PORTS=(
  [api]=14702
  [events]=14703
  [autumn]=14704
  [january]=14705
  [gifbox]=14706
  [voice-ingress]=8500
  [web]=5000
  [admin]=5000
)

ROLLOUT_READY_TIMEOUT="${ROLLOUT_READY_TIMEOUT:-180}"

rollout_container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" | awk '{print $1}'
}

rollout_is_current() {
  local service="$1" container="$2"
  local image want_image have_image want_hash have_hash

  image="$(docker compose config --images "$service")"
  want_image="$(docker image inspect -f '{{.Id}}' "$image")"
  have_image="$(docker inspect -f '{{.Image}}' "$container")"
  want_hash="$(docker compose config --hash "$service" | awk '{print $2}')"
  have_hash="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")"

  [[ "$want_image" == "$have_image" && "$want_hash" == "$have_hash" ]]
}

rollout_wait_ready() {
  local service="$1" container="$2" port="$3"
  local ip deadline

  deadline=$((SECONDS + ROLLOUT_READY_TIMEOUT))
  while (( SECONDS < deadline )); do
    # A crashing container is restarted by its restart policy, so a restart
    # counts as a failure too.
    if [[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$container" 2>/dev/null)" != "true 0" ]]; then
      echo "New $service container stopped before it became ready." >&2
      docker logs --tail 50 "$container" >&2 || true
      return 1
    fi

    ip="$(rollout_container_ip "$container")"
    if [[ -n "$ip" ]] && (timeout 2 bash -c "</dev/tcp/$ip/$port") 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "New $service container did not accept connections within ${ROLLOUT_READY_TIMEOUT}s." >&2
  docker logs --tail 50 "$container" >&2 || true
  return 1
}

rollout_service() {
  local service="$1"
  local port="${ROLLOUT_PORTS[$service]}"
  local -a old=() current=() new=()
  local container

  mapfile -t old < <(docker compose ps -q "$service")
  if (( ${#old[@]} == 0 )); then
    echo "Starting $service."
    docker compose up -d --no-deps "$service"
    return
  fi

  if (( ${#old[@]} == 1 )) && rollout_is_current "$service" "${old[0]}"; then
    echo "$service is up to date."
    return
  fi

  echo "Rolling out $service."
  docker compose up -d --no-deps --no-recreate --scale "$service=$(( ${#old[@]} + 1 ))" "$service"

  mapfile -t current < <(docker compose ps -q "$service")
  for container in "${current[@]}"; do
    if [[ ! " ${old[*]} " =~ " $container " ]]; then
      new+=("$container")
    fi
  done
  if (( ${#new[@]} != 1 )); then
    echo "Expected one new $service container, found ${#new[@]}." >&2
    return 1
  fi

  if ! rollout_wait_ready "$service" "${new[0]}" "$port"; then
    docker rm -f "${new[0]}" >/dev/null
    return 1
  fi

  # docker stop honours the container's stop_grace_period, which gives the
  # events gateway time to hand its clients over.
  echo "New $service container is ready; stopping the previous one."
  docker stop "${old[@]}" >/dev/null
  docker rm "${old[@]}" >/dev/null
}

# Deploy compose services, rolling the user-facing ones and recreating the rest.
rollout_deploy() {
  local -a rolled=() recreated=()
  local service

  for service in "$@"; do
    if [[ -n "${ROLLOUT_PORTS[$service]:-}" ]]; then
      rolled+=("$service")
    else
      recreated+=("$service")
    fi
  done

  if (( ${#recreated[@]} > 0 )); then
    docker compose up -d --no-deps "${recreated[@]}"
  fi

  for service in "${rolled[@]}"; do
    rollout_service "$service"
  done
}
