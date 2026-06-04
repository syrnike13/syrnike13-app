# Build Stage
ARG BASE_IMAGE=ghcr.io/syrnike13/base:latest
FROM ${BASE_IMAGE} AS builder

# Bundle Stage
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /home/rust/src/target/release/syrnike-gifbox ./

EXPOSE 14706
USER nonroot
CMD ["./syrnike-gifbox"]
