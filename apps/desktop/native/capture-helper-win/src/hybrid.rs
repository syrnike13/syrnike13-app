use std::ptr::null_mut;

use scrap::{Capturer, Display};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect, PW_RENDERFULLCONTENT};

use crate::monitor::monitor_bounds_by_index;
use crate::target::CaptureTarget;
use crate::wgc::WgcCapturer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureMethod {
    Wgc,
    Dxgi,
    GdiBlt,
    GdiPrint,
}

impl CaptureMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureMethod::Wgc => "wgc",
            CaptureMethod::Dxgi => "dxgi",
            CaptureMethod::GdiBlt => "gdi_blt",
            CaptureMethod::GdiPrint => "gdi_print",
        }
    }
}

pub struct CapturedFrame {
    pub bgra: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub method: CaptureMethod,
}

pub struct HybridCapturer {
    target: CaptureTarget,
    width: u32,
    height: u32,
    method: CaptureMethod,
    scrap: Option<Capturer>,
    wgc: Option<WgcCapturer>,
    empty_streak: u32,
    last_downgrade_reason: Option<String>,
}

const EMPTY_FRAME_THRESHOLD: u32 = 3;

impl HybridCapturer {
    pub fn new(target: CaptureTarget, width: u32, height: u32) -> Result<Self, String> {
        let initial_method = if target.hwnd.is_some() || target.monitor_index.is_some() {
            CaptureMethod::Wgc
        } else {
            CaptureMethod::GdiBlt
        };

        let mut capturer = Self {
            target,
            width,
            height,
            method: initial_method,
            scrap: None,
            wgc: None,
            empty_streak: 0,
            last_downgrade_reason: None,
        };
        capturer.try_init_current_method()?;
        Ok(capturer)
    }

    pub fn method(&self) -> CaptureMethod {
        self.method
    }

    pub fn take_downgrade_reason(&mut self) -> Option<String> {
        self.last_downgrade_reason.take()
    }

    pub fn capture(&mut self) -> Result<CapturedFrame, String> {
        for _ in 0..4 {
            match self.capture_once() {
                Ok(frame) => {
                    self.empty_streak = 0;
                    return Ok(frame);
                }
                Err(error) => {
                    self.empty_streak += 1;
                    if self.empty_streak >= EMPTY_FRAME_THRESHOLD {
                        self.downgrade_method(&error)?;
                        self.empty_streak = 0;
                        continue;
                    }
                    return Err(error);
                }
            }
        }

        Err("capture failed after method downgrade".to_string())
    }

    fn capture_once(&mut self) -> Result<CapturedFrame, String> {
        match self.method {
            CaptureMethod::Wgc => self.capture_wgc(),
            CaptureMethod::Dxgi => self.capture_dxgi(),
            CaptureMethod::GdiBlt => self.capture_gdi_blt(),
            CaptureMethod::GdiPrint => self.capture_gdi_print(),
        }
    }

    fn try_init_current_method(&mut self) -> Result<(), String> {
        if self.method == CaptureMethod::Wgc {
            let wgc = if let Some(hwnd) = self.target.hwnd {
                WgcCapturer::for_window(hwnd)
            } else if let Some(index) = self.target.monitor_index {
                WgcCapturer::for_monitor(index)
            } else {
                return self.fallback_from_wgc("wgc requires window or monitor target");
            };

            match wgc {
                Ok(capturer) => {
                    self.wgc = Some(capturer);
                    return Ok(());
                }
                Err(error) => {
                    return self.fallback_from_wgc(&error);
                }
            }
        }

        if self.method == CaptureMethod::Dxgi {
            if self.target.monitor_index.is_some() {
                let displays = Display::all().map_err(|error| error.to_string())?;
                let index = self.target.monitor_index.unwrap_or(0);
                let display = displays
                    .into_iter()
                    .nth(index)
                    .ok_or_else(|| "monitor not found".to_string())?;
                self.scrap = Some(Capturer::new(display).map_err(|error| error.to_string())?);
                return Ok(());
            }
            self.method = CaptureMethod::GdiBlt;
        }

        if self.method == CaptureMethod::GdiPrint && self.target.hwnd.is_none() {
            self.method = CaptureMethod::GdiBlt;
        }

        Ok(())
    }

    fn fallback_from_wgc(&mut self, reason: &str) -> Result<(), String> {
        self.wgc = None;
        self.last_downgrade_reason = Some(format!("wgc init failed: {reason}"));
        self.method = if self.target.hwnd.is_some() {
            CaptureMethod::GdiPrint
        } else if self.target.monitor_index.is_some() {
            CaptureMethod::Dxgi
        } else {
            CaptureMethod::GdiBlt
        };
        self.try_init_current_method()
    }

    fn downgrade_method(&mut self, reason: &str) -> Result<(), String> {
        let from = self.method;
        self.wgc = None;
        self.scrap = None;
        self.last_downgrade_reason = Some(format!("{} failed: {}", from.as_str(), reason));

        self.method = match (
            from,
            self.target.hwnd.is_some(),
            self.target.monitor_index.is_some(),
        ) {
            (CaptureMethod::Wgc, true, _) => CaptureMethod::GdiPrint,
            (CaptureMethod::Wgc, false, true) => CaptureMethod::Dxgi,
            (CaptureMethod::Wgc, false, false) => CaptureMethod::GdiBlt,
            (CaptureMethod::Dxgi, true, _) => CaptureMethod::GdiPrint,
            (CaptureMethod::Dxgi, false, true) => CaptureMethod::GdiBlt,
            (CaptureMethod::GdiPrint, _, _) => CaptureMethod::GdiBlt,
            (CaptureMethod::GdiBlt, _, _) => {
                return Err("no capture method left".to_string());
            }
            (CaptureMethod::Dxgi, false, false) => CaptureMethod::GdiBlt,
        };
        self.try_init_current_method()
    }

