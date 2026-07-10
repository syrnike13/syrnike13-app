use once_cell::sync::Lazy;
use rocket::http::Status;
use rocket::response::status::BadRequest;
use rocket::serde::json::Json;
use rocket_prometheus::prometheus::{HistogramOpts, HistogramVec, IntCounterVec, Opts, Registry};
use serde::Deserialize;

const MAX_BATCH_METRICS: usize = 100;
const MAX_METRIC_COUNT: u32 = 1_000;
const MAX_BATCH_SAMPLES: u32 = 1_000;
const MAX_DURATION_MS: f64 = 60_000.0;

static NATIVE_EVENTS: Lazy<IntCounterVec> = Lazy::new(|| {
    IntCounterVec::new(
        Opts::new(
            "desktop_native_events_total",
            "Allowlisted anonymous Windows native runtime lifecycle events",
        ),
        &["event", "runtime", "session_kind", "release_channel"],
    )
    .expect("desktop native event metric must be valid")
});

static NATIVE_OPERATION_DURATION: Lazy<HistogramVec> = Lazy::new(|| {
    HistogramVec::new(
        HistogramOpts::new(
            "desktop_native_operation_duration_seconds",
            "Allowlisted anonymous Windows native runtime operation durations",
        )
        .buckets(vec![
            0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 60.0,
        ]),
        &["operation", "runtime", "session_kind", "release_channel"],
    )
    .expect("desktop native duration metric must be valid")
});

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NativeRuntime {
    Media,
    Hooks,
}

