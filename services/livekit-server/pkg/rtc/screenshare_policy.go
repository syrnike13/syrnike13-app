// Copyright 2023 LiveKit, Inc.
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

package rtc

import (
	"fmt"

	"github.com/livekit/protocol/livekit"
)

// Screen share bounds apply in either orientation: phones share their portrait
// screen at native resolution, desktops share landscape.
const (
	screenShareMaxLongSide  = 3200
	screenShareMaxShortSide = 1440
	screenShareMaxBitrate   = 10_000_000
	screenShareMaxLayers    = 2
)

func fitsScreenShareBounds(width, height uint32) bool {
	return max(width, height) <= screenShareMaxLongSide && min(width, height) <= screenShareMaxShortSide
}

// Screen sharing prioritizes fresh frames over extra receiver playout buffering.
// An explicitly enabled room/subscriber policy still takes precedence.
func screenSharePlayoutDelay(source livekit.TrackSource, configured *livekit.PlayoutDelay) *livekit.PlayoutDelay {
	if source != livekit.TrackSource_SCREEN_SHARE || configured.GetEnabled() {
		return configured
	}
	return &livekit.PlayoutDelay{Enabled: true, Min: 0, Max: 0}
}

func validateScreenSharePublish(req *livekit.AddTrackRequest) error {
	if req.Source != livekit.TrackSource_SCREEN_SHARE {
		return nil
	}
	if req.Type != livekit.TrackType_VIDEO {
		return fmt.Errorf("screen share must be a video track")
	}
	if !fitsScreenShareBounds(req.Width, req.Height) {
		return fmt.Errorf("screen share resolution %dx%d exceeds %dx%d", req.Width, req.Height, screenShareMaxLongSide, screenShareMaxShortSide)
	}
	if err := validateScreenShareLayers(req.Layers); err != nil {
		return err
	}
	for _, codec := range req.SimulcastCodecs {
		if err := validateScreenShareLayers(codec.Layers); err != nil {
			return err
		}
	}
	return nil
}

func validateScreenShareLayers(layers []*livekit.VideoLayer) error {
	if len(layers) == 0 {
		return nil
	}
	if len(layers) > screenShareMaxLayers {
		return fmt.Errorf("screen share publishes %d layers, max %d", len(layers), screenShareMaxLayers)
	}
	for _, layer := range layers {
		if layer == nil {
			continue
		}
		if !fitsScreenShareBounds(layer.Width, layer.Height) {
			return fmt.Errorf("screen share layer %dx%d exceeds %dx%d", layer.Width, layer.Height, screenShareMaxLongSide, screenShareMaxShortSide)
		}
		if layer.Bitrate > screenShareMaxBitrate {
			return fmt.Errorf("screen share layer bitrate %d exceeds %d", layer.Bitrate, screenShareMaxBitrate)
		}
	}
	return nil
}