    fn capture_wgc(&mut self) -> Result<CapturedFrame, String> {
        let capturer = self
            .wgc
            .as_ref()
            .ok_or_else(|| "wgc capturer not initialized".to_string())?;
        let (bgra, width, height) = capturer.capture_bgra(self.width, self.height)?;
        Ok(CapturedFrame {
            bgra,
            width,
            height,
            stride: width * 4,
            method: CaptureMethod::Wgc,
        })
    }

    fn capture_dxgi(&mut self) -> Result<CapturedFrame, String> {
        let capturer = self
            .scrap
            .as_mut()
            .ok_or_else(|| "dxgi capturer not initialized".to_string())?;
        let width = capturer.width();
        let height = capturer.height();
        let stride = width * 4;
        let frame = capturer.frame().map_err(|error| error.to_string())?;
        let mut bgra = frame.to_vec();
        resize_bgra(
            &mut bgra,
            width,
            height,
            stride,
            self.width as usize,
            self.height as usize,
        );
        Ok(CapturedFrame {
            bgra,
            width: self.width as usize,
            height: self.height as usize,
            stride: self.width as usize * 4,
            method: CaptureMethod::Dxgi,
        })
    }

    fn capture_gdi_print(&mut self) -> Result<CapturedFrame, String> {
        let hwnd = self
            .target
            .hwnd
            .ok_or_else(|| "gdi_print requires window target".to_string())?;
        capture_hwnd_gdi(hwnd, self.width, self.height, true).map(|frame| CapturedFrame {
            method: CaptureMethod::GdiPrint,
            ..frame
        })
    }

    fn capture_gdi_blt(&mut self) -> Result<CapturedFrame, String> {
        if let Some(hwnd) = self.target.hwnd {
            return capture_hwnd_gdi(hwnd, self.width, self.height, false).map(|frame| {
                CapturedFrame {
                    method: CaptureMethod::GdiBlt,
                    ..frame
                }
            });
        }

        if let Some(index) = self.target.monitor_index {
            let bounds = monitor_bounds_by_index(index)?;
            return capture_monitor_gdi(
                (bounds.left, bounds.top),
                bounds.width,
                bounds.height,
                self.width,
                self.height,
            )
            .map(|frame| CapturedFrame {
                method: CaptureMethod::GdiBlt,
                ..frame
            });
        }

        Err("no gdi target".to_string())
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

fn capture_hwnd_gdi(
    hwnd: isize,
    target_width: u32,
    target_height: u32,
    use_print_window: bool,
) -> Result<CapturedFrame, String> {
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let mut rect = Default::default();
        if use_print_window {
            GetClientRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
        } else {
            GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
        }
        let width = (rect.right - rect.left).max(1) as u32;
        let height = (rect.bottom - rect.top).max(1) as u32;

        let window_dc = GetDC(hwnd);
        if window_dc.is_invalid() {
            return Err("GetDC failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(window_dc);
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(hwnd, window_dc);
            return Err("CreateCompatibleDC failed".to_string());
        }

        let bitmap: HBITMAP = CreateCompatibleBitmap(window_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(hwnd, window_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let old = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
        let copied = if use_print_window {
            PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
        } else {
            BitBlt(
                mem_dc,
                0,
                0,
                width as i32,
                height as i32,
                window_dc,
                0,
                0,
                SRCCOPY,
            )
            .is_ok()
        };

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut buffer = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(hwnd, window_dc);

        if !copied || lines == 0 {
            return Err("gdi capture failed".to_string());
        }

        let mut bgra = buffer;
        resize_bgra(
            &mut bgra,
            width as usize,
            height as usize,
            width as usize * 4,
            target_width as usize,
            target_height as usize,
        );

        Ok(CapturedFrame {
            bgra,
            width: target_width as usize,
            height: target_height as usize,
            stride: target_width as usize * 4,
            method: if use_print_window {
                CaptureMethod::GdiPrint
            } else {
                CaptureMethod::GdiBlt
            },
        })
    }
}

fn capture_monitor_gdi(
    origin: (i32, i32),
    width: i32,
    height: i32,
    target_width: u32,
    target_height: u32,
) -> Result<CapturedFrame, String> {
    unsafe {
        let screen_dc = GetDC(HWND(null_mut()));
        if screen_dc.is_invalid() {
            return Err("GetDC screen failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap: HBITMAP = CreateCompatibleBitmap(screen_dc, width, height);
        let old = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
        let copied = BitBlt(
            mem_dc, 0, 0, width, height, screen_dc, origin.0, origin.1, SRCCOPY,
        )
        .is_ok();

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut buffer = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(HWND(null_mut()), screen_dc);

        if !copied || lines == 0 {
            return Err("monitor gdi capture failed".to_string());
        }

        let mut bgra = buffer;
        resize_bgra(
            &mut bgra,
            width as usize,
            height as usize,
            width as usize * 4,
            target_width as usize,
            target_height as usize,
        );

        Ok(CapturedFrame {
            bgra,
            width: target_width as usize,
            height: target_height as usize,
            stride: target_width as usize * 4,
            method: CaptureMethod::GdiBlt,
        })
    }
}
