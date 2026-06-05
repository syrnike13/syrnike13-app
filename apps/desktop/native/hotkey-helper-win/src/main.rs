use std::{
    io::{self, Write},
    sync::{Mutex, OnceLock},
};

use serde::Serialize;
use windows::Win32::{
    Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{
            VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL,
            VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
        },
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
            HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL,
            WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
            WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
            WM_XBUTTONDOWN, WM_XBUTTONUP,
        },
    },
};

const XBUTTON1_ID: u32 = 0x0001;
const XBUTTON2_ID: u32 = 0x0002;

#[derive(Default, Clone, Copy, Serialize)]
struct Modifiers {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

#[derive(Default)]
struct InputState {
    modifiers: Modifiers,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum NativeInputEvent {
    #[serde(rename = "keyDown")]
    KeyDown {
        code: String,
        key: String,
        modifiers: Modifiers,
    },
    #[serde(rename = "keyUp")]
    KeyUp {
        code: String,
        key: String,
        modifiers: Modifiers,
    },
    #[serde(rename = "mouseDown")]
    MouseDown {
        button: String,
        modifiers: Modifiers,
    },
    #[serde(rename = "mouseUp")]
    MouseUp {
        button: String,
        modifiers: Modifiers,
    },
}

static STATE: OnceLock<Mutex<InputState>> = OnceLock::new();

fn state() -> &'static Mutex<InputState> {
    STATE.get_or_init(|| Mutex::new(InputState::default()))
}

fn main() {
    unsafe {
        let keyboard =
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE::default(), 0)
                .unwrap_or_default();
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE::default(), 0)
            .unwrap_or_default();

        if keyboard.is_invalid() || mouse.is_invalid() {
            eprintln!("failed to install low level hooks");
            std::process::exit(1);
        }

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        let down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
        let up = wparam.0 as u32 == WM_KEYUP || wparam.0 as u32 == WM_SYSKEYUP;

        if down || up {
            let vk = info.vkCode;
            let scan = info.scanCode;
            let code_name = key_code_name(vk, scan);
            let key = key_label(vk, &code_name);
            let modifiers = update_modifier_state(vk, down);
            let event = if down {
                NativeInputEvent::KeyDown {
                    code: code_name,
                    key,
                    modifiers,
                }
            } else {
                NativeInputEvent::KeyUp {
                    code: code_name,
                    key,
                    modifiers,
                }
            };
            emit_event(event);
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if message == WM_XBUTTONDOWN || message == WM_XBUTTONUP {
            let info = *(lparam.0 as *const MSLLHOOKSTRUCT);
            let xbutton = (info.mouseData >> 16) & 0xffff;
            let button = if xbutton == XBUTTON1_ID {
                Some("Mouse4")
            } else if xbutton == XBUTTON2_ID {
                Some("Mouse5")
            } else {
                None
            };

            if let Some(button) = button {
                let modifiers = state().lock().map(|s| s.modifiers).unwrap_or_default();
                let event = if message == WM_XBUTTONDOWN {
                    NativeInputEvent::MouseDown {
                        button: button.to_owned(),
                        modifiers,
                    }
                } else {
                    NativeInputEvent::MouseUp {
                        button: button.to_owned(),
                        modifiers,
                    }
                };
                emit_event(event);
            }
        } else {
            let _ = (
                WM_LBUTTONDOWN,
                WM_LBUTTONUP,
                WM_RBUTTONDOWN,
                WM_RBUTTONUP,
                WM_MBUTTONDOWN,
                WM_MBUTTONUP,
                WM_MOUSEWHEEL,
            );
        }
    }

    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

fn update_modifier_state(vk: u32, down: bool) -> Modifiers {
    let mut guard = state().lock().expect("input state poisoned");
    match vk {
        x if x == VK_CONTROL.0 as u32 || x == VK_LCONTROL.0 as u32 || x == VK_RCONTROL.0 as u32 => {
            guard.modifiers.ctrl = down
        }
        x if x == VK_MENU.0 as u32 || x == VK_LMENU.0 as u32 || x == VK_RMENU.0 as u32 => {
            guard.modifiers.alt = down
        }
        x if x == VK_SHIFT.0 as u32 || x == VK_LSHIFT.0 as u32 || x == VK_RSHIFT.0 as u32 => {
            guard.modifiers.shift = down
        }
        x if x == VK_LWIN.0 as u32 || x == VK_RWIN.0 as u32 => guard.modifiers.meta = down,
        _ => {}
    }
    guard.modifiers
}

fn emit_event(event: NativeInputEvent) {
    if let Ok(line) = serde_json::to_string(&event) {
        let mut stdout = io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }
}

fn key_code_name(vk: u32, scan: u32) -> String {
    if (0x41..=0x5a).contains(&vk) {
        return format!("Key{}", char::from_u32(vk).unwrap_or_default());
    }
    if (0x30..=0x39).contains(&vk) {
        return format!("Digit{}", char::from_u32(vk).unwrap_or_default());
    }
    match vk {
        x if x == VK_LCONTROL.0 as u32 => "ControlLeft".to_owned(),
        x if x == VK_RCONTROL.0 as u32 => "ControlRight".to_owned(),
        x if x == VK_LMENU.0 as u32 => "AltLeft".to_owned(),
        x if x == VK_RMENU.0 as u32 => "AltRight".to_owned(),
        x if x == VK_LSHIFT.0 as u32 => "ShiftLeft".to_owned(),
        x if x == VK_RSHIFT.0 as u32 => "ShiftRight".to_owned(),
        x if x == VK_LWIN.0 as u32 => "MetaLeft".to_owned(),
        x if x == VK_RWIN.0 as u32 => "MetaRight".to_owned(),
        0x10 => "Shift".to_owned(),
        0x11 => "Control".to_owned(),
        0x12 => "Alt".to_owned(),
        0x1b => "Escape".to_owned(),
        0x20 => "Space".to_owned(),
        0x21 => "PageUp".to_owned(),
        0x22 => "PageDown".to_owned(),
        0x23 => "End".to_owned(),
        0x24 => "Home".to_owned(),
        0x25 => "ArrowLeft".to_owned(),
        0x26 => "ArrowUp".to_owned(),
        0x27 => "ArrowRight".to_owned(),
        0x28 => "ArrowDown".to_owned(),
        0x2d => "Insert".to_owned(),
        0x2e => "Delete".to_owned(),
        0x70..=0x7b => format!("F{}", vk - 0x6f),
        _ => format!("Scan{scan}"),
    }
}

fn key_label(vk: u32, code: &str) -> String {
    if (0x41..=0x5a).contains(&vk) || (0x30..=0x39).contains(&vk) {
        return char::from_u32(vk).unwrap_or_default().to_string();
    }
    code.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_left_and_right_modifiers() {
        assert_eq!(
            key_code_name(VK_LCONTROL.0 as u32, 29),
            "ControlLeft"
        );
        assert_eq!(
            key_code_name(VK_RCONTROL.0 as u32, 29),
            "ControlRight"
        );
        assert_eq!(key_code_name(VK_LMENU.0 as u32, 56), "AltLeft");
        assert_eq!(key_code_name(VK_RMENU.0 as u32, 56), "AltRight");
        assert_eq!(key_code_name(VK_LSHIFT.0 as u32, 42), "ShiftLeft");
        assert_eq!(key_code_name(VK_RSHIFT.0 as u32, 54), "ShiftRight");
        assert_eq!(key_code_name(VK_LWIN.0 as u32, 91), "MetaLeft");
        assert_eq!(key_code_name(VK_RWIN.0 as u32, 92), "MetaRight");
    }
}
