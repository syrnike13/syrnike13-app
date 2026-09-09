#include <mfapi.h>
#include <mferror.h>
#include <codecapi.h>
#include <strmif.h>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <thread>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"
#include "fault_evidence.hpp"

// Compile the real encoder in this test translation unit so fault injection
// does not add runtime switches to the shipping utility.
#define private public
#include "screen/hardware_h264_encoder.hpp"
#undef private

std::mutex shutdown_mutex;
std::condition_variable shutdown_changed;
bool block_shutdown = false;
bool shutdown_entered = false;
HRESULT testMFShutdown() {
  {
    std::unique_lock lock(shutdown_mutex);
    shutdown_entered = true;
    shutdown_changed.notify_all();
    shutdown_changed.wait(lock, [] { return !block_shutdown; });
  }
  return MFShutdown();
}
#define MFShutdown testMFShutdown
enum class BitrateTestResult { real, unsupported, rejected };
std::atomic<BitrateTestResult> bitrate_test_result{BitrateTestResult::real};
HRESULT testSetBitrate(ICodecAPI* codec, VARIANT* value) {
  switch (bitrate_test_result.load()) {
    case BitrateTestResult::unsupported: return E_NOTIMPL;
    case BitrateTestResult::rejected: return E_FAIL;
    case BitrateTestResult::real:
      return codec->SetValue(&CODECAPI_AVEncCommonMeanBitRate, value);
  }
  return E_UNEXPECTED;
}
#define WINDOWS_MEDIA_TEST_SET_BITRATE testSetBitrate
std::atomic<bool> withhold_encoder_output{false};
std::mutex output_fault_mutex;
std::condition_variable output_fault_changed;
unsigned withheld_output_events = 0;
HRESULT testEncoderEvent(IMFMediaEventGenerator* generator, IMFMediaEvent** event) {
  const auto result = generator->GetEvent(MF_EVENT_FLAG_NO_WAIT, event);
  if (SUCCEEDED(result) && withhold_encoder_output.load()) {
    MediaEventType type = MEUnknown;
    (void)(*event)->GetType(&type);
    if (type == METransformHaveOutput) {
      (*event)->Release();
      *event = nullptr;
      {
        std::lock_guard lock(output_fault_mutex);
        ++withheld_output_events;
      }
      output_fault_changed.notify_all();
      return MF_E_NO_EVENTS_AVAILABLE;
    }
  }
  return result;
}
#define WINDOWS_MEDIA_TEST_ENCODER_EVENT testEncoderEvent
#include "screen/hardware_h264_encoder.cpp"
#undef MFShutdown
#undef WINDOWS_MEDIA_TEST_SET_BITRATE
#undef WINDOWS_MEDIA_TEST_ENCODER_EVENT
#define private public
#include "screen/production_screen_pipeline.hpp"
#undef private

using namespace syrnike::windows_media::screen;
using namespace std::chrono_literals;

class FaultTestAdapter final : public ScreenPublicationAdapter {
 public:
  std::atomic<std::uint64_t> bandwidth{0};
  std::atomic<std::uint64_t> submitted{0};
  std::atomic<unsigned> published{0};
  syrnike::windows_media::OutgoingNetworkObservation networkObservation() const noexcept override {
    if (!bandwidth.load()) return {};
    return {static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count()), bandwidth.load()};
  }
  std::atomic<bool> unpublished = false;
  void startPublish(std::uint64_t g, ScreenTrackDescriptor,
                    ScreenOperationCompletion cb) override { ++published; cb(g, {}); }
  void startSubmit(std::uint64_t g, EncodedScreenFrame,
                   ScreenOperationCompletion cb) override { ++submitted; cb(g, {}); }
  void startUnpublish(std::uint64_t g,
                      ScreenOperationCompletion cb) override {
    unpublished = true;
    cb(g, {});
  }
};

