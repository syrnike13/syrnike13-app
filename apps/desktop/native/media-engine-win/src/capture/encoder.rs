pub use crate::capture::openh264_encoder::OpenH264Encoder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderBackend {
    MediaFoundation,
    OpenH264,
}

impl EncoderBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            EncoderBackend::MediaFoundation => "media_foundation",
            EncoderBackend::OpenH264 => "openh264",
        }
    }
}

pub struct VideoEncoder {
    backend: EncoderBackend,
    mf: Option<crate::capture::mf_encoder::MfH264Encoder>,
    openh264: Option<OpenH264Encoder>,
    width: u32,
    height: u32,
}

impl VideoEncoder {
    pub fn new(width: u32, height: u32, bitrate: u32) -> Result<(Self, EncoderBackend), String> {
        if let Ok(mf) = crate::capture::mf_encoder::MfH264Encoder::try_new(width, height, bitrate) {
            return Ok((
                Self {
                    backend: EncoderBackend::MediaFoundation,
                    mf: Some(mf),
                    openh264: None,
                    width,
                    height,
                },
                EncoderBackend::MediaFoundation,
            ));
        }

        let openh264 = OpenH264Encoder::new(width, height, bitrate)?;
        Ok((
            Self {
                backend: EncoderBackend::OpenH264,
                mf: None,
                openh264: Some(openh264),
                width,
                height,
            },
            EncoderBackend::OpenH264,
        ))
    }

    pub fn backend(&self) -> EncoderBackend {
        self.backend
    }

    pub fn encode_bgra(&mut self, bgra: &[u8], stride: usize) -> Result<Vec<u8>, String> {
        match self.backend {
            EncoderBackend::MediaFoundation => {
                let encoder = self
                    .mf
                    .as_mut()
                    .ok_or_else(|| "mf encoder missing".to_string())?;
                let encoded = encoder.encode_bgra(bgra, stride)?;
                if encoded.is_empty() {
                    return Ok(Vec::new());
                }
                Ok(encoded)
            }
            EncoderBackend::OpenH264 => self
                .openh264
                .as_mut()
                .ok_or_else(|| "openh264 encoder missing".to_string())?
                .encode_bgra(bgra, stride),
        }
    }

    pub fn encode_bgra_raw(&self, bgra: &[u8], stride: usize) -> Vec<u8> {
        let width = self.width as usize;
        let height = self.height as usize;
        let mut packed = Vec::with_capacity(8 + bgra.len());
        packed.extend_from_slice(&(width as u32).to_le_bytes());
        packed.extend_from_slice(&(height as u32).to_le_bytes());
        packed.extend_from_slice(&(stride as u32).to_le_bytes());
        packed.extend_from_slice(bgra);
        let _ = (width, height);
        packed
    }
}
