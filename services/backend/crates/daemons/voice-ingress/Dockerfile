# Build Stage
ARG BASE_IMAGE=ghcr.io/syrnike13/base:latest
FROM ${BASE_IMAGE} AS builder
FROM debian:12 AS debian

# Bundle Stage
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /home/rust/src/target/release/syrnike-voice-ingress ./
COPY --from=debian /usr/bin/uname /usr/bin/uname

USER nonroot
CMD ["./syrnike-voice-ingress"]
