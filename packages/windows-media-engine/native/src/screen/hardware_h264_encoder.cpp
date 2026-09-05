#include "screen/hardware_h264_encoder.hpp"

#include <strmif.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <sstream>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
constexpr auto kOutputProgressDeadline = std::chrono::seconds{2};

struct PendingInput {
  GpuNv12SlotLease frame;
  std::int64_t timestamp_us = 0;
  std::int64_t duration_us = 0;
  std::uint64_t sequence = 0;
  Clock::time_point accepted_at{};
};

struct OutputSlot {
  std::array<std::byte, kEncodedH264SlotBytes> bytes{};
  std::size_t size = 0;
  std::int64_t timestamp_us = 0;
  std::int64_t duration_us = 0;
  std::uint64_t sequence = 0;
  bool keyframe = false;
  bool queued = false;
  bool leased = false;
};

std::string hresultMessage(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " failed with HRESULT 0x" << std::hex
          << static_cast<std::uint32_t>(result);
  return message.str();
}

bool setCodecU32(IMFTransform* transform, const GUID& key,
                 std::uint32_t value) {
  ComPtr<ICodecAPI> codec;
  if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codec)))) return false;
  VARIANT setting{};
  setting.vt = VT_UI4;
  setting.ulVal = value;
  return SUCCEEDED(codec->SetValue(&key, &setting));
}

bool setCodecBool(IMFTransform* transform, const GUID& key, bool value) {
  ComPtr<ICodecAPI> codec;
  if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codec)))) return false;
  VARIANT setting{};
  setting.vt = VT_BOOL;
  setting.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return SUCCEEDED(codec->SetValue(&key, &setting));
}

HRESULT setVideoType(IMFTransform* transform, const ScreenVideoProfile& profile,
                     bool output) {
  ComPtr<IMFMediaType> type;
  HRESULT result = MFCreateMediaType(&type);
  if (SUCCEEDED(result))
    result = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(result))
    result = type->SetGUID(MF_MT_SUBTYPE,
                           output ? MFVideoFormat_H264 : MFVideoFormat_NV12);
  if (SUCCEEDED(result))
    result = MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, profile.width,
                                profile.height);
  if (SUCCEEDED(result))
    result = MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE,
                                 profile.frames_per_second, 1);
  if (SUCCEEDED(result))
    result = MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(result))
    result = type->SetUINT32(MF_MT_INTERLACE_MODE,
                             MFVideoInterlace_Progressive);
  if (SUCCEEDED(result))
    result = type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  if (SUCCEEDED(result))
    result = type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  if (SUCCEEDED(result))
    result = type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  if (SUCCEEDED(result))
    result = type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,
                             MFNominalRange_16_235);
  if (SUCCEEDED(result) && output)
    result = type->SetUINT32(MF_MT_AVG_BITRATE, profile.bitrate);
  if (SUCCEEDED(result) && output)
    result = type->SetUINT32(MF_MT_MPEG2_PROFILE,
                             eAVEncH264VProfile_ConstrainedBase);
  if (SUCCEEDED(result))
    result = output ? transform->SetOutputType(0, type.Get(), 0)
                    : transform->SetInputType(0, type.Get(), 0);
  return result;
}

std::string utf8Name(IMFActivate* activation) {
  WCHAR* wide = nullptr;
  UINT32 length = 0;
  if (FAILED(activation->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &wide,
                                             &length)) ||
      !wide)
    return "hardware H.264 MFT";
  const int required = WideCharToMultiByte(CP_UTF8, 0, wide,
                                            static_cast<int>(length), nullptr,
                                            0, nullptr, nullptr);
  std::string name(static_cast<std::size_t>((std::max)(required, 0)), '\0');
  if (required > 0)
    (void)WideCharToMultiByte(CP_UTF8, 0, wide, static_cast<int>(length),
                              name.data(), required, nullptr, nullptr);
  CoTaskMemFree(wide);
  return name.empty() ? "hardware H.264 MFT" : name;
}

