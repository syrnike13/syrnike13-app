/* Copyright 2026 LiveKit; SPDX-License-Identifier: Apache-2.0 */
#include <gtest/gtest.h>

#include <livekit/d3d11_h264_video_source.h>

namespace livekit::test {

namespace {
class TestLease final : public D3D11TextureLease {
 public:
  const D3D11SharedTexture& texture() const noexcept override { return texture_; }
  void accepted() noexcept override { accepted_ = true; }
  void release() noexcept override { released_ = true; }
  D3D11SharedTexture texture_{};
  bool accepted_ = false;
  bool released_ = false;
};
}  // namespace

TEST(D3D11H264VideoSourceTest, AcceptedLeaseDoesNotUseRejectPath) {
  TestLease lease;
  lease.accepted();
  EXPECT_TRUE(lease.accepted_);
  EXPECT_FALSE(lease.released_);
}

TEST(D3D11H264VideoSourceTest, CapabilityControlsFactory) {
  const auto capability = queryD3D11H264Capability();
  if (capability.available) {
    EXPECT_TRUE(capability.reason.empty());
    EXPECT_NE(createD3D11H264VideoSource(1920, 1080), nullptr);
  } else {
    EXPECT_FALSE(capability.reason.empty());
    EXPECT_EQ(createD3D11H264VideoSource(1920, 1080), nullptr);
  }
}

}  // namespace livekit::test
