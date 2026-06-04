# Build Stage
ARG BASE_IMAGE=ghcr.io/syrnike13/base:latest
FROM ${BASE_IMAGE} AS builder
FROM debian:12 AS debian

# Bundle Stage
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /home/rust/src/target/release/syrnike-autumn ./
COPY --from=mwader/static-ffmpeg:7.0.2 /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:7.0.2 /ffprobe /usr/local/bin/
COPY --from=debian /usr/bin/uname /usr/bin/uname

EXPOSE 14704
USER nonroot
CMD ["./syrnike-autumn"]