struct ActivationArray {
  IMFActivate** values = nullptr;
  UINT32 count = 0;
  ~ActivationArray() {
    for (UINT32 index = 0; index < count; ++index) values[index]->Release();
    CoTaskMemFree(values);
  }
};

}  // namespace

namespace detail {

struct HardwareH264EncoderStateData {
  explicit HardwareH264EncoderStateData(
      std::shared_ptr<capture::D3d11DeviceOwner> owner,
      ScreenVideoProfile video_profile)
      : device_owner(std::move(owner)), profile(video_profile) {}

  std::shared_ptr<capture::D3d11DeviceOwner> device_owner;
  ScreenVideoProfile profile;
  mutable std::mutex mutex;
  std::condition_variable changed;
  HardwareH264EncoderState state = HardwareH264EncoderState::idle;
  HardwareH264EncoderStats stats;
  std::optional<HardwareH264Failure> failure;
  std::string transform_name;
  std::optional<PendingInput> pending_input;
  std::array<std::optional<PendingInput>, kGpuConversionSlotCapacity>
      accepted_inputs;
  std::size_t accepted_input_head = 0;
  std::size_t accepted_input_size = 0;
  std::array<OutputSlot, kEncodedH264SlotCapacity> outputs;
  std::array<std::uint32_t, kEncodedH264SlotCapacity> queued_outputs{};
  std::size_t queued_output_head = 0;
  std::size_t queued_output_size = 0;
  std::uint64_t next_sequence = 1;
  bool stop_requested = false;
  bool worker_done = false;
  bool keyframe_requested = false;
  Clock::time_point stop_deadline{};

  void clearAcceptedInputs() noexcept {
    for (auto& input : accepted_inputs) input.reset();
    accepted_input_head = 0;
    accepted_input_size = 0;
  }

  bool pushAcceptedInput(PendingInput input) noexcept {
    if (accepted_input_size == accepted_inputs.size()) return false;
    const auto index =
        (accepted_input_head + accepted_input_size) % accepted_inputs.size();
    accepted_inputs[index] = std::move(input);
    ++accepted_input_size;
    return true;
  }

  std::optional<PendingInput> popAcceptedInput() noexcept {
    if (accepted_input_size == 0) return std::nullopt;
    auto result = std::move(accepted_inputs[accepted_input_head]);
    accepted_inputs[accepted_input_head].reset();
    accepted_input_head =
        (accepted_input_head + 1) % accepted_inputs.size();
    --accepted_input_size;
    return result;
  }

  const PendingInput* oldestAcceptedInput() const noexcept {
    return accepted_input_size == 0
               ? nullptr
               : &*accepted_inputs[accepted_input_head];
  }

  bool pushQueuedOutput(std::uint32_t index) noexcept {
    if (queued_output_size == queued_outputs.size()) return false;
    queued_outputs[(queued_output_head + queued_output_size) %
                   queued_outputs.size()] = index;
    ++queued_output_size;
    return true;
  }

  std::optional<std::uint32_t> popQueuedOutput() noexcept {
    if (queued_output_size == 0) return std::nullopt;
    const auto result = queued_outputs[queued_output_head];
    queued_output_head =
        (queued_output_head + 1) % queued_outputs.size();
    --queued_output_size;
    return result;
  }
};

}  // namespace detail

