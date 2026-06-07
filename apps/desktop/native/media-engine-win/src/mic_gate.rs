use std::time::{Duration, Instant};

const SAMPLE_INTERVAL_MS: u64 = 50;
const OPEN_HOLD_MS: u64 = 60;
const CLOSE_HOLD_MS: u64 = 220;

fn normalize_threshold(value: f32) -> f64 {
    if !value.is_finite() {
        return 0.04;
    }
    f64::from(value.clamp(0.0, 1.0))
}

fn rms_level_i16(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }

    let mut sum = 0.0f64;
    for sample in samples {
        let centered = f64::from(*sample) / 32768.0;
        sum += centered * centered;
    }
    (sum / samples.len() as f64).sqrt()
}

fn should_open(level: f64, threshold: f64) -> bool {
    level >= threshold
}

pub struct MicVoiceGate {
    enabled: bool,
    threshold: f64,
    open: bool,
    last_gate_change_at: Instant,
    last_sample_at: Instant,
}

impl MicVoiceGate {
    pub fn new(threshold: f32) -> Self {
        let now = Instant::now();
        Self {
            enabled: false,
            threshold: normalize_threshold(threshold),
            open: true,
            last_gate_change_at: now,
            last_sample_at: now,
        }
    }

    pub fn set_config(&mut self, enabled: bool, threshold: f32) {
        self.enabled = enabled;
        self.threshold = normalize_threshold(threshold);
        if !enabled {
            self.open = true;
        }
    }

    pub fn process_i16(&mut self, samples: &mut [i16]) {
        if !self.enabled {
            return;
        }

        let now = Instant::now();
        if now.duration_since(self.last_sample_at) >= Duration::from_millis(SAMPLE_INTERVAL_MS) {
            let level = rms_level_i16(samples);
            self.tick(level, now);
            self.last_sample_at = now;
        }

        if !self.open {
            samples.fill(0);
        }
    }

    fn tick(&mut self, level: f64, now: Instant) {
        let should_open = should_open(level, self.threshold);
        let hold_ms = if should_open {
            OPEN_HOLD_MS
        } else {
            CLOSE_HOLD_MS
        };

        if should_open == self.open {
            self.last_gate_change_at = now;
            return;
        }

        if now.duration_since(self.last_gate_change_at) < Duration::from_millis(hold_ms) {
            return;
        }

        self.open = should_open;
        self.last_gate_change_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_mutes_when_closed() {
        let mut gate = MicVoiceGate::new(0.9);
        gate.set_config(true, 0.9);
        gate.open = false;
        let mut samples = vec![1000_i16; 480];
        gate.process_i16(&mut samples);
        assert_eq!(samples[0], 0);
    }

    #[test]
    fn gate_passthrough_when_disabled() {
        let mut gate = MicVoiceGate::new(0.04);
        gate.open = false;
        let mut samples = vec![1000_i16; 480];
        gate.process_i16(&mut samples);
        assert_eq!(samples[0], 1000);
    }
}
