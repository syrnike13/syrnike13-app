use std::fs::OpenOptions;
use std::path::PathBuf;

use memmap2::{MmapMut, MmapOptions};

const HEADER_BYTES: usize = 12;

pub struct SharedFrameBuffer {
    path: PathBuf,
    mmap: MmapMut,
    capacity: usize,
}

impl SharedFrameBuffer {
    pub fn create(width: u32, height: u32) -> Result<(Self, String), String> {
        let max_payload = width as usize * height as usize * 4;
        let capacity = HEADER_BYTES + max_payload;
        let path = std::env::temp_dir().join(format!(
            "syrnike-capture-{}.bin",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        ));

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        file.set_len(capacity as u64)
            .map_err(|error| error.to_string())?;

        let mmap = unsafe {
            MmapOptions::new()
                .len(capacity)
                .map_mut(&file)
                .map_err(|error| error.to_string())?
        };

        let path_string = path.to_string_lossy().into_owned();
        Ok((
            Self {
                path,
                mmap,
                capacity,
            },
            path_string,
        ))
    }

    pub fn write_bgra_frame(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        bgra: &[u8],
    ) -> Result<(), String> {
        let payload_len = width as usize * height as usize * 4;
        let total = HEADER_BYTES + payload_len;
        if total > self.capacity {
            return Err("shared frame buffer overflow".to_string());
        }

        self.mmap[0..4].copy_from_slice(&width.to_le_bytes());
        self.mmap[4..8].copy_from_slice(&height.to_le_bytes());
        self.mmap[8..12].copy_from_slice(&stride.to_le_bytes());
        self.mmap[12..12 + payload_len].copy_from_slice(bgra);
        self.mmap
            .flush()
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl Drop for SharedFrameBuffer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn pack_bgra_frame_header(width: u32, height: u32, stride: u32) -> [u8; HEADER_BYTES] {
    let mut header = [0u8; HEADER_BYTES];
    header[0..4].copy_from_slice(&width.to_le_bytes());
    header[4..8].copy_from_slice(&height.to_le_bytes());
    header[8..12].copy_from_slice(&stride.to_le_bytes());
    header
}

pub fn pack_bgra_frame(width: u32, height: u32, stride: u32, bgra: &[u8]) -> Vec<u8> {
    let mut packed = Vec::with_capacity(HEADER_BYTES + bgra.len());
    packed.extend_from_slice(&pack_bgra_frame_header(width, height, stride));
    packed.extend_from_slice(bgra);
    packed
}
