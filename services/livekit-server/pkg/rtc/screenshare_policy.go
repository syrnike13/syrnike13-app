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

const (
	screenShareMaxWidth   = 1920
	screenShareMaxHeight  = 1080
	screenShareMaxBitrate = 8_000_000
	screenShareMaxLayers  = 2
)

func validateScreenSharePublish(req *livekit.AddTrackRequest) error {
	if req.Source != livekit.TrackSource_SCREEN_SHARE {
		return nil
	}
	if req.Type != livekit.TrackType_VIDEO {
		return fmt.Errorf("screen share must be a video track")
	}
	if req.Width > screenShareMaxWidth || req.Height > screenShareMaxHeight {
		return fmt.Errorf("screen share resolution %dx%d exceeds %dx%d", req.Width, req.Height, screenShareMaxWidth, screenShareMaxHeight)
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
		if layer.Width > screenShareMaxWidth || layer.Height > screenShareMaxHeight {
			return fmt.Errorf("screen share layer %dx%d exceeds %dx%d", layer.Width, layer.Height, screenShareMaxWidth, screenShareMaxHeight)
		}
		if layer.Bitrate > screenShareMaxBitrate {
			return fmt.Errorf("screen share layer bitrate %d exceeds %d", layer.Bitrate, screenShareMaxBitrate)
		}
		if !isAllowedScreenShareLayer(layer) {
			return fmt.Errorf("screen share layer %dx%d bitrate %d is outside allowed presets", layer.Width, layer.Height, layer.Bitrate)
		}
	}
	return nil
}

func isAllowedScreenShareLayer(layer *livekit.VideoLayer) bool {
	switch layer.Bitrate {
	case 625_000:
		return layer.Width <= 960 && layer.Height <= 540
	case 2_500_000:
		return layer.Width <= 1280 && layer.Height <= 720
	case 2_000_000, 4_000_000, 8_000_000:
		return layer.Width <= screenShareMaxWidth && layer.Height <= screenShareMaxHeight
	default:
		return false
	}
}
