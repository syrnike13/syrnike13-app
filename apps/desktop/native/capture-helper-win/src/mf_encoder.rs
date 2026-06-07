use std::mem::ManuallyDrop;
use std::ptr::null_mut;

use windows::core::GUID;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaType, IMFSample, IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFMediaType_Video, MFMediaType_Video as MF_MT_VIDEO, MFVideoFormat_H264,
    MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT,
    MFT_REGISTER_TYPE_INFO, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE,
    MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};

pub struct MfH264Encoder {
    transform: IMFTransform,
    width: u32,
    height: u32,
    nv12: Vec<u8>,
    com_initialized: bool,
}

impl MfH264Encoder {
    pub fn try_new(width: u32, height: u32, bitrate: u32) -> Result<Self, String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            windows::Win32::Media::MediaFoundation::MFStartup(
                windows::Win32::Media::MediaFoundation::MF_VERSION,
                MFSTARTUP_FULL,
            )
            .map_err(|error| error.to_string())?;

            let transform = create_h264_encoder()?;
            configure_encoder(&transform, width, height, bitrate)?;

            let width_even = width - (width % 2);
            let height_even = height - (height % 2);
            let nv12_len = (width_even * height_even * 3 / 2) as usize;
            Ok(Self {
                transform,
                width: width_even,
                height: height_even,
                nv12: vec![0u8; nv12_len],
                com_initialized,
            })
        }
    }

    pub fn encode_bgra(&mut self, bgra: &[u8], stride: usize) -> Result<Vec<u8>, String> {
        bgra_to_nv12(
            bgra,
            stride,
            self.width as usize,
            self.height as usize,
            &mut self.nv12,
        );

        unsafe {
            let sample = create_nv12_sample(&self.nv12)?;
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|error| error.to_string())?;

            loop {
                let mut status = 0u32;
                let output_buffer =
                    windows::Win32::Media::MediaFoundation::MFT_OUTPUT_DATA_BUFFER {
                        dwStreamID: 0,
                        pSample: ManuallyDrop::new(None),
                        dwStatus: 0,
                        pEvents: ManuallyDrop::new(None),
                    };
                let mut buffers = [output_buffer];
                match self.transform.ProcessOutput(0, &mut buffers, &mut status) {
                    Ok(()) => {
                        let output_sample = buffers[0]
                            .pSample
                            .take()
                            .ok_or_else(|| "mf encoder missing output sample".to_string())?;
                        return sample_to_annex_b(&output_sample);
                    }
                    Err(error) if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => {
                        return Ok(Vec::new());
                    }
                    Err(error) if error.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                        return Err("mf encoder stream changed".to_string());
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
    }
}

impl Drop for MfH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Media::MediaFoundation::MFShutdown();
            if self.com_initialized {
                CoUninitialize();
            }
        }
    }
}

unsafe fn create_h264_encoder() -> Result<IMFTransform, String> {
    let input_type = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MF_MT_VIDEO,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output_type = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MF_MT_VIDEO,
        guidSubtype: MFVideoFormat_H264,
    };

    let mut activates: *mut Option<IMFActivate> = null_mut();
    let mut count = 0u32;

    windows::Win32::Media::MediaFoundation::MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER,
        Some(&input_type),
        Some(&output_type),
        &mut activates,
        &mut count,
    )
    .map_err(|error| error.to_string())?;

    if count > 0 && !activates.is_null() {
        if let Some(activate) = (*activates.add(0)).clone() {
            CoTaskMemFree(Some(activates as *const _));
            return activate
                .ActivateObject::<IMFTransform>()
                .map_err(|error| error.to_string());
        }
    }

    CoTaskMemFree(Some(activates as *const _));
    create_software_h264_encoder()
}

unsafe fn create_software_h264_encoder() -> Result<IMFTransform, String> {
    let mut activates: *mut Option<IMFActivate> = null_mut();
    let mut count = 0u32;

    windows::Win32::Media::MediaFoundation::MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_SYNCMFT,
        None,
        None,
        &mut activates,
        &mut count,
    )
    .map_err(|error| error.to_string())?;

    if count == 0 || activates.is_null() {
        CoTaskMemFree(Some(activates as *const _));
        return Err("no mf h264 encoder found".to_string());
    }

    for index in 0..count as usize {
        if let Some(activate) = (*activates.add(index)).clone() {
            if let Ok(transform) = activate.ActivateObject::<IMFTransform>() {
                CoTaskMemFree(Some(activates as *const _));
                return Ok(transform);
            }
        }
    }

    CoTaskMemFree(Some(activates as *const _));
    Err("failed to activate mf h264 encoder".to_string())
}

