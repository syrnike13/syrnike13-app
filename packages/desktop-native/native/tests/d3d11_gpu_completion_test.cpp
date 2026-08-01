#include <d3d11.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "media/d3d11_gpu_completion.hpp"
#include "media/remote_video_texture_pool_policy.hpp"

using Microsoft::WRL::ComPtr;
using syrnike::desktop_native::media::D3d11GpuCompletion;
using syrnike::desktop_native::media::decideD3d11GpuCompletionPoll;
using syrnike::desktop_native::media::decideRemoteVideoSlotTransition;
using syrnike::desktop_native::media::RemoteVideoGpuPollClass;
using syrnike::desktop_native::media::RemoteVideoTextureSlotPhase;

namespace {

void require(HRESULT result, const char* operation) {
  if (SUCCEEDED(result)) return;
  throw std::runtime_error(
      std::string(operation) + " failed (HRESULT " +
      std::to_string(static_cast<std::int32_t>(result)) + ")");
}

}  // namespace

int main() {
  try {
    const auto waiting = decideD3d11GpuCompletionPoll(S_FALSE, false);
    if (waiting.result != S_FALSE || !waiting.pending) {
      throw std::runtime_error("pre-deadline GPU query did not remain pending");
    }
    const auto overdue = decideD3d11GpuCompletionPoll(S_FALSE, true, S_OK);
    if (overdue.result != DXGI_ERROR_WAIT_TIMEOUT || !overdue.pending) {
      throw std::runtime_error("live overdue GPU query was classified as terminal");
    }
    const auto removed = decideD3d11GpuCompletionPoll(
        S_FALSE, true, DXGI_ERROR_DEVICE_REMOVED);
    if (removed.result != DXGI_ERROR_DEVICE_REMOVED || removed.pending) {
      throw std::runtime_error("removed GPU device remained pending");
    }
    const auto quarantined = decideRemoteVideoSlotTransition(
        RemoteVideoTextureSlotPhase::Uploading,
        RemoteVideoGpuPollClass::TimedOut);
    if (quarantined.next != RemoteVideoTextureSlotPhase::Quarantined ||
        !quarantined.newly_quarantined || quarantined.device_failed) {
      throw std::runtime_error("late live-device frame reset the GPU pool");
    }
    const auto still_quarantined = decideRemoteVideoSlotTransition(
        quarantined.next, RemoteVideoGpuPollClass::TimedOut);
    if (still_quarantined.newly_quarantined ||
        still_quarantined.next != RemoteVideoTextureSlotPhase::Quarantined) {
      throw std::runtime_error("quarantined slot was counted repeatedly");
    }
    const auto recovered_slot = decideRemoteVideoSlotTransition(
        still_quarantined.next, RemoteVideoGpuPollClass::Completed);
    if (!recovered_slot.recovered ||
        recovered_slot.next != RemoteVideoTextureSlotPhase::Available) {
      throw std::runtime_error("late GPU completion did not recover its slot");
    }
    const auto failed_slot = decideRemoteVideoSlotTransition(
        RemoteVideoTextureSlotPhase::Uploading,
        RemoteVideoGpuPollClass::Failed);
    if (!failed_slot.device_failed ||
        failed_slot.next != RemoteVideoTextureSlotPhase::Available) {
      throw std::runtime_error("actual GPU failure did not request retirement");
    }
    const auto ready_slot = decideRemoteVideoSlotTransition(
        RemoteVideoTextureSlotPhase::Uploading,
        RemoteVideoGpuPollClass::Completed);
    if (ready_slot.next != RemoteVideoTextureSlotPhase::Ready ||
        ready_slot.newly_quarantined || ready_slot.recovered ||
        ready_slot.device_failed) {
      throw std::runtime_error("completed upload did not become ready");
    }
    const auto delivered_slot = decideRemoteVideoSlotTransition(
        RemoteVideoTextureSlotPhase::Delivered,
        RemoteVideoGpuPollClass::Failed);
    if (delivered_slot.next != RemoteVideoTextureSlotPhase::Delivered ||
        delivered_slot.newly_quarantined || delivered_slot.recovered ||
        delivered_slot.device_failed) {
      throw std::runtime_error("delivered slot was mutated by GPU polling");
    }
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL feature_level{};
    HRESULT result = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        &device, &feature_level, &context);
    if (FAILED(result)) {
      require(
          D3D11CreateDevice(
              nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
              D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
              D3D11_SDK_VERSION, &device, &feature_level, &context),
          "D3D11 test device creation");
    }

    D3d11GpuCompletion completion(device.Get(), context.Get());
    require(completion.initializationResult(), "GPU completion query creation");

    constexpr UINT width = 320;
    constexpr UINT height = 180;
    constexpr UINT bytes_per_pixel = 4;
    std::vector<std::uint8_t> source(
        static_cast<std::size_t>(width) * height * bytes_per_pixel);
    for (UINT y = 0; y < height; ++y) {
      for (UINT x = 0; x < width; ++x) {
        const auto offset =
            (static_cast<std::size_t>(y) * width + x) * bytes_per_pixel;
        source[offset] = static_cast<std::uint8_t>((y * 17U) & 0xffU);
        source[offset + 1] = static_cast<std::uint8_t>((x * 13U) & 0xffU);
        source[offset + 2] = static_cast<std::uint8_t>((x + y) & 0xffU);
        source[offset + 3] = 0xffU;
      }
    }

    D3D11_TEXTURE2D_DESC shared_description{};
    shared_description.Width = width;
    shared_description.Height = height;
    shared_description.MipLevels = 1;
    shared_description.ArraySize = 1;
    shared_description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    shared_description.SampleDesc.Count = 1;
    shared_description.Usage = D3D11_USAGE_DEFAULT;
    shared_description.BindFlags =
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    shared_description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    ComPtr<ID3D11Texture2D> shared_texture;
    require(
        device->CreateTexture2D(
            &shared_description, nullptr, &shared_texture),
        "shared BGRA texture creation");

    D3D11_TEXTURE2D_DESC staging_description = shared_description;
    staging_description.Usage = D3D11_USAGE_STAGING;
    staging_description.BindFlags = 0;
    staging_description.MiscFlags = 0;
    staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging_texture;
    require(
        device->CreateTexture2D(
            &staging_description, nullptr, &staging_texture),
        "staging BGRA texture creation");

    context->UpdateSubresource(
        shared_texture.Get(), 0, nullptr, source.data(),
        width * bytes_per_pixel, 0);
    context->CopyResource(staging_texture.Get(), shared_texture.Get());

    const auto submit_started_at = std::chrono::steady_clock::now();
    require(
        completion.begin(std::chrono::seconds(1)),
        "asynchronous GPU upload submission");
    const auto submit_microseconds =
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - submit_started_at)
            .count();
    if (!completion.pending() || submit_microseconds >= 100'000) {
      throw std::runtime_error(
          "GPU completion submission blocked instead of returning asynchronously");
    }
    if (completion.begin(std::chrono::seconds(1)) != E_PENDING) {
      throw std::runtime_error(
          "GPU completion query accepted overlapping submissions");
    }

    std::uint64_t wait_microseconds = 0;
    std::uint32_t polls = 0;
    for (;;) {
      const HRESULT completion_result = completion.poll(&wait_microseconds);
      ++polls;
      if (completion_result == S_OK) break;
      require(completion_result, "asynchronous GPU upload completion");
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (completion.pending()) {
      throw std::runtime_error(
          "completed GPU query remained marked as pending");
    }

    D3D11_MAPPED_SUBRESOURCE mapped{};
    require(
        context->Map(
            staging_texture.Get(), 0, D3D11_MAP_READ, 0, &mapped),
        "staging texture mapping");
    bool matches = true;
    for (UINT y = 0; y < height; ++y) {
      const auto* actual = static_cast<const std::uint8_t*>(mapped.pData) +
          static_cast<std::size_t>(y) * mapped.RowPitch;
      const auto* expected = source.data() +
          static_cast<std::size_t>(y) * width * bytes_per_pixel;
      if (std::memcmp(actual, expected, width * bytes_per_pixel) != 0) {
        matches = false;
        break;
      }
    }
    context->Unmap(staging_texture.Get(), 0);
    if (!matches) {
      throw std::runtime_error(
          "GPU completion exposed a partially uploaded BGRA frame");
    }

    std::cout << "D3D11 asynchronous GPU completion test passed; submit_us="
              << submit_microseconds << "; completion_us=" << wait_microseconds
              << "; polls=" << polls << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