namespace {

void fail(const std::shared_ptr<detail::HardwareH264EncoderStateData>& state,
          std::string code, std::string message, std::string stage) {
  std::scoped_lock lock(state->mutex);
  if (state->state == HardwareH264EncoderState::stopped) return;
  state->failure =
      HardwareH264Failure{std::move(code), std::move(message), std::move(stage)};
  state->state = HardwareH264EncoderState::failed;
  state->pending_input.reset();
  state->clearAcceptedInputs();
  state->changed.notify_all();
}

bool initializeTransform(
    const std::shared_ptr<detail::HardwareH264EncoderStateData>& state,
    ComPtr<IMFActivate>& activation, ComPtr<IMFTransform>& transform,
    ComPtr<IMFMediaEventGenerator>& events,
    ComPtr<IMFDXGIDeviceManager>& manager, MFT_OUTPUT_STREAM_INFO& output_info,
    ComPtr<IMFSample>& caller_output) {
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  ActivationArray candidates;
  HRESULT result = MFTEnumEx(
      MFT_CATEGORY_VIDEO_ENCODER,
      MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &input, &output,
      &candidates.values, &candidates.count);
  if (FAILED(result) || candidates.count == 0) {
    fail(state, "screen_hardware_h264_unavailable",
         FAILED(result) ? hresultMessage("MFTEnumEx", result)
                        : "No hardware H.264 Media Foundation transform found",
         "encoder_start");
    return false;
  }

  for (UINT32 index = 0; index < candidates.count; ++index) {
    transform.Reset();
    if (FAILED(candidates.values[index]->ActivateObject(
            IID_PPV_ARGS(&transform))))
      continue;
    ComPtr<IMFAttributes> attributes;
    UINT32 asynchronous = FALSE;
    if (FAILED(transform->GetAttributes(&attributes)) ||
        FAILED(attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous)) ||
        !asynchronous ||
        FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) ||
        FAILED(attributes->SetUINT32(MF_LOW_LATENCY, TRUE)) ||
        FAILED(transform.As(&events))) {
      (void)candidates.values[index]->ShutdownObject();
      continue;
    }
    UINT manager_token = 0;
    manager.Reset();
    result = MFCreateDXGIDeviceManager(&manager_token, &manager);
    if (SUCCEEDED(result))
      result = manager->ResetDevice(state->device_owner->device(), manager_token);
    if (SUCCEEDED(result))
      result = transform->ProcessMessage(
          MFT_MESSAGE_SET_D3D_MANAGER,
          reinterpret_cast<ULONG_PTR>(manager.Get()));
    if (SUCCEEDED(result)) result = setVideoType(transform.Get(), state->profile, true);
    if (SUCCEEDED(result)) result = setVideoType(transform.Get(), state->profile, false);
    bool configured = SUCCEEDED(result) &&
                      setCodecU32(transform.Get(), CODECAPI_AVLowLatencyMode,
                                  TRUE) &&
                      setCodecU32(transform.Get(),
                                  CODECAPI_AVEncCommonRateControlMode,
                                  eAVEncCommonRateControlMode_CBR) &&
                      setCodecU32(transform.Get(),
                                  CODECAPI_AVEncCommonMeanBitRate,
                                  state->profile.bitrate);
    if (configured)
      (void)setCodecU32(transform.Get(),
                        CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    if (configured)
      configured = SUCCEEDED(transform->GetOutputStreamInfo(0, &output_info));
    if (configured &&
        !(output_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
      ComPtr<IMFMediaBuffer> buffer;
      configured = SUCCEEDED(MFCreateSample(&caller_output)) &&
                   SUCCEEDED(MFCreateMemoryBuffer(
                       static_cast<DWORD>(kEncodedH264SlotBytes), &buffer)) &&
                   SUCCEEDED(caller_output->AddBuffer(buffer.Get()));
    }
    if (configured)
      configured = SUCCEEDED(transform->ProcessMessage(
                       MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) &&
                   SUCCEEDED(transform->ProcessMessage(
                       MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0));
    if (configured) {
      activation = candidates.values[index];
      std::scoped_lock lock(state->mutex);
      state->transform_name = utf8Name(activation.Get());
      if (state->state != HardwareH264EncoderState::failed)
        state->state = HardwareH264EncoderState::running;
      state->changed.notify_all();
      return true;
    }
    (void)candidates.values[index]->ShutdownObject();
  }
  fail(state, "screen_hardware_h264_configuration_failed",
       "No hardware H.264 transform accepted the fixed GPU profile",
       "encoder_start");
  return false;
}

ComPtr<IMFSample> makeInputSample(const PendingInput& input) {
  ComPtr<IMFMediaBuffer> buffer;
  HRESULT result = MFCreateDXGISurfaceBuffer(
      __uuidof(ID3D11Texture2D), input.frame.texture(), 0, FALSE, &buffer);
  ComPtr<IMFSample> sample;
  if (SUCCEEDED(result)) result = MFCreateSample(&sample);
  if (SUCCEEDED(result)) result = sample->AddBuffer(buffer.Get());
  if (SUCCEEDED(result)) result = sample->SetSampleTime(input.timestamp_us * 10);
  if (SUCCEEDED(result))
    result = sample->SetSampleDuration(input.duration_us * 10);
  if (FAILED(result)) return {};
  return sample;
}

std::optional<std::uint32_t> reserveOutput(
    const std::shared_ptr<detail::HardwareH264EncoderStateData>& state) {
  std::scoped_lock lock(state->mutex);
  for (std::uint32_t index = 0; index < state->outputs.size(); ++index) {
    const auto& slot = state->outputs[index];
    if (!slot.queued && !slot.leased) return index;
  }
  if (const auto queued = state->popQueuedOutput()) {
    const auto index = *queued;
    state->outputs[index].queued = false;
    ++state->stats.output_superseded;
    return index;
  }
  ++state->stats.output_pool_exhausted;
  return std::nullopt;
}

void publishOutput(
    const std::shared_ptr<detail::HardwareH264EncoderStateData>& state,
    std::uint32_t slot_index, IMFMediaBuffer* buffer, IMFSample* sample,
    PendingInput input) {
  BYTE* bytes = nullptr;
  DWORD capacity = 0;
  DWORD size = 0;
  HRESULT result = buffer->Lock(&bytes, &capacity, &size);
  if (FAILED(result)) {
    fail(state, "screen_hardware_h264_output_lock_failed",
         hresultMessage("IMFMediaBuffer::Lock", result), "encoder_output");
    return;
  }
  if (size > kEncodedH264SlotBytes) {
    (void)buffer->Unlock();
    std::scoped_lock lock(state->mutex);
    ++state->stats.output_oversized;
    return;
  }
  auto& slot = state->outputs[slot_index];
  std::memcpy(slot.bytes.data(), bytes, size);
  (void)buffer->Unlock();

  LONGLONG sample_time = input.timestamp_us * 10;
  LONGLONG sample_duration = input.duration_us * 10;
  (void)sample->GetSampleTime(&sample_time);
  (void)sample->GetSampleDuration(&sample_duration);
  UINT32 clean_point = FALSE;
  (void)sample->GetUINT32(MFSampleExtension_CleanPoint, &clean_point);

  std::scoped_lock lock(state->mutex);
  slot.size = size;
  slot.timestamp_us = sample_time / 10;
  slot.duration_us = sample_duration / 10;
  slot.sequence = input.sequence;
  slot.keyframe = clean_point != FALSE;
  slot.queued = true;
  if (!state->pushQueuedOutput(slot_index)) {
    slot.queued = false;
    ++state->stats.output_pool_exhausted;
    return;
  }
  ++state->stats.encoded;
  state->stats.encoded_bytes += size;
  if (slot.keyframe) ++state->stats.keyframes;
  std::size_t occupied = 0;
  for (const auto& candidate : state->outputs)
    if (candidate.queued || candidate.leased) ++occupied;
  state->stats.maximum_output_slots_in_use =
      (std::max)(state->stats.maximum_output_slots_in_use, occupied);
  state->changed.notify_all();
}

bool processOneOutput(
    const std::shared_ptr<detail::HardwareH264EncoderStateData>& state,
    IMFTransform* transform, const MFT_OUTPUT_STREAM_INFO& output_info,
    IMFSample* caller_output) {
  MFT_OUTPUT_DATA_BUFFER output{};
  output.dwStreamID = 0;
  output.pSample =
      output_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES ? nullptr
                                                               : caller_output;
  DWORD status = 0;
  const HRESULT result = transform->ProcessOutput(0, 1, &output, &status);
  if (output.pEvents) output.pEvents->Release();
  if (FAILED(result)) {
    fail(state, "screen_hardware_h264_process_output_failed",
         hresultMessage("IMFTransform::ProcessOutput", result),
         "encoder_output");
    if ((output_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) &&
        output.pSample)
      output.pSample->Release();
    return false;
  }

  PendingInput input;
  bool unmatched_output = false;
  {
    std::scoped_lock lock(state->mutex);
    auto accepted = state->popAcceptedInput();
    if (!accepted) {
      unmatched_output = true;
    } else {
      input = std::move(*accepted);
    }
  }
  if (unmatched_output) {
    fail(state, "screen_hardware_h264_unmatched_output",
         "Hardware encoder produced output without a retained input",
         "encoder_output");
    if ((output_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) &&
        output.pSample)
      output.pSample->Release();
    return false;
  }
  const auto slot = reserveOutput(state);
  if (slot && output.pSample) {
    ComPtr<IMFMediaBuffer> buffer;
    const HRESULT buffer_result = output.pSample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(buffer_result)) {
      fail(state, "screen_hardware_h264_output_buffer_failed",
           hresultMessage("IMFSample::ConvertToContiguousBuffer", buffer_result),
           "encoder_output");
    } else {
      publishOutput(state, *slot, buffer.Get(), output.pSample, std::move(input));
    }
  }
  if ((output_info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) &&
      output.pSample)
    output.pSample->Release();
  if (caller_output) {
    ComPtr<IMFMediaBuffer> buffer;
    if (SUCCEEDED(caller_output->GetBufferByIndex(0, &buffer)))
      (void)buffer->SetCurrentLength(0);
  }
  return true;
}

void encoderWorker(
    const std::shared_ptr<detail::HardwareH264EncoderStateData>& state) {
  const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitialize_com = SUCCEEDED(com_result);
  if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
    fail(state, "screen_encoder_com_unavailable",
         hresultMessage("CoInitializeEx", com_result), "encoder_start");
    std::scoped_lock lock(state->mutex);
    state->changed.notify_all();
    return;
  }
  const HRESULT mf_result = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(mf_result)) {
    fail(state, "screen_media_foundation_unavailable",
         hresultMessage("MFStartup", mf_result), "encoder_start");
    if (uninitialize_com) CoUninitialize();
    std::scoped_lock lock(state->mutex);
    state->worker_done = true;
    state->changed.notify_all();
    return;
  }

  ComPtr<IMFActivate> activation;
  ComPtr<IMFTransform> transform;
  ComPtr<IMFMediaEventGenerator> events;
  ComPtr<IMFDXGIDeviceManager> manager;
  ComPtr<IMFSample> caller_output;
  MFT_OUTPUT_STREAM_INFO output_info{};
  if (!initializeTransform(state, activation, transform, events, manager,
                           output_info, caller_output)) {
    (void)MFShutdown();
    if (uninitialize_com) CoUninitialize();
    std::scoped_lock lock(state->mutex);
    state->worker_done = true;
    state->changed.notify_all();
    return;
  }

  std::uint32_t requested_inputs = 0;
  bool draining = false;
  bool done = false;
  while (!done) {
    for (;;) {
      ComPtr<IMFMediaEvent> event;
      const HRESULT event_result =
          events->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
      if (event_result == MF_E_NO_EVENTS_AVAILABLE) break;
      if (FAILED(event_result)) {
        fail(state, "screen_hardware_h264_event_failed",
             hresultMessage("IMFMediaEventGenerator::GetEvent", event_result),
             "encoder_event");
        done = true;
        break;
      }
      MediaEventType type = MEUnknown;
      HRESULT status = S_OK;
      (void)event->GetType(&type);
      (void)event->GetStatus(&status);
      if (FAILED(status)) {
        fail(state, "screen_hardware_h264_event_status_failed",
             hresultMessage("hardware encoder event", status),
             "encoder_event");
        done = true;
        break;
      }
      if (type == METransformNeedInput && !draining) {
        requested_inputs = (std::min)(
            requested_inputs + 1,
            static_cast<std::uint32_t>(kGpuConversionSlotCapacity));
      } else if (type == METransformHaveOutput) {
        if (!processOneOutput(state, transform.Get(), output_info,
                              caller_output.Get())) {
          done = true;
          break;
        }
      } else if (type == METransformDrainComplete) {
        done = true;
        break;
      }
    }
    if (done) break;

    bool request_keyframe = false;
    std::optional<PendingInput> input;
    bool request_stop = false;
    Clock::time_point stop_deadline;
    {
      std::scoped_lock lock(state->mutex);
      request_keyframe = std::exchange(state->keyframe_requested, false);
      if (requested_inputs > 0 && state->pending_input && !draining &&
          state->accepted_input_size < state->accepted_inputs.size()) {
        input = std::move(state->pending_input);
        state->pending_input.reset();
      }
      request_stop = state->stop_requested;
      stop_deadline = state->stop_deadline;
    }
    if (request_keyframe &&
        !setCodecBool(transform.Get(), CODECAPI_AVEncVideoForceKeyFrame, true)) {
      fail(state, "screen_hardware_h264_keyframe_request_failed",
           "Hardware encoder rejected a keyframe request", "encoder_control");
      break;
    }
    if (input) {
      auto sample = makeInputSample(*input);
      const HRESULT input_result =
          sample ? transform->ProcessInput(0, sample.Get(), 0) : E_FAIL;
      if (FAILED(input_result)) {
        fail(state, "screen_hardware_h264_process_input_failed",
             hresultMessage("IMFTransform::ProcessInput", input_result),
             "encoder_input");
        break;
      }
      --requested_inputs;
      bool retained = false;
      {
        std::scoped_lock lock(state->mutex);
        input->accepted_at = Clock::now();
        retained = state->pushAcceptedInput(std::move(*input));
      }
      if (!retained) {
        fail(state, "screen_hardware_h264_input_capacity_exceeded",
             "Hardware encoder exceeded its fixed input capacity",
             "encoder_input");
        break;
      }
    }
    if (request_stop && !draining) {
      {
        std::scoped_lock lock(state->mutex);
        state->pending_input.reset();
        state->state = HardwareH264EncoderState::draining;
        state->changed.notify_all();
      }
      draining = true;
      requested_inputs = 0;
      HRESULT result = transform->ProcessMessage(
          MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      if (SUCCEEDED(result))
        result = transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
      if (FAILED(result)) {
        fail(state, "screen_hardware_h264_drain_failed",
             hresultMessage("IMFTransform drain", result), "encoder_stop");
        break;
      }
    }
    if (draining && Clock::now() >= stop_deadline) {
      fail(state, "screen_hardware_h264_drain_timeout",
           "Hardware encoder did not drain before the stop deadline",
           "encoder_stop");
      break;
    }
    bool output_stalled = false;
    {
      std::scoped_lock lock(state->mutex);
      const auto* oldest = state->oldestAcceptedInput();
      output_stalled = oldest &&
                       Clock::now() - oldest->accepted_at >=
                           kOutputProgressDeadline;
      if (output_stalled) ++state->stats.output_stalls;
    }
    if (output_stalled) {
      fail(state, "screen_hardware_h264_output_stalled",
           "Hardware encoder made no output progress before its deadline",
           "encoder_output");
      break;
    }
    std::unique_lock lock(state->mutex);
    state->changed.wait_for(lock, std::chrono::milliseconds(1));
  }

  (void)transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  {
    std::scoped_lock lock(state->mutex);
    state->pending_input.reset();
    state->clearAcceptedInputs();
    if (state->state != HardwareH264EncoderState::failed)
      state->state = HardwareH264EncoderState::stopped;
    state->worker_done = true;
    state->changed.notify_all();
  }
  ComPtr<IMFShutdown> shutdown;
  if (SUCCEEDED(transform.As(&shutdown))) (void)shutdown->Shutdown();
  (void)activation->ShutdownObject();
  caller_output.Reset();
  events.Reset();
  transform.Reset();
  manager.Reset();
  activation.Reset();
  shutdown.Reset();
  (void)MFShutdown();
  if (uninitialize_com) CoUninitialize();
  {
    std::scoped_lock lock(state->mutex);
    state->worker_done = true;
    state->changed.notify_all();
  }
}

}  // namespace

