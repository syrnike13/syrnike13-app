# Known external bugs

This file records reproducible bugs and constraints in the local environment, toolchain, operating system, or third-party libraries that the application repository cannot fix. Application defects do not belong here.

## Docker Desktop fails to restart on Windows build 26200

### Symptoms

- Docker Desktop opens and immediately reports an unexpected backend error.
- `docker version` cannot connect to `npipe:////./pipe/dockerDesktopLinuxEngine` because the pipe does not exist.
- The current `com.docker.backend.exe.log` reports error 1920, `The file cannot be accessed by the system`, while removing one of these AF_UNIX sockets:
  - `%LOCALAPPDATA%\Docker\run\sailor-ingest.sock`
  - `%LOCALAPPDATA%\Docker\run\dockerInference`
  - `%LOCALAPPDATA%\docker-secrets-engine\engine.sock`
- The socket appears as a zero-byte NTFS `ReparsePoint`; reading its ACL, deleting it, or querying it with `fsutil` can also fail with error 1920.

### Known affected setup

- Windows `10.0.26200.7309`
- Docker Desktop `4.88.1.237512`
- Docker Engine `29.7.2`
- WSL `2.7.12.0`, kernel `6.18.33.2-2`

This is a Docker Desktop/Windows AF_UNIX socket bug, not a missing virtualization feature. On the affected machine, firmware virtualization, the Windows hypervisor, and the Windows Hypervisor Platform API were verified as operational.

Docker tracks the same failure in [docker/desktop-feedback#531](https://github.com/docker/desktop-feedback/issues/531) and [docker/desktop-feedback#554](https://github.com/docker/desktop-feedback/issues/554).

### Recovery

1. Fully stop every Docker Desktop process before touching the socket directories.
2. Set `"EnableDockerAI": false` in `%APPDATA%\Docker\settings-store.json`. Docker Model Runner remains unavailable while this workaround is active.
3. Rename both parent directories in the same recovery attempt, preserving them as timestamped backups:
   - `%LOCALAPPDATA%\Docker\run`
   - `%LOCALAPPDATA%\docker-secrets-engine`
4. Start Docker Desktop and verify the server with `docker version` and `docker info`. Use `docker run --rm hello-world` when an end-to-end pull and container test is appropriate.

An unclean Docker Desktop stop can reproduce the corruption. Cleaning only one directory can create a loop: startup fails on the other socket and recreates the first broken socket, so both directories must be handled before one clean start.

### Data safety

Do not use Factory Reset and do not delete `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`; those actions are unnecessary and can destroy local images, containers, and volumes. Rename the socket parent directories instead, because the corrupted reparse points may be impossible to delete normally.
