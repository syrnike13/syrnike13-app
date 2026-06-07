use serde::Serialize;
use wasapi::{initialize_mta, DeviceEnumerator, Direction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesListResult {
    pub devices: Vec<AudioDeviceInfo>,
}

pub fn list_audio_devices() -> Result<DevicesListResult, String> {
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

            devices.push(AudioDeviceInfo {
                id,
                label,
                kind: kind.to_string(),
            });
        }
    }

    Ok(DevicesListResult { devices })
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
