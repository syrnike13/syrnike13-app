#include <d3d11.h>
#include <d3d11_1.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <livekit/video_frame.h>

#include "media/remote_video_texture_pool.hpp"

using Microsoft::WRL::ComPtr;
using syrnike::desktop_native::media::RemoteVideoTextureFrame;
using syrnike::desktop_native::media::RemoteVideoTexturePool;

namespace {
using Clock = std::chrono::steady_clock;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void requireHr(HRESULT result, const char* operation) {
  if (SUCCEEDED(result)) return;
  throw std::runtime_error(
    std::string(operation) + " failed (HRESULT " +
    std::to_string(static_cast<std::int32_t>(result)) + ")"
  );
}

std::uint64_t percentile(
  std::vector<std::uint64_t> values,
  double quantile
) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  const auto index = static_cast<std::size_t>(
    quantile * static_cast<double>(values.size() - 1)
  );
  return values[index];
}

void verifySharedFrame(
  const RemoteVideoTextureFrame& frame,
  const livekit::VideoFrame& expected
) {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL level{};
  requireHr(
    D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &device,
      &level,
      &context
    ),
    "consumer D3D11 device creation"
  );
  ComPtr<ID3D11Device1> device1;
  requireHr(
    device.As(&device1),
    "consumer ID3D11Device1 query"
  );
  ComPtr<ID3D11Texture2D> shared;
  requireHr(
    device1->OpenSharedResource1(
      reinterpret_cast<HANDLE>(frame.nt_handle),
      IID_PPV_ARGS(&shared)
    ),
    "consumer shared texture import"
  );
  D3D11_TEXTURE2D_DESC description{};
  shared->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  description.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  requireHr(
    device->CreateTexture2D(&description, nullptr, &staging),
    "consumer staging texture creation"
  );
  context->CopyResource(staging.Get(), shared.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  requireHr(
    context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped),
    "consumer staging texture map"
  );
  bool matches = true;
  for (std::uint32_t y = 0; y < frame.height; ++y) {
    const auto* actual =
      static_cast<const std::uint8_t*>(mapped.pData) +
      static_cast<std::size_t>(y) * mapped.RowPitch;
    const auto* wanted =
      expected.data() +
      static_cast<std::size_t>(y) * frame.width * 4;
    if (std::memcmp(actual, wanted, frame.width * 4) != 0) {
      matches = false;
      break;
    }
  }
  context->Unmap(staging.Get(), 0);
  require(matches, "shared texture contents differ from decoded BGRA frame");
}

struct OutstandingLease {
  Clock::time_point release_at;
  std::shared_ptr<void> lease;
};
}  // namespace