void pipelinePropagatesEncoderFailure() {
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  auto adapter = std::make_shared<FaultTestAdapter>();
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile720p30,
      [&](const auto&) { return adapter; });
  if (!pipeline.start("fault-test", 5s).ok) throw std::runtime_error("start failed");
  fail(pipeline.encoder_->state_, "screen_hardware_h264_output_stalled", "injected stall",
       "encoder_output");
  const auto deadline = std::chrono::steady_clock::now() + 1s;
  while (!adapter->unpublished && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(1ms);
  if (!adapter->unpublished || pipeline.state() != ProductionScreenPipelineState::failed ||
      !pipeline.failure() || pipeline.failure()->code != "screen_hardware_h264_output_stalled")
    throw std::runtime_error("encoder failure did not terminate publication");
  (void)pipeline.stop(std::chrono::steady_clock::now() + 5s);
}

void shutdownDeadlineIncludesMediaFoundationCleanup() {
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  HardwareH264Encoder encoder(device, kScreenProfile720p30);
  if (encoder.start(5s)) throw std::runtime_error("start failed");
  {
    std::scoped_lock lock(shutdown_mutex);
    block_shutdown = true;
    shutdown_entered = false;
  }
  fail(encoder.state_, "injected_failure", "injected failure", "encoder_output");
  bool entered;
  {
    std::unique_lock lock(shutdown_mutex);
    entered = shutdown_changed.wait_for(lock, 5s, [] { return shutdown_entered; });
  }
  const auto started = std::chrono::steady_clock::now();
  const bool stopped = encoder.stop(30ms);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  {
    std::scoped_lock lock(shutdown_mutex);
    block_shutdown = false;
  }
  shutdown_changed.notify_all();
  (void)encoder.stop(5s);
  if (!entered || stopped || elapsed > 500ms)
    throw std::runtime_error("stop joined a worker still inside MFShutdown");
}

