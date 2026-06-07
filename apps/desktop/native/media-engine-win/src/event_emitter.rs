use std::io::{self, Write};

use crate::protocol::EventMessage;

pub fn emit_engine_event(event: &str, params: impl serde::Serialize) {
    let message = EventMessage::new(event, params);
    let Ok(line) = serde_json::to_string(&message) else {
        return;
    };

    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}
