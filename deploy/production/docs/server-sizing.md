# Server Sizing

Target: around 20 simultaneously online users.

Recommended starting server:

- 4 vCPU
- 8 GB RAM
- 80-120 GB NVMe SSD
- 1 Gbit/s port
- Ubuntu 24.04 LTS

Minimum viable server:

- 2 vCPU
- 4 GB RAM
- 50 GB SSD

The minimum is acceptable for text chat, small file uploads, and light testing. Use the recommended size if voice/video will be enabled or if the instance should feel stable under real community usage.

## Why

The stack runs several services on one host:

- MongoDB
- KeyDB/Redis
- RabbitMQ
- MinIO
- Caddy
- API
- events
- file-server
- proxy
- gifbox
- crond
- pushd
- voice-ingress
- LiveKit
- web

Voice and screen sharing are the main reason to avoid a very small VPS. LiveKit needs CPU headroom, stable network, and open RTC ports.

## Ports

Open:

- `80/tcp`
- `443/tcp`
- `7881/tcp`
- `50000-50100/udp`

Keep MongoDB, KeyDB/Redis, RabbitMQ, and MinIO private to Docker unless there is a specific operational reason to expose them.

## Storage

Start with 80-120 GB if users will upload files. Back up at least:

- `data/db`
- `data/minio`
- `data/rabbit`
- `secrets.env`
- `Syrnike.toml`
- `livekit.yml`

Losing `secrets.env` can make existing uploaded files inaccessible.