impl NativeRuntime {
    const fn label(self) -> &'static str {
        match self {
            Self::Media => "media",
            Self::Hooks => "hooks",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NativeSessionKind {
    None,
    Microphone,
    Screen,
}

impl NativeSessionKind {
    const fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Microphone => "microphone",
            Self::Screen => "screen",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum NativeCounterName {
    RuntimeStarted,
    RuntimeReady,
    RuntimeLost,
    RuntimeDegraded,
    SessionStartSucceeded,
    SessionStartFailed,
    SessionStartCancelled,
}

impl NativeCounterName {
    const fn label(self) -> &'static str {
        match self {
            Self::RuntimeStarted => "runtime_started",
            Self::RuntimeReady => "runtime_ready",
            Self::RuntimeLost => "runtime_lost",
            Self::RuntimeDegraded => "runtime_degraded",
            Self::SessionStartSucceeded => "session_start_succeeded",
            Self::SessionStartFailed => "session_start_failed",
            Self::SessionStartCancelled => "session_start_cancelled",
        }
    }

    const fn is_session(self) -> bool {
        matches!(
            self,
            Self::SessionStartSucceeded | Self::SessionStartFailed | Self::SessionStartCancelled
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum NativeHistogramName {
    RuntimeHandshakeMs,
    SessionStartMs,
}

impl NativeHistogramName {
    const fn label(self) -> &'static str {
        match self {
            Self::RuntimeHandshakeMs => "runtime_handshake",
            Self::SessionStartMs => "session_start",
        }
    }

    const fn is_session(self) -> bool {
        matches!(self, Self::SessionStartMs)
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AnonymousNativeMetric {
    Counter {
        name: NativeCounterName,
        runtime: NativeRuntime,
        #[serde(rename = "sessionKind")]
        session_kind: NativeSessionKind,
        value: u32,
    },
    Histogram {
        name: NativeHistogramName,
        runtime: NativeRuntime,
        #[serde(rename = "sessionKind")]
        session_kind: NativeSessionKind,
        #[serde(rename = "valueMs")]
        value_ms: f64,
        count: u32,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnonymousNativeMetricBatch {
    version: u8,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "releaseChannel")]
    release_channel: ReleaseChannel,
    metrics: Vec<AnonymousNativeMetric>,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ReleaseChannel {
    Stable,
    Nightly,
}

impl ReleaseChannel {
    const fn label(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }
}

pub fn register_metrics(registry: &Registry) -> Result<(), String> {
    registry
        .register(Box::new(NATIVE_EVENTS.clone()))
        .map_err(|error| error.to_string())?;
    registry
        .register(Box::new(NATIVE_OPERATION_DURATION.clone()))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Accept a bounded batch of anonymous, allowlisted native runtime SLO metrics.
#[openapi(tag = "Core")]
#[post("/native", format = "json", data = "<batch>")]
pub fn ingest_native_metrics(
    batch: Json<AnonymousNativeMetricBatch>,
) -> Result<Status, BadRequest<&'static str>> {
    validate_batch(&batch)?;
    let release_channel = batch.release_channel.label();

    for metric in &batch.metrics {
        match *metric {
            AnonymousNativeMetric::Counter {
                name,
                runtime,
                session_kind,
                value,
            } => {
                NATIVE_EVENTS
                    .with_label_values(&[
                        name.label(),
                        runtime.label(),
                        session_kind.label(),
                        release_channel,
                    ])
                    .inc_by(u64::from(value));
            }
            AnonymousNativeMetric::Histogram {
                name,
                runtime,
                session_kind,
                value_ms,
                count,
            } => {
                let histogram = NATIVE_OPERATION_DURATION.with_label_values(&[
                    name.label(),
                    runtime.label(),
                    session_kind.label(),
                    release_channel,
                ]);
                for _ in 0..count {
                    histogram.observe(value_ms / 1_000.0);
                }
            }
        }
    }

    Ok(Status::NoContent)
}

fn validate_batch(batch: &AnonymousNativeMetricBatch) -> Result<(), BadRequest<&'static str>> {
    if batch.version != 1 {
        return Err(BadRequest("unsupported native metrics version"));
    }
    if !valid_app_version(&batch.app_version) {
        return Err(BadRequest("invalid app version"));
    }
    if batch.metrics.is_empty() || batch.metrics.len() > MAX_BATCH_METRICS {
        return Err(BadRequest("invalid native metrics batch size"));
    }

    let mut batch_samples = 0_u32;
    for metric in &batch.metrics {
        match *metric {
            AnonymousNativeMetric::Counter {
                name,
                runtime,
                session_kind,
                value,
            } => {
                if value == 0 || value > MAX_METRIC_COUNT {
                    return Err(BadRequest("invalid native counter value"));
                }
                batch_samples = batch_samples.saturating_add(value);
                validate_scope(name.is_session(), runtime, session_kind)?;
            }
            AnonymousNativeMetric::Histogram {
                name,
                runtime,
                session_kind,
                value_ms,
                count,
            } => {
                if !value_ms.is_finite()
                    || !(0.0..=MAX_DURATION_MS).contains(&value_ms)
                    || count == 0
                    || count > MAX_METRIC_COUNT
                {
                    return Err(BadRequest("invalid native histogram value"));
                }
                batch_samples = batch_samples.saturating_add(count);
                validate_scope(name.is_session(), runtime, session_kind)?;
            }
        }
    }
    if batch_samples > MAX_BATCH_SAMPLES {
        return Err(BadRequest("native metrics batch has too many samples"));
    }
    Ok(())
}

fn validate_scope(
    session_metric: bool,
    runtime: NativeRuntime,
    session_kind: NativeSessionKind,
) -> Result<(), BadRequest<&'static str>> {
    if session_metric {
        if runtime != NativeRuntime::Media || session_kind == NativeSessionKind::None {
            return Err(BadRequest("invalid native session metric scope"));
        }
    } else if session_kind != NativeSessionKind::None {
        return Err(BadRequest("invalid native runtime metric scope"));
    }
    Ok(())
}

fn valid_app_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

pub fn routes() -> (Vec<rocket::Route>, revolt_okapi::openapi3::OpenApi) {
    openapi_get_routes_spec![ingest_native_metrics]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(metric: AnonymousNativeMetric) -> AnonymousNativeMetricBatch {
        AnonymousNativeMetricBatch {
            version: 1,
            app_version: "0.5.1".to_owned(),
            release_channel: ReleaseChannel::Nightly,
            metrics: vec![metric],
        }
    }

    #[test]
    fn accepts_allowlisted_session_metrics() {
        let value = batch(AnonymousNativeMetric::Counter {
            name: NativeCounterName::SessionStartSucceeded,
            runtime: NativeRuntime::Media,
            session_kind: NativeSessionKind::Microphone,
            value: 3,
        });
        assert!(validate_batch(&value).is_ok());
    }

    #[test]
    fn rejects_session_labels_on_runtime_metrics() {
        let value = batch(AnonymousNativeMetric::Counter {
            name: NativeCounterName::RuntimeLost,
            runtime: NativeRuntime::Media,
            session_kind: NativeSessionKind::Screen,
            value: 1,
        });
        assert!(validate_batch(&value).is_err());
    }

    #[test]
    fn rejects_unbounded_histogram_counts() {
        let value = batch(AnonymousNativeMetric::Histogram {
            name: NativeHistogramName::RuntimeHandshakeMs,
            runtime: NativeRuntime::Hooks,
            session_kind: NativeSessionKind::None,
            value_ms: 10.0,
            count: MAX_METRIC_COUNT + 1,
        });
        assert!(validate_batch(&value).is_err());
    }

    #[test]
    fn rejects_unknown_privacy_sensitive_fields() {
        let value = serde_json::json!({
            "version": 1,
            "appVersion": "0.5.1",
            "releaseChannel": "nightly",
            "metrics": [{
                "type": "counter",
                "name": "runtime_lost",
                "runtime": "media",
                "sessionKind": "none",
                "value": 1,
                "roomUrl": "wss://private.example",
            }],
            "userId": "private-user",
        });

        assert!(serde_json::from_value::<AnonymousNativeMetricBatch>(value).is_err());
    }
}
