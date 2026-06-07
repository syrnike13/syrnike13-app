use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use crate::protocol::{emit, Event};

pub struct AudioCaptureSession {
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) thread: Option<thread::JoinHandle<()>>,
}

impl AudioCaptureSession {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct CaptureSession {
    session_id: String,
    session_kind: &'static str,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    audio: Option<AudioCaptureSession>,
}

impl CaptureSession {
    pub fn new(
        session_id: String,
        session_kind: &'static str,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
        audio: Option<AudioCaptureSession>,
    ) -> Self {
        Self {
            session_id,
            session_kind,
            stop,
            thread,
            audio,
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(audio) = self.audio.take() {
            audio.stop();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        emit(&Event::SessionLifecycle {
            session_id: self.session_id,
            kind: self.session_kind,
            status: "stopped",
            port: None,
            audio_port: None,
            audio_mode: None,
            audio_sample_rate: None,
            audio_channels: None,
            message: None,
        });
        emit(&Event::Stopped);
    }
}

pub fn audio_only_session(
    session_id: String,
    session_kind: &'static str,
    audio: AudioCaptureSession,
) -> CaptureSession {
    CaptureSession::new(
        session_id,
        session_kind,
        Arc::new(AtomicBool::new(false)),
        None,
        Some(audio),
    )
}
