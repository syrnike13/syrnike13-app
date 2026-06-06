use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorBounds {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

pub fn monitor_bounds_by_index(index: usize) -> Result<MonitorBounds, String> {
    let mut monitors: Vec<MonitorBounds> = Vec::new();
    unsafe {
        let ok = EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_proc),
            LPARAM(&mut monitors as *mut _ as isize),
        );
        if !ok.as_bool() {
            return Err("EnumDisplayMonitors failed".to_string());
        }
    }

    monitors
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("monitor index {index} not found"))
}

unsafe extern "system" fn enum_monitor_proc(
    monitor: HMONITOR,
    _device: windows::Win32::Graphics::Gdi::HDC,
    _clip: *mut RECT,
    state: LPARAM,
) -> BOOL {
    let monitors = &mut *(state.0 as *mut Vec<MonitorBounds>);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };

    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return BOOL(1);
    }

    let rect = info.rcMonitor;
    monitors.push(MonitorBounds {
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    });

    BOOL(1)
}

pub fn primary_monitor_bounds() -> Result<MonitorBounds, String> {
    let mut primary: Option<MonitorBounds> = None;
    unsafe {
        let ok = EnumDisplayMonitors(
            None,
            None,
            Some(enum_primary_proc),
            LPARAM(&mut primary as *mut _ as isize),
        );
        if !ok.as_bool() {
            return Err("EnumDisplayMonitors failed".to_string());
        }
    }

    primary.ok_or_else(|| "primary monitor not found".to_string())
}

unsafe extern "system" fn enum_primary_proc(
    monitor: HMONITOR,
    _device: windows::Win32::Graphics::Gdi::HDC,
    _clip: *mut RECT,
    state: LPARAM,
) -> BOOL {
    let primary = &mut *(state.0 as *mut Option<MonitorBounds>);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };

    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return BOOL(1);
    }

    if info.dwFlags & MONITORINFOF_PRIMARY == 0 {
        return BOOL(1);
    }

    let rect = info.rcMonitor;
    *primary = Some(MonitorBounds {
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    });

    BOOL(0)
}

#[allow(dead_code)]
pub fn monitor_count() -> Result<usize, String> {
    let mut count = 0usize;
    unsafe {
        let ok = EnumDisplayMonitors(
            None,
            None,
            Some(count_monitor_proc),
            LPARAM(&mut count as *mut _ as isize),
        );
        if !ok.as_bool() {
            return Err("EnumDisplayMonitors failed".to_string());
        }
    }
    Ok(count)
}

unsafe extern "system" fn count_monitor_proc(
    _monitor: HMONITOR,
    _device: windows::Win32::Graphics::Gdi::HDC,
    _clip: *mut RECT,
    state: LPARAM,
) -> BOOL {
    let count = &mut *(state.0 as *mut usize);
    *count += 1;
    BOOL(1)
}