EncodedH264SlotLease::EncodedH264SlotLease(
    std::shared_ptr<detail::HardwareH264EncoderStateData> state,
    std::uint32_t slot)
    : state_(std::move(state)), slot_(slot) {}

EncodedH264SlotLease::~EncodedH264SlotLease() { release(); }

EncodedH264SlotLease::EncodedH264SlotLease(
    EncodedH264SlotLease&& other) noexcept
    : state_(std::move(other.state_)), slot_(other.slot_) {}

EncodedH264SlotLease& EncodedH264SlotLease::operator=(
    EncodedH264SlotLease&& other) noexcept {
  if (this == &other) return *this;
  release();
  state_ = std::move(other.state_);
  slot_ = other.slot_;
  return *this;
}

EncodedH264SlotLease::operator bool() const noexcept { return !!state_; }

std::uint32_t EncodedH264SlotLease::slot() const noexcept { return slot_; }

EncodedH264FrameView EncodedH264SlotLease::frame() const noexcept {
  if (!state_) return {};
  std::scoped_lock lock(state_->mutex);
  const auto& slot = state_->outputs[slot_];
  return {{slot.bytes.data(), slot.size}, slot.timestamp_us, slot.duration_us,
          slot.keyframe, slot.sequence};
}

void EncodedH264SlotLease::release() noexcept {
  if (!state_) return;
  {
    std::scoped_lock lock(state_->mutex);
    state_->outputs[slot_].leased = false;
    state_->changed.notify_all();
  }
  state_.reset();
}

