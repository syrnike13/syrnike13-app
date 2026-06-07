use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgb};
use livekit::prelude::TrackSource;
use livekit::webrtc::video_frame::I420Buffer;

pub fn video_source_label(source: TrackSource) -> Option<&'static str> {
    match source {
        TrackSource::Screenshare => Some("screen"),
        TrackSource::Camera => Some("camera"),
        _ => None,
    }
}

pub fn i420_buffer_to_jpeg(buffer: &I420Buffer, quality: u8) -> Result<Vec<u8>, String> {
    let width = buffer.width() as usize;
    let height = buffer.height() as usize;
    if width == 0 || height == 0 {
        return Err("invalid frame dimensions".into());
    }

    let rgb = i420_to_rgb(buffer)?;
    let image = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_raw(width as u32, height as u32, rgb)
        .ok_or_else(|| "failed to build rgb image".to_string())?;

    let mut encoded = Vec::new();
    let mut cursor = Cursor::new(&mut encoded);
    let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder
        .encode_image(&image)
        .map_err(|error| error.to_string())?;

    Ok(encoded)
}

pub fn i420_to_rgb(buffer: &I420Buffer) -> Result<Vec<u8>, String> {
    let width = buffer.width() as usize;
    let height = buffer.height() as usize;
    if width == 0 || height == 0 {
        return Err("invalid frame dimensions".into());
    }

    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (data_y, data_u, data_v) = buffer.data();
    let mut rgb = vec![0u8; width * height * 3];

    for row in 0..height {
        for col in 0..width {
            let y_index = row * stride_y as usize + col;
            let uv_row = row / 2;
            let uv_col = col / 2;
            let u_index = uv_row * stride_u as usize + uv_col;
            let v_index = uv_row * stride_v as usize + uv_col;

            let y = data_y.get(y_index).copied().unwrap_or(16) as f32;
            let u = data_u.get(u_index).copied().unwrap_or(128) as f32 - 128.0;
            let v = data_v.get(v_index).copied().unwrap_or(128) as f32 - 128.0;

            let r = (y + 1.402 * v).round().clamp(0.0, 255.0) as u8;
            let g = (y - 0.344 * u - 0.714 * v).round().clamp(0.0, 255.0) as u8;
            let b = (y + 1.772 * u).round().clamp(0.0, 255.0) as u8;

            let offset = (row * width + col) * 3;
            rgb[offset] = r;
            rgb[offset + 1] = g;
            rgb[offset + 2] = b;
        }
    }

    Ok(rgb)
}

pub fn rgb_to_i420(rgb: &[u8], width: usize, height: usize) -> Result<I420Buffer, String> {
    if width == 0 || height == 0 {
        return Err("invalid frame dimensions".into());
    }

    let expected = width * height * 3;
    if rgb.len() < expected {
        return Err("rgb buffer is shorter than width * height * 3".into());
    }

    let mut buffer = I420Buffer::new(width as u32, height as u32);
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (data_y, data_u, data_v) = buffer.data_mut();

    for row in 0..height {
        for col in 0..width {
            let offset = (row * width + col) * 3;
            let r = rgb[offset] as f32;
            let g = rgb[offset + 1] as f32;
            let b = rgb[offset + 2] as f32;

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

    Ok(buffer)
}

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
