use ndarray::Array2;

use df::tract::{DfParams, DfTract, RuntimeParams};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseSuppressionMode {
    Disabled,
    Browser,
    Enhanced,
}

impl NoiseSuppressionMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "disabled" => Some(Self::Disabled),
            "browser" => Some(Self::Browser),
            "enhanced" => Some(Self::Enhanced),
            _ => None,
        }
    }
}

pub struct MicDenoiser {
    mode: NoiseSuppressionMode,
    tract: Option<DfTract>,
    hop_size: usize,
}

impl MicDenoiser {
    pub fn new(mode: NoiseSuppressionMode) -> Self {
        let mut denoiser = Self {
            mode,
            tract: None,
            hop_size: 480,
        };
        denoiser.ensure_tract();
        denoiser
    }

    pub fn mode(&self) -> NoiseSuppressionMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: NoiseSuppressionMode) {
        if self.mode == mode {
            return;
        }
        self.mode = mode;
        if mode == NoiseSuppressionMode::Enhanced {
            self.ensure_tract();
        } else {
            self.tract = None;
        }
    }

    pub fn process_i16(&mut self, samples: &mut [i16]) {
        if self.mode != NoiseSuppressionMode::Enhanced {
            return;
        }

        let Some(tract) = self.tract.as_mut() else {
            return;
        };

        if samples.len() != self.hop_size {
            return;
        }

        let mut frame = Array2::<f32>::zeros((1, self.hop_size));
        for (dst, src) in frame.iter_mut().zip(samples.iter()) {
            *dst = (*src as f32) / i16::MAX as f32;
        }

        let mut enhanced = Array2::<f32>::zeros((1, self.hop_size));
        let noisy = frame.view();
        let mut out = enhanced.view_mut();
        if tract.process(noisy, out).is_err() {
            return;
        }

        for (dst, src) in samples.iter_mut().zip(enhanced.iter()) {
            let scaled = (src.clamp(-1.0, 1.0) * i16::MAX as f32).round();
            *dst = scaled as i16;
        }
    }

    fn ensure_tract(&mut self) {
        if self.mode != NoiseSuppressionMode::Enhanced || self.tract.is_some() {
            return;
        }

        let params = RuntimeParams::default_with_ch(1);
        match DfTract::new(DfParams::default(), &params) {
            Ok(tract) => {
                self.hop_size = tract.hop_size;
                self.tract = Some(tract);
            }
            Err(error) => {
                log::warn!("failed to initialize DeepFilterNet: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_noise_suppression_modes() {
        assert_eq!(
            NoiseSuppressionMode::parse("enhanced"),
            Some(NoiseSuppressionMode::Enhanced)
        );
        assert_eq!(NoiseSuppressionMode::parse("unknown"), None);
    }

    #[test]
    fn passthrough_when_not_enhanced() {
        let mut denoiser = MicDenoiser::new(NoiseSuppressionMode::Disabled);
        let mut samples = vec![100_i16; 480];
        denoiser.process_i16(&mut samples);
        assert_eq!(samples[0], 100);
    }
}
