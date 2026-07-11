// Copyright 2026 Syrnike13.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

package sfu

import (
	"os"
	"strings"

	"go.uber.org/atomic"
)

const rtpHeaderProbePacketLimit = uint32(24)

var rtpHeaderProbeEnabled = func() bool {
	value := strings.TrimSpace(os.Getenv("SYRNIKE_RTP_HEADER_PROBE"))
	return value == "1" || strings.EqualFold(value, "true")
}()

type opusTOCProbe struct {
	valid      bool
	config     uint8
	stereo     bool
	frameCode  uint8
	frameCount uint8
}

func takeRTPHeaderProbe(counter *atomic.Uint32) (uint32, bool) {
	if !rtpHeaderProbeEnabled {
		return 0, false
	}

	index := counter.Inc()
	return index, index <= rtpHeaderProbePacketLimit
}

// inspectOpusTOC extracts only codec framing metadata. It intentionally never
// returns or logs encoded media bytes.
func inspectOpusTOC(payload []byte) opusTOCProbe {
	if len(payload) == 0 {
		return opusTOCProbe{}
	}

	toc := payload[0]
	probe := opusTOCProbe{
		valid:      true,
		config:     toc >> 3,
		stereo:     toc&0x04 != 0,
		frameCode:  toc & 0x03,
		frameCount: 1,
	}

	switch probe.frameCode {
	case 1, 2:
		probe.frameCount = 2
	case 3:
		if len(payload) < 2 {
			probe.valid = false
			probe.frameCount = 0
			return probe
		}
		probe.frameCount = payload[1] & 0x3f
		if probe.frameCount == 0 || probe.frameCount > 48 {
			probe.valid = false
		}
	}

	return probe
}