void acceptedInputWithoutOutputTriggersTheRealDeadline() {
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  HardwareH264Encoder encoder(device, kScreenProfile720p30);
  if (encoder.start(5s)) throw std::runtime_error("no-output encoder start failed");
  GpuScreenConverter converter(device, kScreenProfile720p30);
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  D3D11_TEXTURE2D_DESC description{};
  description.Width = 1280;
  description.Height = 720;
  description.MipLevels = description.ArraySize = description.SampleDesc.Count = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  if (FAILED(device->device()->CreateTexture2D(&description, nullptr, &texture)))
    throw std::runtime_error("no-output texture creation failed");
  {
    std::lock_guard lock(output_fault_mutex);
    withheld_output_events = 0;
  }
  withhold_encoder_output = true;
  struct ResetOutputFault { ~ResetOutputFault() { withhold_encoder_output = false; } } reset;
  const auto timestamp = screenSteadyTimestamp100ns();
  auto converted = converter.convert({device, texture.Get()},
      {1, timestamp, 1280, 720, syrnike::windows_media::capture::FramePixelFormat::Bgra8, 1});
  if (!converted || !encoder.submit(std::move(*converted), timestamp / 10, 33'333))
    throw std::runtime_error("no-output input was not submitted");
  {
    std::unique_lock lock(output_fault_mutex);
    if (!output_fault_changed.wait_for(lock, 3s, [] { return withheld_output_events > 0; }))
      throw std::runtime_error("real encoder did not accept input and signal output");
  }
  {
    std::unique_lock lock(encoder.state_->mutex);
    if (encoder.state_->accepted_input_size != 1 || encoder.state_->stats.encoded != 0)
      throw std::runtime_error("no-output fault did not retain the accepted GPU input");
    if (!encoder.state_->changed.wait_for(lock, 2500ms, [&] {
          return encoder.state_->state == HardwareH264EncoderState::failed;
        })) throw std::runtime_error("real no-output detector exceeded its deadline");
  }
  const auto failure = encoder.failure();
  if (!failure || failure->code != "screen_hardware_h264_output_stalled" ||
      encoder.stats().output_stalls != 1 || encoder.stats().encoded != 0)
    throw std::runtime_error("no-output stall was mistaken for an explicit platform error");
  (void)encoder.stop(5s);
  if (encoder.worker_.joinable() || encoder.stats().input_slots_in_use != 0 || encoder.stats().output_slots_in_use != 0)
    throw std::runtime_error("no-output fault did not retire its GPU leases");
}

void failedBitrateControlPreservesWorkingPublication(bool reject_after_success) {
  const ScreenVideoProfile profile{1280, 720, 30, 2'000'000};
  auto device = syrnike::windows_media::capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  auto adapter = std::make_shared<FaultTestAdapter>();
  ProductionScreenPipeline pipeline(device, frames, profile,
      [&](const auto&) { return adapter; });
  if (!pipeline.enableAdaptiveQuality(1U << 1, 1) || !pipeline.start("bitrate-fault", 5s).ok)
    throw std::runtime_error("bitrate fault pipeline start failed");
  GpuScreenConverter converter(device, profile);
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  D3D11_TEXTURE2D_DESC description{};
  description.Width = 1280;
  description.Height = 720;
  description.MipLevels = description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  std::vector<std::uint32_t> pixels(1280 * 720, 0xff305070U);
  const D3D11_SUBRESOURCE_DATA initial{pixels.data(), 1280 * 4, 0};
  if (FAILED(device->device()->CreateTexture2D(&description, &initial, &texture)))
    throw std::runtime_error("bitrate fault fixture creation failed");
  std::uint64_t sequence = 0;
  const auto pumpUntil = [&](const auto& condition, std::chrono::milliseconds budget) {
    const auto deadline = std::chrono::steady_clock::now() + budget;
    while (!condition()) {
      if (std::chrono::steady_clock::now() >= deadline || pipeline.failure())
        throw std::runtime_error("bitrate fault media progress deadline");
      const auto timestamp = screenSteadyTimestamp100ns();
      auto converted = converter.convert({device, texture.Get()},
          {++sequence, timestamp, 1280, 720, syrnike::windows_media::capture::FramePixelFormat::Bgra8, 1});
      if (converted) (void)pipeline.encoder_->submit(std::move(*converted), timestamp / 10, 33333);
      std::this_thread::sleep_for(10ms);
    }
  };
  pumpUntil([&] { return adapter->submitted >= 10; }, 3s);
  const auto instance = pipeline.stats().encoder.instance_id;
  std::uint32_t confirmed = profile.bitrate;
  if (reject_after_success) {
    adapter->bandwidth = 1'750'000;
    pumpUntil([&] { return pipeline.stats().bitrate.outcome == BitrateUpdateOutcome::applied; }, 4s);
    confirmed = pipeline.stats().bitrate.applied_bitrate;
    if (confirmed >= profile.bitrate)
      throw std::runtime_error("live bitrate did not reduce before rejection");
  }
  bitrate_test_result = reject_after_success ? BitrateTestResult::rejected : BitrateTestResult::unsupported;
  adapter->bandwidth = 100'000;
  pumpUntil([&] { return !pipeline.stats().bitrate.available && pipeline.stats().quality_warning; }, 7s);
  const auto updates = pipeline.stats().bitrate_updates;
  const auto progress_before = adapter->submitted.load();
  pumpUntil([&] { return adapter->submitted >= progress_before + 30; }, 3s);
  const auto result = pipeline.stats();
  bitrate_test_result = BitrateTestResult::real;
  if (result.bitrate.applied_bitrate != confirmed || result.encoder.instance_id != instance ||
      result.profile_generation != 1 || result.current_profile != 1 || adapter->published != 1 ||
      adapter->unpublished || result.bitrate_updates != updates ||
      updates != (reject_after_success ? 4U : 1U) || !result.quality_warning)
    throw std::runtime_error("unsupported/rejected update changed media identity, bitrate or retry budget");
  if (!pipeline.stop(std::chrono::steady_clock::now() + 5s).ok || pipeline.stats().quality_warning)
    throw std::runtime_error("bitrate fault stop did not drain/clear warning");
}

void inspectPlatformResourceStage(unsigned stage, bool inline_worker = false) {
  std::exception_ptr error;
  const auto work = [&] {
    try {
      const auto com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      if (FAILED(com)) throw std::runtime_error("MF resource probe COM start failed");
      struct ComScope { ~ComScope() { CoUninitialize(); } } com_scope;
      if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) throw std::runtime_error("MF resource probe startup failed");
      struct MfScope { ~MfScope() { MFShutdown(); } } mf_scope;
      if (stage == 0) return;
      MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
      MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
      ActivationArray candidates;
      if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                          &input, &output, &candidates.values, &candidates.count)) || candidates.count == 0)
        throw std::runtime_error("MF resource probe enumeration failed");
      if (stage == 1) return;
      Microsoft::WRL::ComPtr<IMFTransform> transform;
      if (FAILED(candidates.values[0]->ActivateObject(IID_PPV_ARGS(&transform))))
        throw std::runtime_error("MF resource probe activation failed");
      Microsoft::WRL::ComPtr<IMFDXGIDeviceManager> manager;
      if (stage == 3) {
        Microsoft::WRL::ComPtr<IMFAttributes> attributes;
        UINT token = 0;
        auto device = syrnike::windows_media::capture::processD3d11Device(false);
        if (FAILED(transform->GetAttributes(&attributes)) ||
            FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) ||
            FAILED(MFCreateDXGIDeviceManager(&token, &manager)) ||
            FAILED(manager->ResetDevice(device->device(), token)) ||
            FAILED(transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager.Get()))))
          throw std::runtime_error("MF resource probe device manager failed");
        (void)transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
      }
      const auto shutdown_result = candidates.values[0]->ShutdownObject();
      if (FAILED(shutdown_result)) throw std::runtime_error("MF resource probe activation shutdown failed");
      transform.Reset();
    } catch (...) { error = std::current_exception(); }
  };
  if (inline_worker) work();
  else {
    std::thread worker(work);
    worker.join();
  }
  if (error) std::rethrow_exception(error);
}

