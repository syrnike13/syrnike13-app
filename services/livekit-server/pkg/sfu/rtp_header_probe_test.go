// Copyright 2026 Syrnike13.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

package sfu

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInspectOpusTOC(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		payload    []byte
		valid      bool
		config     uint8
		stereo     bool
		frameCode  uint8
		frameCount uint8
	}{
		{name: "empty", payload: nil},
		{name: "single mono frame", payload: []byte{0x78}, valid: true, config: 15, frameCount: 1},
		{name: "two stereo frames", payload: []byte{0x7d}, valid: true, config: 15, stereo: true, frameCode: 1, frameCount: 2},
		{name: "arbitrary frame count", payload: []byte{0x7f, 0x03}, valid: true, config: 15, stereo: true, frameCode: 3, frameCount: 3},
		{name: "missing frame count", payload: []byte{0x7f}, config: 15, stereo: true, frameCode: 3},
		{name: "invalid frame count", payload: []byte{0x7f, 0x00}, config: 15, stereo: true, frameCode: 3},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := inspectOpusTOC(test.payload)
			require.Equal(t, test.valid, probe.valid)
			require.Equal(t, test.config, probe.config)
			require.Equal(t, test.stereo, probe.stereo)
			require.Equal(t, test.frameCode, probe.frameCode)
			require.Equal(t, test.frameCount, probe.frameCount)
		})
	}
}
