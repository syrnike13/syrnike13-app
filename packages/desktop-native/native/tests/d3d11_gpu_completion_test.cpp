#include <d3d11.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
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
#include "media/gpu_completion_slot_policy.hpp"
#include "media/remote_video_texture_pool_policy.hpp"

using Microsoft::WRL::ComPtr;
using syrnike::desktop_native::media::D3d11GpuCompletion;
using syrnike::desktop_native::media::decideD3d11GpuCompletionPoll;
using syrnike::desktop_native::media::decideGpuCompletionSlotTransition;
using syrnike::desktop_native::media::GpuCompletionPollClass;
using syrnike::desktop_native::media::GpuCompletionSlotState;
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
    const auto sender_quarantine = decideGpuCompletionSlotTransition(
        GpuCompletionSlotState::Pending,
        GpuCompletionPollClass::TimedOut);
    if (!sender_quarantine.keep_pending ||
        !sender_quarantine.newly_quarantined ||
        sender_quarantine.next != GpuCompletionSlotState::Quarantined) {
      throw std::runtime_error("sender timeout did not quarantine one slot");
    }
    const auto sender_recovery = decideGpuCompletionSlotTransition(
        sender_quarantine.next,
        GpuCompletionPollClass::Completed);
    if (!sender_recovery.recovered_stale ||
        !sender_recovery.completed || sender_recovery.device_failed) {
      throw std::runtime_error("sender late completion was published or fatal");
    }
    const auto sender_device_failure = decideGpuCompletionSlotTransition(
        GpuCompletionSlotState::Quarantined,
        GpuCompletionPollClass::DeviceFailed);
    if (!sender_device_failure.device_failed ||
        sender_device_failure.keep_pending) {
      throw std::runtime_error("sender device failure remained quarantined");
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

    ComPtr<IDXGIDevice> producer_dxgi;
    require(device.As(&producer_dxgi), "producer IDXGIDevice query");
    ComPtr<IDXGIAdapter> adapter;
    require(producer_dxgi->GetAdapter(&adapter), "producer adapter query");
    ComPtr<ID3D11Device> consumer_device;
    ComPtr<ID3D11DeviceContext> consumer_context;
    require(
        D3D11CreateDevice(
            adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
            D3D11_SDK_VERSION, &consumer_device, &feature_level,
            &consumer_context),
        "consumer D3D11 device creation");
    D3D11_TEXTURE2D_DESC bridge_description{};
    bridge_description.Width = width;
    bridge_description.Height = height;
    bridge_description.MipLevels = 1;
    bridge_description.ArraySize = 1;
    bridge_description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    bridge_description.SampleDesc.Count = 1;
    bridge_description.Usage = D3D11_USAGE_DEFAULT;
    bridge_description.BindFlags =
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    bridge_description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
        D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    ComPtr<ID3D11Texture2D> producer_bridge;
    require(
        device->CreateTexture2D(
            &bridge_description, nullptr, &producer_bridge),
        "producer keyed bridge creation");
    ComPtr<IDXGIKeyedMutex> producer_mutex;
    require(producer_bridge.As(&producer_mutex), "producer keyed mutex query");
    ComPtr<IDXGIResource1> bridge_resource;
    require(producer_bridge.As(&bridge_resource), "bridge resource query");
    HANDLE bridge_handle = nullptr;
    require(
        bridge_resource->CreateSharedHandle(
            nullptr,
            DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
            nullptr,
            &bridge_handle),
        "bridge handle creation");
    ComPtr<ID3D11Device1> consumer_device1;
    require(consumer_device.As(&consumer_device1), "consumer device1 query");
    ComPtr<ID3D11Texture2D> consumer_bridge;
    require(
        consumer_device1->OpenSharedResource1(
            bridge_handle, IID_PPV_ARGS(&consumer_bridge)),
        "consumer bridge open");
    ComPtr<IDXGIKeyedMutex> consumer_mutex;
    require(consumer_bridge.As(&consumer_mutex), "consumer keyed mutex query");
    require(producer_mutex->AcquireSync(0, 0), "producer bridge acquire");
    context->UpdateSubresource(
        producer_bridge.Get(), 0, nullptr, source.data(), width * 4, 0);
    require(producer_mutex->ReleaseSync(1), "producer bridge release");
    context->Flush();
    require(consumer_mutex->AcquireSync(1, 1'000), "consumer bridge acquire");
    D3D11_TEXTURE2D_DESC bridge_staging_description = bridge_description;
    bridge_staging_description.Usage = D3D11_USAGE_STAGING;
    bridge_staging_description.BindFlags = 0;
    bridge_staging_description.MiscFlags = 0;
    bridge_staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> bridge_staging;
    require(
        consumer_device->CreateTexture2D(
            &bridge_staging_description, nullptr, &bridge_staging),
        "consumer bridge staging creation");
    consumer_context->CopyResource(bridge_staging.Get(), consumer_bridge.Get());
    D3D11_MAPPED_SUBRESOURCE mapped_bridge{};
    require(
        consumer_context->Map(
            bridge_staging.Get(), 0, D3D11_MAP_READ, 0, &mapped_bridge),
        "consumer bridge readback");
    for (UINT y = 0; y < height; ++y) {
      const auto* actual = static_cast<const std::uint8_t*>(
          mapped_bridge.pData) + static_cast<std::size_t>(y) * mapped_bridge.RowPitch;
      const auto* expected = source.data() +
          static_cast<std::size_t>(y) * width * bytes_per_pixel;
      if (std::memcmp(actual, expected, width * bytes_per_pixel) != 0) {
        consumer_context->Unmap(bridge_staging.Get(), 0);
        throw std::runtime_error(
            "cross-device keyed bridge changed the uploaded pixels");
      }
    }
    consumer_context->Unmap(bridge_staging.Get(), 0);
    require(consumer_mutex->ReleaseSync(0), "consumer bridge release");
    CloseHandle(bridge_handle);

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
