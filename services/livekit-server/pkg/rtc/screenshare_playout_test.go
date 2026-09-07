package rtc

import (
	"testing"

	"github.com/livekit/protocol/codecs/mime"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/webrtc/v4"
	"github.com/stretchr/testify/require"

	"github.com/syrnike13/livekit-server/pkg/rtc/transport/transportfakes"
	pd "github.com/syrnike13/livekit-server/pkg/sfu/rtpextension/playoutdelay"
)

func TestScreenSharePlayoutPolicy(t *testing.T) {
	for _, configured := range []*livekit.PlayoutDelay{nil, {Enabled: false, Min: 100, Max: 500}} {
		delay := screenSharePlayoutDelay(livekit.TrackSource_SCREEN_SHARE, configured)
		require.True(t, delay.GetEnabled())
		require.Zero(t, delay.GetMin())
		require.Zero(t, delay.GetMax())
		for _, source := range []livekit.TrackSource{livekit.TrackSource_CAMERA, livekit.TrackSource_MICROPHONE, livekit.TrackSource_SCREEN_SHARE_AUDIO} {
			require.Same(t, configured, screenSharePlayoutDelay(source, configured))
		}
	}
	explicit := &livekit.PlayoutDelay{Enabled: true, Min: 20, Max: 100}
	require.Same(t, explicit, screenSharePlayoutDelay(livekit.TrackSource_SCREEN_SHARE, explicit))
	require.Equal(t, uint32(20), explicit.Min)
}

func TestScreenSharePlayoutCapabilityNegotiatedBeforeTrack(t *testing.T) {
	for _, sendSide := range []bool{false, true} {
		peer, err := NewPCTransport(TransportParams{
			Config: &WebRTCConfig{}, Handler: &transportfakes.FakeHandler{},
			IsSendSide: sendSide, EnabledPublishCodecs: []*livekit.Codec{{Mime: mime.MimeTypeH264.String()}},
		})
		require.NoError(t, err)
		t.Cleanup(peer.Close)
		_, err = peer.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo)
		require.NoError(t, err)
		offer, err := peer.pc.CreateOffer(nil)
		require.NoError(t, err)
		if sendSide {
			require.Contains(t, offer.SDP, pd.PlayoutDelayURI)
		} else {
			require.NotContains(t, offer.SDP, pd.PlayoutDelayURI)
		}
	}
}