int main(int argc, char** argv) try {
  if (argc == 2 && std::string_view(argv[1]) == "--bitrate-unsupported") {
    syrnike::windows_media::tests::repeatFault("encoder-bitrate-unsupported", [] {
      failedBitrateControlPreservesWorkingPublication(false);
    });
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--bitrate-rejected") {
    syrnike::windows_media::tests::repeatFault("encoder-bitrate-rejected", [] {
      failedBitrateControlPreservesWorkingPublication(true);
    });
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--same-thread-activation") {
    syrnike::windows_media::tests::repeatFault("mf-activation-same-thread", [] { inspectPlatformResourceStage(2, true); });
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--resource-stages") {
    for (unsigned stage = 0; stage < 4; ++stage) {
      const std::array names{"mf-startup-shutdown", "mf-enumeration", "mf-activation", "mf-device-manager"};
      syrnike::windows_media::tests::repeatFault(names[stage], [&] { inspectPlatformResourceStage(stage); });
    }
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--startup-only") {
    syrnike::windows_media::tests::repeatFault("encoder-clean-start-stop", [] {
      auto device = syrnike::windows_media::capture::processD3d11Device(false);
      HardwareH264Encoder encoder(device, kScreenProfile720p30);
      if (encoder.start(5s) || !encoder.stop(5s))
        throw std::runtime_error("clean encoder lifecycle failed");
    });
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--no-output-only") {
    syrnike::windows_media::tests::repeatFault("encoder-input-without-output", acceptedInputWithoutOutputTriggersTheRealDeadline);
    return 0;
  }
  failedBitrateControlPreservesWorkingPublication(false);
  failedBitrateControlPreservesWorkingPublication(true);
  pipelinePropagatesEncoderFailure();
  shutdownDeadlineIncludesMediaFoundationCleanup();
  syrnike::windows_media::tests::repeatFault("encoder-input-without-output", acceptedInputWithoutOutputTriggersTheRealDeadline);
  std::cout << "encoder fault tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
