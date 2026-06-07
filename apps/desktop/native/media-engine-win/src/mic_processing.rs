use crate::mic_denoise::{MicDenoiser, NoiseSuppressionMode};
use crate::mic_gate::MicVoiceGate;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MicProcessingConfig {
    pub voice_gate_enabled: bool,
    pub voice_gate_threshold: f32,
    pub noise_suppression: NoiseSuppressionMode,
}

impl Default for MicProcessingConfig {
    fn default() -> Self {
        Self {
            voice_gate_enabled: false,
            voice_gate_threshold: 0.04,
            noise_suppression: NoiseSuppressionMode::Browser,
        }
    }
}

pub struct MicProcessor {
    gate: MicVoiceGate,
    denoiser: MicDenoiser,
    config: MicProcessingConfig,
}

impl MicProcessor {
    pub fn new(config: MicProcessingConfig) -> Self {
        Self {
            gate: MicVoiceGate::new(config.voice_gate_threshold),
            denoiser: MicDenoiser::new(config.noise_suppression),
            config,
        }
    }

    pub fn config(&self) -> MicProcessingConfig {
        self.config
    }

    pub fn set_config(&mut self, config: MicProcessingConfig) {
        self.config = config;
        self.gate
            .set_config(config.voice_gate_enabled, config.voice_gate_threshold);
        self.denoiser.set_mode(config.noise_suppression);
    }

    pub fn process_i16(&mut self, samples: &mut [i16]) {
        if self.config.voice_gate_enabled {
            self.gate.process_i16(samples);
            return;
        }

        self.denoiser.process_i16(samples);
    }
}