HardwareH264Encoder::HardwareH264Encoder(
    std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
    ScreenVideoProfile profile)
    : state_(std::make_shared<detail::HardwareH264EncoderStateData>(
          std::move(device_owner), profile)) {}

HardwareH264Encoder::~HardwareH264Encoder() {
  const bool stopped = stop(std::chrono::seconds(2));
  if (!worker_.joinable()) return;
  bool worker_done = false;
  {
    std::scoped_lock lock(state_->mutex);
    worker_done = state_->worker_done;
  }
  if (stopped || worker_done)
    worker_.join();
  else
    worker_.detach();
}

std::optional<HardwareH264Failure> HardwareH264Encoder::start(
    std::chrono::milliseconds deadline) {
  {
    std::scoped_lock lock(state_->mutex);
    if (!state_->device_owner || state_->profile.width == 0 ||
        state_->profile.height == 0 || state_->profile.frames_per_second == 0 ||
        state_->profile.bitrate == 0) {
      state_->failure = HardwareH264Failure{
          "screen_hardware_h264_encoder_invalid",
          "Hardware encoder requires a D3D11 device and fixed profile",
          "encoder_start"};
      state_->state = HardwareH264EncoderState::failed;
      return state_->failure;
    }
    if (state_->state != HardwareH264EncoderState::idle)
      return HardwareH264Failure{
          "screen_hardware_h264_encoder_invalid_state",
          "Hardware encoder can only start once", "encoder_start"};
    state_->state = HardwareH264EncoderState::starting;
  }
  worker_ = std::thread(encoderWorker, state_);
  std::unique_lock lock(state_->mutex);
  const bool completed = state_->changed.wait_for(lock, deadline, [&] {
    return state_->state == HardwareH264EncoderState::running ||
           state_->state == HardwareH264EncoderState::failed;
  });
  if (!completed) {
    state_->failure = HardwareH264Failure{
        "screen_hardware_h264_start_timeout",
        "Hardware encoder did not start before the deadline", "encoder_start"};
    state_->stop_requested = true;
    state_->state = HardwareH264EncoderState::failed;
    state_->stop_deadline = Clock::now() + deadline;
    state_->changed.notify_all();
    return state_->failure;
  }
  return state_->failure;
}

