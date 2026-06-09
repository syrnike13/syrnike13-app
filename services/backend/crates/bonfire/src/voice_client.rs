use once_cell::sync::OnceCell;
use syrnike_database::voice::VoiceClient;

static VOICE_CLIENT: OnceCell<VoiceClient> = OnceCell::new();

pub async fn init() {
    let voice_client = VoiceClient::from_syrnike_config().await;

    if VOICE_CLIENT.set(voice_client).is_err() {
        panic!("couldn't set voice client");
    }
}

pub fn get() -> &'static VoiceClient {
    VOICE_CLIENT.get().expect("Valid `VoiceClient`")
}
