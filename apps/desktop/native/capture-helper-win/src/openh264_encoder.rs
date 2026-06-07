use openh264::encoder::{Encoder, EncoderConfig, UsageType};
use openh264::formats::YUVBuffer;
use openh264::OpenH264API;

pub struct OpenH264Encoder {
    encoder: Encoder,
    width: u32,
    height: u32,
}

impl OpenH264Encoder {
    pub fn new(width: u32, height: u32, bitrate: u32) -> Result<Self, String> {
        let width_even = width - (width % 2);
        let height_even = height - (height % 2);

        let config = EncoderConfig::new()
            .set_bitrate_bps(bitrate)
            .max_frame_rate(60.0)
            .enable_skip_frame(false)
            .usage_type(UsageType::CameraVideoRealTime);

        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|error| error.to_string())?;

        Ok(Self {
            encoder,
            width: width_even,
            height: height_even,
        })
    }

    pub fn encode_bgra(&mut self, bgra: &[u8], stride: usize) -> Result<Vec<u8>, String> {
        let yuv = bgra_to_yuv_buffer(bgra, stride, self.width as usize, self.height as usize);
        let bitstream = self
            .encoder
            .encode(&yuv)
            .map_err(|error| error.to_string())?;
        Ok(bitstream.to_vec())
    }
}

fn bgra_to_yuv_buffer(bgra: &[u8], stride: usize, width: usize, height: usize) -> YUVBuffer {
    let mut y = vec![0u8; width * height];
    let mut u = vec![0u8; (width / 2) * (height / 2)];
    let mut v = vec![0u8; (width / 2) * (height / 2)];

    for row in 0..height {
        for col in 0..width {
            let offset = row * stride + col * 4;
            let b = bgra[offset] as i32;
            let g = bgra[offset + 1] as i32;
            let r = bgra[offset + 2] as i32;

            let y_val = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y[row * width + col] = y_val.clamp(0, 255) as u8;

            if row % 2 == 0 && col % 2 == 0 {
                let u_val = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                let v_val = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                let uv_index = (row / 2) * (width / 2) + (col / 2);
                u[uv_index] = u_val.clamp(0, 255) as u8;
                v[uv_index] = v_val.clamp(0, 255) as u8;
            }
        }
    }

    let mut packed = Vec::with_capacity((width * height * 3) / 2);
    packed.extend_from_slice(&y);
    packed.extend_from_slice(&u);
    packed.extend_from_slice(&v);
    YUVBuffer::from_vec(packed, width, height)
}