bool HardwareH264Encoder::submit(GpuNv12SlotLease frame,
                                 std::int64_t timestamp_us,
                                 std::int64_t duration_us) {
  if (!frame) return false;
  std::scoped_lock lock(state_->mutex);
  if (state_->state != HardwareH264EncoderState::running) return false;
  ++state_->stats.submitted;
  if (state_->pending_input) ++state_->stats.input_superseded;
  state_->pending_input = PendingInput{std::move(frame), timestamp_us,
                                       duration_us, state_->next_sequence++};
  state_->changed.notify_all();
  return true;
}

std::optional<EncodedH264SlotLease> HardwareH264Encoder::takeEncoded() {
  std::scoped_lock lock(state_->mutex);
  const auto queued = state_->popQueuedOutput();
  if (!queued) return std::nullopt;
  const auto index = *queued;
  state_->outputs[index].queued = false;
  state_->outputs[index].leased = true;
  return EncodedH264SlotLease(state_, index);
}

void HardwareH264Encoder::requestKeyFrame() noexcept {
  std::scoped_lock lock(state_->mutex);
  if (state_->state != HardwareH264EncoderState::running) return;
  state_->keyframe_requested = true;
  state_->changed.notify_all();
}

bool HardwareH264Encoder::stop(std::chrono::milliseconds deadline) noexcept {
  std::optional<bool> terminal_result;
  {
    std::scoped_lock lock(state_->mutex);
    if (state_->state == HardwareH264EncoderState::idle) {
      state_->state = HardwareH264EncoderState::stopped;
      state_->worker_done = true;
      terminal_result = true;
    }
    if (state_->state == HardwareH264EncoderState::stopped &&
        state_->worker_done)
      terminal_result = true;
    if (state_->state == HardwareH264EncoderState::failed &&
        state_->worker_done)
      terminal_result = false;
    if (!terminal_result) {
      state_->stop_requested = true;
      state_->stop_deadline = Clock::now() + deadline;
      state_->changed.notify_all();
    }
  }
  if (terminal_result) {
    if (worker_.joinable()) worker_.join();
    return *terminal_result;
  }
  std::unique_lock lock(state_->mutex);
  const bool completed = state_->changed.wait_for(lock, deadline, [&] {
    return state_->worker_done &&
           (state_->state == HardwareH264EncoderState::stopped ||
            state_->state == HardwareH264EncoderState::failed);
  });
  const bool stopped = completed &&
                       state_->state == HardwareH264EncoderState::stopped;
  lock.unlock();
  if (completed && worker_.joinable()) worker_.join();
  return stopped;
}

HardwareH264EncoderState HardwareH264Encoder::state() const noexcept {
  std::scoped_lock lock(state_->mutex);
  return state_->state;
}

HardwareH264EncoderStats HardwareH264Encoder::stats() const noexcept {
  std::scoped_lock lock(state_->mutex);
  auto result = state_->stats;
  result.input_slots_in_use = state_->accepted_input_size +
                              static_cast<std::size_t>(
                                  state_->pending_input.has_value());
  result.output_slots_in_use = static_cast<std::size_t>(std::count_if(
      state_->outputs.begin(), state_->outputs.end(),
      [](const auto& slot) { return slot.queued || slot.leased; }));
  return result;
}

std::optional<HardwareH264Failure> HardwareH264Encoder::failure() const {
  std::scoped_lock lock(state_->mutex);
  return state_->failure;
}

std::string HardwareH264Encoder::transformName() const {
  std::scoped_lock lock(state_->mutex);
  return state_->transform_name;
}

}  // namespace syrnike::windows_media::screen
