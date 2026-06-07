use nokhwa::query;
use nokhwa::utils::{ApiBackend, CameraIndex};
use serde::Serialize;
use wasapi::{initialize_mta, DeviceEnumerator, Direction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesListResult {
    pub devices: Vec<DeviceInfo>,
}

pub fn list_devices() -> Result<DevicesListResult, String> {
    let mut devices = list_audio_devices()?;
    devices.extend(list_video_devices()?);
    Ok(DevicesListResult { devices })
}

fn list_audio_devices() -> Result<Vec<DeviceInfo>, String> {
    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let mut devices = Vec::new();

    for (direction, kind) in [
        (Direction::Capture, "audioinput"),
        (Direction::Render, "audiooutput"),
    ] {
        let collection = enumerator
            .get_device_collection(&direction)
            .map_err(|error| error.to_string())?;
        let count = collection.get_count().map_err(|error| error.to_string())?;

        for index in 0..count {
            let device = collection.item(index).map_err(|error| error.to_string())?;
            let id = device.get_id().map_err(|error| error.to_string())?;
            let label = device
                .get_friendlyname()
                .unwrap_or_else(|_| "Unknown device".to_string());

            devices.push(DeviceInfo {
                id,
                label,
                kind: kind.to_string(),
            });
        }
    }

    Ok(devices)
}

fn list_video_devices() -> Result<Vec<DeviceInfo>, String> {
    let cameras = query(ApiBackend::Auto).map_err(|error| error.to_string())?;
    let mut devices = Vec::new();

    for camera in cameras {
        let id = camera_index_id(camera.index());
        let label = camera.human_name();

        devices.push(DeviceInfo {
            id,
            label,
            kind: "videoinput".to_string(),
        });
    }

    Ok(devices)
}

pub fn resolve_capture_device(device_id: Option<&str>) -> Result<wasapi::Device, String> {
    if initialize_mta().is_err() {
        return Err("failed to initialize COM MTA".to_string());
    }

    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;

    if let Some(device_id) = device_id.filter(|value| !value.is_empty()) {
        match enumerator.get_device(device_id) {
            Ok(device) => return Ok(device),
            Err(error) => {
                log::warn!("mic device {device_id} not found: {error}, using default");
            }
        }
    }

    enumerator
        .get_default_device(&Direction::Capture)
        .map_err(|error| error.to_string())
}

pub fn resolve_camera_index(device_id: Option<&str>) -> CameraIndex {
    if let Some(device_id) = device_id.filter(|value| !value.is_empty()) {
        if let Ok(index) = device_id.parse::<u32>() {
            return CameraIndex::Index(index);
        }
        return CameraIndex::String(device_id.to_string());
    }

    CameraIndex::Index(0)
}

fn camera_index_id(index: &CameraIndex) -> String {
    match index {
        CameraIndex::Index(value) => value.to_string(),
        CameraIndex::String(value) => value.clone(),
    }
}
