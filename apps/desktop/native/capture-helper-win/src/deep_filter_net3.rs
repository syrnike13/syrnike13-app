use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::Array2;

pub enum MicrophoneDenoise {
    Disabled,
    DeepFilterNet3(DeepFilterNet3Processor),
}

impl MicrophoneDenoise {
    pub fn new(mode: &str) -> Result<Self, String> {
        if mode != "deep_filter_net3" {
            return Ok(Self::Disabled);
        }

        DeepFilterNet3Processor::new().map(Self::DeepFilterNet3)
    }

    pub fn mode_name(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::DeepFilterNet3(_) => "deep_filter_net3",
        }
    }

    pub fn sample_rate(&self) -> usize {
        match self {
            Self::Disabled => 48_000,
            Self::DeepFilterNet3(processor) => processor.sample_rate(),
        }
    }

    pub fn hop_size(&self) -> usize {
        match self {
            Self::Disabled => 960,
            Self::DeepFilterNet3(processor) => processor.hop_size(),
        }
    }

    pub fn process_f32le_mono(&mut self, chunk: &mut [u8]) -> Result<(), String> {
        match self {
            Self::Disabled => Ok(()),
            Self::DeepFilterNet3(processor) => processor.process_f32le_mono(chunk),
        }
    }
}

pub struct DeepFilterNet3Processor {
    model: DfTract,
    frame: Vec<f32>,
    enhanced: Vec<f32>,
}

impl DeepFilterNet3Processor {
    fn new() -> Result<Self, String> {
        let runtime_params = RuntimeParams {
            n_ch: 1,
            ..RuntimeParams::default()
        };
        let model = DfTract::new(DfParams::default(), &runtime_params)
            .map_err(|error| format!("failed to initialize DeepFilterNet3: {error}"))?;
        let hop_size = model.hop_size;

        Ok(Self {
            model,
            frame: vec![0.0; hop_size],
            enhanced: vec![0.0; hop_size],
        })
    }

    fn process_f32le_mono(&mut self, chunk: &mut [u8]) -> Result<(), String> {
        let frame_bytes = self.model.hop_size * 4;
        for frame_bytes_slice in chunk.chunks_exact_mut(frame_bytes) {
            for (sample_bytes, sample) in
                frame_bytes_slice.chunks_exact(4).zip(self.frame.iter_mut())
            {
                *sample = f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ]);
            }

            let noisy = Array2::from_shape_vec((1, self.model.hop_size), self.frame.clone())
                .map_err(|error| error.to_string())?;
            let mut enhanced = Array2::zeros((1, self.model.hop_size));
            self.model
                .process(noisy.view(), enhanced.view_mut())
                .map_err(|error| format!("DeepFilterNet3 processing failed: {error}"))?;

            self.enhanced.copy_from_slice(
                enhanced
                    .as_slice()
                    .ok_or_else(|| "DeepFilterNet3 output is not contiguous".to_string())?,
            );

            for (sample, sample_bytes) in self
                .enhanced
                .iter()
                .zip(frame_bytes_slice.chunks_exact_mut(4))
            {
                sample_bytes.copy_from_slice(&sample.to_le_bytes());
            }
        }

        Ok(())
    }

    fn sample_rate(&self) -> usize {
        self.model.sr
    }

    fn hop_size(&self) -> usize {
        self.model.hop_size
    }
}

#[cfg(test)]
mod tests {
    use super::MicrophoneDenoise;

    #[test]
    fn disabled_denoise_leaves_pcm_unchanged() {
        let mut denoise = MicrophoneDenoise::new("disabled").expect("denoise");
        let mut chunk = [0u8; 8];
        chunk[0..4].copy_from_slice(&0.25f32.to_le_bytes());
        chunk[4..8].copy_from_slice(&(-0.5f32).to_le_bytes());
        let original = chunk;

        denoise
            .process_f32le_mono(&mut chunk)
            .expect("process disabled");

        assert_eq!(chunk, original);
        assert_eq!(denoise.mode_name(), "disabled");
        assert_eq!(denoise.sample_rate(), 48_000);
        assert_eq!(denoise.hop_size(), 960);
    }
}