unsafe fn configure_encoder(
    transform: &IMFTransform,
    width: u32,
    height: u32,
    bitrate: u32,
) -> Result<(), String> {
    let width_even = width - (width % 2);
    let height_even = height - (height % 2);

    let input_type = MFCreateMediaType().map_err(|error| error.to_string())?;
    input_type
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|error| error.to_string())?;
    input_type
        .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
        .map_err(|error| error.to_string())?;
    set_frame_size(&input_type, width_even, height_even)?;
    input_type
        .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        .map_err(|error| error.to_string())?;
    transform
        .SetInputType(0, &input_type, 0)
        .map_err(|error| error.to_string())?;

    let output_type = MFCreateMediaType().map_err(|error| error.to_string())?;
    output_type
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .map_err(|error| error.to_string())?;
    output_type
        .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
        .map_err(|error| error.to_string())?;
    set_frame_size(&output_type, width_even, height_even)?;
    output_type
        .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        .map_err(|error| error.to_string())?;
    output_type
        .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
        .map_err(|error| error.to_string())?;
    transform
        .SetOutputType(0, &output_type, 0)
        .map_err(|error| error.to_string())?;

    transform
        .ProcessMessage(
            windows::Win32::Media::MediaFoundation::MFT_MESSAGE_COMMAND_FLUSH,
            0,
        )
        .map_err(|error| error.to_string())?;
    transform
        .ProcessMessage(
            windows::Win32::Media::MediaFoundation::MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
            0,
        )
        .map_err(|error| error.to_string())?;
    transform
        .ProcessMessage(
            windows::Win32::Media::MediaFoundation::MFT_MESSAGE_NOTIFY_START_OF_STREAM,
            0,
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

unsafe fn set_frame_size(media_type: &IMFMediaType, width: u32, height: u32) -> Result<(), String> {
    let packed = ((width as u64) << 32) | height as u64;
    media_type
        .SetUINT64(&MF_MT_FRAME_SIZE, packed)
        .map_err(|error| error.to_string())?;
    media_type
        .SetUINT64(&MF_MT_FRAME_RATE, (60u64 << 32) | 1)
        .map_err(|error| error.to_string())?;
    Ok(())
}

unsafe fn create_nv12_sample(nv12: &[u8]) -> Result<IMFSample, String> {
    let buffer = MFCreateMemoryBuffer(nv12.len() as u32).map_err(|error| error.to_string())?;
    let mut dest = null_mut();
    buffer
        .Lock(&mut dest, None, None)
        .map_err(|error| error.to_string())?;
    std::ptr::copy_nonoverlapping(nv12.as_ptr(), dest, nv12.len());
    buffer.Unlock().map_err(|error| error.to_string())?;
    buffer
        .SetCurrentLength(nv12.len() as u32)
        .map_err(|error| error.to_string())?;

    let sample = MFCreateSample().map_err(|error| error.to_string())?;
    sample
        .AddBuffer(&buffer)
        .map_err(|error| error.to_string())?;
    Ok(sample)
}

unsafe fn sample_to_annex_b(sample: &IMFSample) -> Result<Vec<u8>, String> {
    let buffer = sample
        .ConvertToContiguousBuffer()
        .map_err(|error| error.to_string())?;

    let mut data = null_mut();
    let mut length = 0u32;
    buffer
        .Lock(&mut data, None, Some(&mut length))
        .map_err(|error| error.to_string())?;
    let slice = std::slice::from_raw_parts(data, length as usize);
    let annex_b = avcc_sample_to_annex_b(slice);
    buffer.Unlock().map_err(|error| error.to_string())?;
    Ok(annex_b)
}

fn avcc_sample_to_annex_b(avcc: &[u8]) -> Vec<u8> {
    let mut annex_b = Vec::with_capacity(avcc.len() + 16);
    let mut offset = 0usize;

    while offset + 4 <= avcc.len() {
        let length = u32::from_be_bytes([
            avcc[offset],
            avcc[offset + 1],
            avcc[offset + 2],
            avcc[offset + 3],
        ]) as usize;
        offset += 4;
        if length == 0 || offset + length > avcc.len() {
            break;
        }
        annex_b.extend_from_slice(&[0, 0, 0, 1]);
        annex_b.extend_from_slice(&avcc[offset..offset + length]);
        offset += length;
    }

    if annex_b.is_empty() && !avcc.is_empty() {
        annex_b.extend_from_slice(&[0, 0, 0, 1]);
        annex_b.extend_from_slice(avcc);
    }

    annex_b
}

fn bgra_to_nv12(bgra: &[u8], stride: usize, width: usize, height: usize, nv12: &mut [u8]) {
    let y_plane = width * height;
    let uv_plane = y_plane / 4;

    for row in 0..height {
        for col in 0..width {
            let offset = row * stride + col * 4;
            let b = bgra[offset] as i32;
            let g = bgra[offset + 1] as i32;
            let r = bgra[offset + 2] as i32;
            let y_val = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            nv12[row * width + col] = y_val.clamp(0, 255) as u8;
        }
    }

    let uv_offset = y_plane;
    for row in (0..height).step_by(2) {
        for col in (0..width).step_by(2) {
            let mut u_sum = 0i32;
            let mut v_sum = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let y = (row + dy).min(height - 1);
                    let x = (col + dx).min(width - 1);
                    let offset = y * stride + x * 4;
                    let b = bgra[offset] as i32;
                    let g = bgra[offset + 1] as i32;
                    let r = bgra[offset + 2] as i32;
                    u_sum += ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    v_sum += ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                }
            }
            let uv_index = uv_offset + (row / 2) * (width / 2) + (col / 2);
            nv12[uv_index] = (u_sum / 4).clamp(0, 255) as u8;
            nv12[uv_index + uv_plane] = (v_sum / 4).clamp(0, 255) as u8;
        }
    }
}

#[allow(dead_code)]
const CLSID_MSH264EncoderMFT: GUID = GUID::from_u128(0x6ca50344_051b_4d26_9776_61c288348992);
