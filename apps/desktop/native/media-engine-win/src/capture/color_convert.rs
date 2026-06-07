use livekit::webrtc::video_frame::I420Buffer;

pub fn bgra_to_i420(
    bgra: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Result<I420Buffer, String> {
    if width == 0 || height == 0 {
        return Err("invalid frame dimensions".into());
    }

    let mut buffer = I420Buffer::new(width as u32, height as u32);
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (data_y, data_u, data_v) = buffer.data_mut();
    let chroma_height = (height + 1) / 2;

    for row in 0..height {
        for col in 0..width {
            let offset = row * stride + col * 4;
            let Some(pixel) = bgra.get(offset..offset + 4) else {
                return Err("bgra buffer is shorter than stride * height".into());
            };

            let b = pixel[0] as f32;
            let g = pixel[1] as f32;
            let r = pixel[2] as f32;

            let y = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).round().clamp(0.0, 255.0) as u8;
            let y_index = row * stride_y as usize + col;
            if y_index >= data_y.len() {
                return Err("y plane overflow".into());
            }
            data_y[y_index] = y;

            if row % 2 == 0 && col % 2 == 0 {
                let u = (-0.148 * r - 0.291 * g + 0.439 * b + 128.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                let v = (0.439 * r - 0.368 * g - 0.071 * b + 128.0)
                    .round()
                    .clamp(0.0, 255.0) as u8;
                let uv_row = row / 2;
                let uv_col = col / 2;
                let u_index = uv_row * stride_u as usize + uv_col;
                let v_index = uv_row * stride_v as usize + uv_col;
                if u_index >= data_u.len() || v_index >= data_v.len() {
                    return Err("uv plane overflow".into());
                }
                data_u[u_index] = u;
                data_v[v_index] = v;
            }
        }
    }

    let _ = chroma_height;
    Ok(buffer)
}
