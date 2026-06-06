use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

#[derive(Clone)]
struct SharedFrame {
    data: Arc<Mutex<Option<Vec<u8>>>>,
    width: Arc<Mutex<u32>>,
    height: Arc<Mutex<u32>>,
    stop: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
}

struct WgcHandler {
    shared: SharedFrame,
}

impl GraphicsCaptureApiHandler for WgcHandler {
    type Flags = SharedFrame;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            shared: context.flags,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut buffer = frame.buffer()?;
        let width = buffer.width();
        let height = buffer.height();
        let pixels = buffer.as_raw_buffer();

        *self.shared.data.lock().map_err(|_| "wgc lock poisoned")? =
            Some(pixels.to_vec());
        *self.shared.width.lock().map_err(|_| "wgc lock poisoned")? = width;
        *self.shared.height.lock().map_err(|_| "wgc lock poisoned")? = height;
        self.shared.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.stop.store(true, Ordering::SeqCst);
        Ok(())
    }
}

pub struct WgcCapturer {
    shared: SharedFrame,
    thread: Option<JoinHandle<()>>,
}

impl WgcCapturer {
    pub fn for_window(hwnd: isize) -> Result<Self, String> {
        Self::start_in_thread(move || {
            let window = Window::from_raw_hwnd(hwnd as *mut _);
            match window.try_into() {
                Ok(item) => Ok(item),
                Err(error) => Err(format!("{error}")),
            }
        })
    }

    pub fn for_monitor(index: usize) -> Result<Self, String> {
        Self::start_in_thread(move || {
            let monitor = Monitor::from_index(index + 1).map_err(|error| error.to_string())?;
            match monitor.try_into() {
                Ok(item) => Ok(item),
                Err(error) => Err(format!("{error}")),
            }
        })
    }

    fn start_in_thread(
        build_item: impl FnOnce() -> Result<GraphicsCaptureItemType, String> + Send + 'static,
    ) -> Result<Self, String> {
        let shared = SharedFrame {
            data: Arc::new(Mutex::new(None)),
            width: Arc::new(Mutex::new(0)),
            height: Arc::new(Mutex::new(0)),
            stop: Arc::new(AtomicBool::new(false)),
            ready: Arc::new(AtomicBool::new(false)),
        };

        let thread_shared = shared.clone();
        let thread = thread::Builder::new()
            .name("wgc-capture".into())
            .spawn(move || {
                let capture_item = match build_item() {
                    Ok(item) => item,
                    Err(error) => {
                        eprintln!("[wgc] failed to create capture item: {error}");
                        thread_shared.stop.store(true, Ordering::SeqCst);
                        return;
                    }
                };

                let settings = Settings::new(
                    capture_item,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    thread_shared.clone(),
                );

                if let Err(error) = WgcHandler::start(settings) {
                    eprintln!("[wgc] capture stopped: {error}");
                }
                thread_shared.stop.store(true, Ordering::SeqCst);
            })
            .map_err(|error| error.to_string())?;

        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while !shared.ready.load(Ordering::SeqCst) && !shared.stop.load(Ordering::SeqCst) {
            if std::time::Instant::now() >= deadline {
                return Err("wgc init timeout".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        }

        if shared.stop.load(Ordering::SeqCst) {
            return Err("wgc failed to start".to_string());
        }

        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    pub fn capture_bgra(
        &self,
        target_width: u32,
        target_height: u32,
    ) -> Result<(Vec<u8>, usize, usize), String> {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        loop {
            if let Some(pixels) = self
                .shared
                .data
                .lock()
                .map_err(|_| "wgc lock poisoned")?
                .clone()
            {
                let width = *self
                    .shared
                    .width
                    .lock()
                    .map_err(|_| "wgc lock poisoned")?;
                let height = *self
                    .shared
                    .height
                    .lock()
                    .map_err(|_| "wgc lock poisoned")?;
                if width > 0 && height > 0 {
                    let stride = width as usize * 4;
                    let mut bgra = pixels;
                    resize_bgra(
                        &mut bgra,
                        width as usize,
                        height as usize,
                        stride,
                        target_width as usize,
                        target_height as usize,
                    );
                    return Ok((
                        bgra,
                        target_width as usize,
                        target_height as usize,
                    ));
                }
            }

            if self.shared.stop.load(Ordering::SeqCst) {
                return Err("wgc capture stopped".to_string());
            }
            if std::time::Instant::now() >= deadline {
                return Err("wgc frame timeout".to_string());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for WgcCapturer {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn resize_bgra(
    source: &mut Vec<u8>,
    src_width: usize,
    src_height: usize,
    src_stride: usize,
    dst_width: usize,
    dst_height: usize,
) {
    if src_width == dst_width && src_height == dst_height {
        source.truncate(dst_width * dst_height * 4);
        return;
    }

    let mut resized = vec![0u8; dst_width * dst_height * 4];
    for y in 0..dst_height {
        let src_y = y * src_height / dst_height;
        for x in 0..dst_width {
            let src_x = x * src_width / dst_width;
            let src_index = src_y * src_stride + src_x * 4;
            let dst_index = (y * dst_width + x) * 4;
            if src_index + 3 < source.len() {
                resized[dst_index..dst_index + 4]
                    .copy_from_slice(&source[src_index..src_index + 4]);
            }
        }
    }
    *source = resized;
}