int main() try {
  constexpr std::uint32_t width = 1920;
  constexpr std::uint32_t height = 1080;
  constexpr auto run_duration = std::chrono::seconds(8);
  constexpr auto frame_interval = std::chrono::microseconds(16'667);
  constexpr auto simulated_renderer_hold = std::chrono::milliseconds(8);

  auto source = livekit::VideoFrame::create(
    static_cast<int>(width),
    static_cast<int>(height),
    livekit::VideoBufferType::BGRA
  );
  for (std::uint32_t y = 0; y < height; ++y) {
    for (std::uint32_t x = 0; x < width; ++x) {
      const auto offset =
        (static_cast<std::size_t>(y) * width + x) * 4;
      source.data()[offset] = static_cast<std::uint8_t>((x + y) & 0xffU);
      source.data()[offset + 1] =
        static_cast<std::uint8_t>((x * 3U) & 0xffU);
      source.data()[offset + 2] =
        static_cast<std::uint8_t>((y * 5U) & 0xffU);
      source.data()[offset + 3] = 0xffU;
    }
  }

  {
    RemoteVideoTexturePool freshness_pool(GetCurrentProcessId(), 5);
    require(freshness_pool.submit(source, 10), "freshness frame 1 rejected");
    require(freshness_pool.submit(source, 20), "freshness frame 2 rejected");
    require(freshness_pool.submit(source, 30), "freshness frame 3 rejected");
    const auto freshness_deadline = Clock::now() + std::chrono::seconds(1);
    while (freshness_pool.ready() != 3 && Clock::now() < freshness_deadline) {
      const auto result = freshness_pool.poll();
      require(!result.reset_required, "freshness pool requested a device reset");
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    require(freshness_pool.ready() == 3, "freshness frames did not complete");
    RemoteVideoTextureFrame freshest;
    require(freshness_pool.take(freshest), "freshness pool returned no frame");
    require(freshest.timestamp_us == 30, "texture pool delivered stale FIFO frame");
    require(
      freshness_pool.consumeSupersededReadyFrames() == 2,
      "texture pool did not supersede both older ready frames"
    );
    freshest.lease.reset();
    require(
      freshness_pool.available() == freshness_pool.capacity(),
      "freshness pool did not recycle superseded frames"
    );
  }

  RemoteVideoTexturePool pool(GetCurrentProcessId(), 5);
  std::deque<OutstandingLease> leases;
  std::vector<std::uint64_t> completion_us;
  std::uint64_t submitted = 0;
  std::uint64_t dropped = 0;
  std::uint64_t published = 0;
  bool contents_verified = false;
  const auto started_at = Clock::now();
  const auto deadline = started_at + run_duration;
  auto next_frame_at = started_at;

  while (Clock::now() < deadline) {
    const auto now = Clock::now();
    while (!leases.empty() && leases.front().release_at <= now) {
      leases.pop_front();
    }
    require(
      !pool.poll().reset_required,
      "GPU upload pool requested a reset during the benchmark"
    );
    RemoteVideoTextureFrame uploaded;
    while (pool.take(uploaded)) {
      if (!contents_verified) {
        verifySharedFrame(uploaded, source);
        contents_verified = true;
      }
      completion_us.push_back(uploaded.gpu_completion_us);
      leases.push_back({
        Clock::now() + simulated_renderer_hold,
        std::move(uploaded.lease),
      });
      ++published;
    }
    if (now >= next_frame_at) {
      if (pool.submit(source, submitted * 16'667)) {
        ++submitted;
      } else {
        ++dropped;
      }
      next_frame_at += frame_interval;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  const auto drain_deadline = Clock::now() + std::chrono::seconds(1);
  while (Clock::now() < drain_deadline && pool.available() < pool.capacity()) {
    const auto now = Clock::now();
    while (!leases.empty() && leases.front().release_at <= now) {
      leases.pop_front();
    }
    require(
      !pool.poll().reset_required,
      "GPU upload pool requested a reset while draining"
    );
    RemoteVideoTextureFrame uploaded;
    while (pool.take(uploaded)) {
      completion_us.push_back(uploaded.gpu_completion_us);
      leases.push_back({
        Clock::now() + simulated_renderer_hold,
        std::move(uploaded.lease),
      });
      ++published;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  leases.clear();

  const double fps =
    static_cast<double>(published) /
    std::chrono::duration<double>(run_duration).count();
  const auto p50_us = percentile(completion_us, 0.50);
  const auto p95_us = percentile(completion_us, 0.95);
  const auto max_us = completion_us.empty()
    ? 0
    : *std::max_element(completion_us.begin(), completion_us.end());

  std::cout
    << "remote_video_texture_pool"
    << " width=" << width
    << " height=" << height
    << " submitted=" << submitted
    << " published=" << published
    << " dropped=" << dropped
    << " fps=" << fps
    << " gpu_p50_us=" << p50_us
    << " gpu_p95_us=" << p95_us
    << " gpu_max_us=" << max_us
    << " slots_available=" << pool.available()
    << " slots_total=" << pool.capacity()
    << '\n';

  require(contents_verified, "benchmark did not publish a shared frame");
  require(fps >= 50.0, "persistent GPU upload pool stayed below 50 FPS");
  require(
    p95_us <= 25'000,
    "persistent GPU upload completion p95 exceeded 25 ms"
  );
  require(
    dropped <= submitted / 10 + 1,
    "persistent GPU upload pool dropped more than 10 percent"
  );
  require(
    pool.available() == pool.capacity(),
    "GPU upload slots remained leased after benchmark"
  );
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
