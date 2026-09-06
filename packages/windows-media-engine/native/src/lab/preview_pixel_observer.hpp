#pragma once
#include "screen/local_screen_preview.hpp"
#include <d3d11_1.h>
#include <algorithm>
#include <stdexcept>
#include <thread>
#include <iostream>

namespace syrnike::windows_media::lab {
// Independent consumer device, one staging readback, no retained capture input.
// A ready texture's pixels, not the producer's running flag, establish progress.
class PreviewPixelObserver final {
 public:
  PreviewPixelObserver() {
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        &device_, nullptr, &context_));
    check(device_.As(&device1_));
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 1280; desc.Height = 720; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    check(device_->CreateTexture2D(&desc, nullptr, &staging_));
    if (!screen::LocalScreenPreview::processPreview().demand(1, true))
      throw std::runtime_error("Preview demand failed");
  }
  ~PreviewPixelObserver() {
    if (lease_) std::terminate(); // Never recycle an uncompleted consumer read.
    (void)screen::LocalScreenPreview::processPreview().demand(2, false);
  }
  void poll(bool admit = true) {
    if (!lease_ && admit) {
      lease_ = screen::LocalScreenPreview::processPreview().takeFrame();
      if (!lease_) return;
      began_ = std::chrono::steady_clock::now();
      check(device1_->OpenSharedResource1(reinterpret_cast<HANDLE>(lease_->handle),
          IID_PPV_ARGS(&shared_)));
      check(shared_.As(&keyed_));
    }
    if (!lease_) return;
    if (!copy_submitted_) {
      const auto acquired = keyed_->AcquireSync(0, 0);
      if (acquired == WAIT_TIMEOUT &&
          std::chrono::steady_clock::now() - began_ < std::chrono::milliseconds(200)) return;
      check(acquired);
      context_->CopyResource(staging_.Get(), shared_.Get());
      // Queue the keyed release after the copy, just like the producer. Keep
      // the logical pool lease until readback completes, but do not hold GPU
      // ownership while polling an asynchronous transfer.
      check(keyed_->ReleaseSync(0));
      context_->Flush();
      copy_submitted_ = true;
      began_ = std::chrono::steady_clock::now();
    }
    D3D11_MAPPED_SUBRESOURCE mapped{};
    const auto result = context_->Map(staging_.Get(), 0, D3D11_MAP_READ,
        D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (result == DXGI_ERROR_WAS_STILL_DRAWING &&
        std::chrono::steady_clock::now() - began_ < std::chrono::milliseconds(200)) return;
    check(result);
    const auto* pixels = static_cast<const std::uint8_t*>(mapped.pData);
    std::uint64_t hash = 1469598103934665603ULL;
    for (unsigned y = 100; y < 600; y += 50)
      for (unsigned x = 100; x < 1200; x += 50)
        hash = (hash ^ pixels[y * mapped.RowPitch + x * 4]) * 1099511628211ULL;
    context_->Unmap(staging_.Get(), 0);
    ++frames;
    if (last_hash_ && hash != *last_hash_) ++content_changes;
    last_hash_ = hash;
    const auto now = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (now >= lease_->timestamp_us)
      maximum_age_us = (std::max)(maximum_age_us, static_cast<std::uint64_t>(now - lease_->timestamp_us));
    if (publication_generation && publication_generation != lease_->publication_generation)
      throw std::runtime_error("Preview publication identity changed during bitrate adaptation");
    publication_generation = lease_->publication_generation;
    if (!screen::LocalScreenPreview::processPreview().release(lease_->generation, lease_->sequence, lease_->slot))
      throw std::runtime_error("Preview readback release failed");
    lease_.reset(); keyed_.Reset(); shared_.Reset(); copy_submitted_ = false;
  }
  void drain() {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
    while (lease_ && std::chrono::steady_clock::now() < deadline) {
      poll(false); std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (lease_) std::terminate();
  }
  std::uint64_t frames = 0, content_changes = 0, maximum_age_us = 0, publication_generation = 0;
 private:
  static void check(HRESULT result) {
    if (result != S_OK) {
      std::cerr << "PREVIEW_OBSERVER_FAILURE {\"platformResult\":" << result << "}" << std::endl;
      throw std::runtime_error("Independent preview pixel readback failed");
    }
  }
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11Device1> device1_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> shared_, staging_;
  Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed_;
  std::optional<screen::PreviewFrame> lease_;
  std::optional<std::uint64_t> last_hash_;
  std::chrono::steady_clock::time_point began_{};
  bool copy_submitted_ = false;
};
}
