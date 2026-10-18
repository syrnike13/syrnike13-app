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

# LiveKit runs as one node, or as two (livekit and livekit-b) when the
# livekit-b compose profile is enabled. With two nodes, a node being updated
# is drained first: it takes no new rooms, and its rooms stay up until they
# empty or LIVEKIT_DRAIN_TIMEOUT passes. Rooms still open then are closed and
# their clients reconnect to the other node.
LIVEKIT_NODE_PORT=7880
LIVEKIT_DRAIN_TIMEOUT="${LIVEKIT_DRAIN_TIMEOUT:-900}"

rollout_container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" | awk '{print $1}'
}

rollout_is_current() {
  local service="$1" container="$2"
  local want_hash have_hash image_ref

  # The config hash covers the image reference, so with an equal hash only a
  # newly pulled image under the same tag can make the container outdated.
  want_hash="$(docker compose config --hash "$service" | awk -v service="$service" '$1 == service { print $2 }')"
  have_hash="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")"
  [[ -n "$want_hash" && "$want_hash" == "$have_hash" ]] || return 1

  image_ref="$(docker inspect -f '{{.Config.Image}}' "$container")"
  [[ "$(docker image inspect -f '{{.Id}}' "$image_ref")" == "$(docker inspect -f '{{.Image}}' "$container")" ]]
}

rollout_accepts_connections() {
  local container="$1" port="$2" ip

  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]] || return 1
  ip="$(rollout_container_ip "$container")"
  [[ -n "$ip" ]] && (timeout 2 bash -c "</dev/tcp/$ip/$port") 2>/dev/null
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

# Value of NAME from the server-local .env that compose interpolates, or DEFAULT.
dotenv_value() {
  local name="$1" default="$2" value=""
  if [[ -f .env ]]; then
    value="$(sed -n -E "s/^${name}=[\"']?([^\"']*)[\"']?[[:space:]]*$/\1/p" .env | tail -n 1)"
  fi
  printf '%s' "${value:-$default}"
}

livekit_b_enabled() {
  docker compose config --services | grep -qx livekit-b
}

# Write livekit-b.yml: the server-local livekit.yml with the second node's
# ports, so both nodes share keys, Redis, webhooks and every other setting.
write_livekit_b_config() {
  local tcp="$1" turn_udp="$2" rtc_start="$3" rtc_end="$4" relay_start="$5" relay_end="$6"
  local port

  for port in "$@"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]]; then
      echo "Invalid livekit-b port: '$port'" >&2
      return 1
    fi
  done

  awk -v tcp="$tcp" -v turn_udp="$turn_udp" -v rtc_start="$rtc_start" -v rtc_end="$rtc_end" \
    -v relay_start="$relay_start" -v relay_end="$relay_end" '
    /^[^ #]/ { section = $1 }
    section == "rtc:" && /^  udp_port:/ { print "livekit.yml sets rtc.udp_port; give livekit-b its own port first" > "/dev/stderr"; failed = 1 }
    section == "rtc:" && /^  tcp_port:/ { print "  tcp_port: " tcp; replaced++; next }
    section == "rtc:" && /^  port_range_start:/ { print "  port_range_start: " rtc_start; replaced++; next }
    section == "rtc:" && /^  port_range_end:/ { print "  port_range_end: " rtc_end; replaced++; next }
    section == "turn:" && /^  udp_port:/ { print "  udp_port: " turn_udp; replaced++; next }
    section == "turn:" && /^  relay_range_start:/ { print "  relay_range_start: " relay_start; replaced++; next }
    section == "turn:" && /^  relay_range_end:/ { print "  relay_range_end: " relay_end; replaced++; next }
    { print }
    END {
      if (replaced != 6) { print "livekit.yml lacks some rtc or turn port settings for livekit-b" > "/dev/stderr"; failed = 1 }
      exit failed
    }
  ' livekit.yml > livekit-b.yml.tmp || { rm -f livekit-b.yml.tmp; return 1; }
  mv livekit-b.yml.tmp livekit-b.yml
}

rollout_livekit_node() {
  local service="$1" other
  local -a old=() new=()

  if [[ "$service" == livekit ]]; then other=livekit-b; else other=livekit; fi

  mapfile -t old < <(docker compose ps -q "$service")
  if (( ${#old[@]} == 1 )) && rollout_is_current "$service" "${old[0]}"; then
    echo "$service is up to date."
    return
  fi

  local peer
  peer="$(docker compose ps -q "$other")"
  if (( ${#old[@]} > 0 )) && [[ -n "$peer" ]] && rollout_accepts_connections "$peer" "$LIVEKIT_NODE_PORT"; then
    # docker stop sends SIGTERM, which drains the node, and kills it only
    # after the timeout. New rooms go to the other node meanwhile.
    echo "Draining $service for up to ${LIVEKIT_DRAIN_TIMEOUT}s; $other takes new rooms."
    docker stop -t "$LIVEKIT_DRAIN_TIMEOUT" "${old[@]}" >/dev/null
  fi

  docker compose up -d --no-deps "$service"
  mapfile -t new < <(docker compose ps -q "$service")
  rollout_wait_ready "$service" "${new[0]}" "$LIVEKIT_NODE_PORT"
}

# Deploy compose services, rolling the user-facing ones and recreating the rest.
rollout_deploy() {
  local -a rolled=() recreated=() livekit_nodes=()
  local service two_livekit_nodes=false

  if livekit_b_enabled; then two_livekit_nodes=true; fi

  for service in "$@"; do
    if [[ -n "${ROLLOUT_PORTS[$service]:-}" ]]; then
      rolled+=("$service")
    elif [[ "$two_livekit_nodes" == true && ( "$service" == livekit || "$service" == livekit-b ) ]]; then
      # Both nodes run the same image, so updating LiveKit updates both.
      livekit_nodes=(livekit livekit-b)
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

  for service in "${livekit_nodes[@]}"; do
    rollout_livekit_node "$service"
  done
}
