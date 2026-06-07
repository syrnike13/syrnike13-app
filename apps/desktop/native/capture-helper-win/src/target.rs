use serde::Deserialize;



#[derive(Debug, Clone)]

pub struct CaptureTarget {

    pub source_id: String,

    pub monitor_index: Option<usize>,

    pub hwnd: Option<isize>,

}



#[derive(Debug, Deserialize)]

pub struct StartCommand {

    pub cmd: String,

    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,

    #[serde(rename = "sessionKind")]
    pub session_kind: Option<String>,

    pub target: Option<TargetPayload>,

    pub width: Option<u32>,

    pub height: Option<u32>,

    pub fps: Option<u32>,

    pub bitrate: Option<u32>,

    #[serde(rename = "streamMode")]
    pub stream_mode: Option<String>,
    pub audio: Option<bool>,
    #[serde(rename = "excludeProcessId")]
    pub exclude_process_id: Option<u32>,
    #[serde(rename = "selfWindowHwnd")]
    pub self_window_hwnd: Option<isize>,
}



#[derive(Debug, Deserialize)]

pub struct TargetPayload {

    pub id: String,

}



pub fn process_id_for_hwnd(hwnd: isize) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            None
        } else {
            Some(process_id)
        }
    }
}

pub fn parse_target(source_id: &str) -> Option<CaptureTarget> {

    if let Some(rest) = source_id.strip_prefix("screen:") {

        let index = rest.split(':').next()?.parse::<usize>().ok()?;

        return Some(CaptureTarget {

            source_id: source_id.to_string(),

            monitor_index: Some(index),

            hwnd: None,

        });

    }



    if let Some(rest) = source_id.strip_prefix("window:") {

        let hwnd = rest.split(':').next()?.parse::<isize>().ok()?;

        return Some(CaptureTarget {

            source_id: source_id.to_string(),

            monitor_index: None,

            hwnd: Some(hwnd),

        });

    }



    None

}



#[cfg(test)]

mod tests {

    use super::*;



    #[test]

    fn parses_monitor_source_id() {

        let target = parse_target("screen:0:0").expect("monitor");

        assert_eq!(target.monitor_index, Some(0));

        assert!(target.hwnd.is_none());

    }



    #[test]

    fn parses_window_source_id() {

        let target = parse_target("window:12345:0").expect("window");

        assert_eq!(target.hwnd, Some(12345));

        assert!(target.monitor_index.is_none());

    }

    #[test]

    fn parses_exclude_process_id_from_start_command() {

        let command: StartCommand = serde_json::from_str(

            r#"{"cmd":"start","sessionId":"session-1","sessionKind":"screen","target":{"id":"screen:0:0"},"excludeProcessId":4242,"selfWindowHwnd":99}"#,

        )

        .expect("start command");

        assert_eq!(command.session_id.as_deref(), Some("session-1"));

        assert_eq!(command.session_kind.as_deref(), Some("screen"));

        assert_eq!(command.exclude_process_id, Some(4242));

        assert_eq!(command.self_window_hwnd, Some(99));

    }

}
