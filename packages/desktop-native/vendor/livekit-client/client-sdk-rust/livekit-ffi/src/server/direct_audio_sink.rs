// Copyright 2026 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::{ffi::c_void, sync::Arc};

use livekit::webrtc::{
    audio_stream::native::NativeAudioSinkRegistration, media_stream_track::MediaStreamTrack,
};
use webrtc_sys::audio_track as sys_at;

use super::{room::FfiTrack, FfiHandle, FfiServer};
use crate::{FfiError, FfiHandleId, FfiResult};

/// Receives a borrowed decoded PCM frame on the WebRTC audio delivery thread.
pub type DirectAudioFrameCallback = unsafe extern "C" fn(
    context: *mut c_void,
    data: *const i16,
    sample_rate: u32,
    num_channels: u32,
    num_frames: u32,
);

/// Releases the foreign callback context after the WebRTC sink is quiescent.
pub type DirectAudioReleaseCallback = unsafe extern "C" fn(context: *mut c_void);

/// Owns the foreign callback context until every observer reference is gone.
pub struct DirectAudioCallbackContext {
    context: usize,
    on_frame: DirectAudioFrameCallback,
    on_release: DirectAudioReleaseCallback,
}

impl DirectAudioCallbackContext {
    /// Creates the single release owner for a foreign callback context.
    pub fn new(
        context: *mut c_void,
        on_frame: DirectAudioFrameCallback,
        on_release: DirectAudioReleaseCallback,
    ) -> Self {
        Self { context: context as usize, on_frame, on_release }
    }
}

impl Drop for DirectAudioCallbackContext {
    fn drop(&mut self) {
        // SAFETY: Ownership of context was transferred at attach time and the
        // last Arc reference is its sole release owner.
        unsafe { (self.on_release)(self.context as *mut c_void) };
    }
}

struct ForeignAudioObserver {
    callbacks: Arc<DirectAudioCallbackContext>,
}

impl sys_at::AudioSink for ForeignAudioObserver {
    fn on_data(&self, data: &[i16], sample_rate: i32, num_channels: usize, num_frames: usize) {
        let Ok(sample_rate) = u32::try_from(sample_rate) else {
            return;
        };
        let Ok(num_channels) = u32::try_from(num_channels) else {
            return;
        };
        let Ok(num_frames) = u32::try_from(num_frames) else {
            return;
        };

        // SAFETY: The foreign caller keeps context alive until on_release. The
        // PCM slice remains valid for the duration of this synchronous call.
        unsafe {
            (self.callbacks.on_frame)(
                self.callbacks.context as *mut c_void,
                data.as_ptr(),
                sample_rate,
                num_channels,
                num_frames,
            );
        }
    }
}

/// Handle owning a direct decoded-audio sink registration.
pub struct FfiDirectAudioSink {
    _registration: NativeAudioSinkRegistration,
}

impl FfiHandle for FfiDirectAudioSink {}

impl FfiDirectAudioSink {
    /// Attaches a foreign observer to an FFI audio track.
    pub fn from_track(
        server: &'static FfiServer,
        track_handle: FfiHandleId,
        sample_rate: u32,
        num_channels: u32,
        callbacks: Arc<DirectAudioCallbackContext>,
    ) -> FfiResult<FfiHandleId> {
        if sample_rate == 0 || !(1..=2).contains(&num_channels) {
            return Err(FfiError::InvalidRequest("invalid direct audio sink format".into()));
        }

        let ffi_track = server.retrieve_handle::<FfiTrack>(track_handle)?.clone();
        let MediaStreamTrack::Audio(rtc_track) = ffi_track.track.rtc_track() else {
            return Err(FfiError::InvalidRequest("track is not audio".into()));
        };
        let observer = Arc::new(ForeignAudioObserver { callbacks });
        let registration = NativeAudioSinkRegistration::new(
            rtc_track,
            sample_rate as i32,
            num_channels as i32,
            observer,
        );
        let handle = server.next_id();
        server.store_handle(handle, Self { _registration: registration });
        Ok(handle)
    }
}
