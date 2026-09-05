#include "screen/gpu_screen_converter.hpp"

#include <d3d11_4.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <utility>

#include "screen/screen_frame_marker.hpp"
#include "screen/screen_frame_pipeline.hpp"

namespace syrnike::windows_media::screen {
namespace detail {

using Microsoft::WRL::ComPtr;

struct GpuScreenConverterState final {
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    ComPtr<ID3D11Query> timing_disjoint;
    ComPtr<ID3D11Query> timing_start;
    ComPtr<ID3D11Query> timing_end;
    bool in_use = false;
    bool timing_pending = false;
  };

  struct InputViewEntry {
    ID3D11Texture2D* texture = nullptr;
    ComPtr<ID3D11VideoProcessorInputView> view;
  };

  std::mutex mutex;
  std::shared_ptr<capture::D3d11DeviceOwner> owner;
  ScreenVideoProfile profile;
  bool lab_frame_marker = false;
  ComPtr<ID3D11VideoDevice> video_device;
  ComPtr<ID3D11VideoContext> video_context;
  ComPtr<ID3D11VideoContext1> video_context1;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  ComPtr<ID3D11VideoProcessor> processor;
  ComPtr<ID3D11Texture2D> marker_texture;
  ComPtr<ID3D11VideoProcessorInputView> marker_input_view;
  std::array<std::uint8_t, kScreenMarkerBgraBytes> marker_bgra{};
  std::array<Slot, kGpuConversionSlotCapacity> slots;
  std::array<InputViewEntry, 4> input_views;
  std::size_t next_input_view = 0;
  std::uint32_t input_width = 0;
  std::uint32_t input_height = 0;
  GpuScreenConverterStats stats;
};

}  // namespace detail
namespace {

using Microsoft::WRL::ComPtr;

bool validProfile(const ScreenVideoProfile& profile) {
  return profile.width != 0 && profile.height != 0 &&
         (profile.width % 2) == 0 && (profile.height % 2) == 0 &&
         profile.frames_per_second != 0 && profile.frames_per_second <= 60 &&
         profile.bitrate != 0;
}

bool anySlotInUse(const detail::GpuScreenConverterState& state) {
  return std::any_of(state.slots.begin(), state.slots.end(),
                     [](const auto& slot) { return slot.in_use; });
}

std::runtime_error gpuError(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " failed with HRESULT 0x" << std::hex
          << static_cast<std::uint32_t>(result);
  return std::runtime_error(message.str());
}

std::size_t slotsInUse(const detail::GpuScreenConverterState& state) {
  return static_cast<std::size_t>(std::count_if(
      state.slots.begin(), state.slots.end(),
      [](const auto& slot) { return slot.in_use; }));
}

bool collectTiming(detail::GpuScreenConverterState& state,
                   detail::GpuScreenConverterState::Slot& slot) noexcept {
  if (!slot.timing_pending) return true;
  D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};
  UINT64 started = 0;
  UINT64 finished = 0;
  const auto flags = D3D11_ASYNC_GETDATA_DONOTFLUSH;
  std::lock_guard context_lock(state.owner->contextMutex());
  const auto disjoint_result = state.owner->context()->GetData(
      slot.timing_disjoint.Get(), &disjoint, sizeof(disjoint), flags);
  const auto start_result = state.owner->context()->GetData(
      slot.timing_start.Get(), &started, sizeof(started), flags);
  const auto end_result = state.owner->context()->GetData(
      slot.timing_end.Get(), &finished, sizeof(finished), flags);
  if (disjoint_result == S_FALSE || start_result == S_FALSE ||
      end_result == S_FALSE)
    return false;
  slot.timing_pending = false;
  if (FAILED(disjoint_result) || FAILED(start_result) || FAILED(end_result) ||
      disjoint.Disjoint || disjoint.Frequency == 0 ||
      finished < started) {
    ++state.stats.gpu_timing_unavailable;
    return true;
  }
  const auto duration_us = static_cast<std::uint64_t>(
      static_cast<long double>(finished - started) * 1'000'000.0L /
      static_cast<long double>(disjoint.Frequency));
  ++state.stats.gpu_timing_measurements;
  state.stats.gpu_duration_total_us += duration_us;
  state.stats.gpu_duration_last_us = duration_us;
  state.stats.gpu_duration_max_us =
      (std::max)(state.stats.gpu_duration_max_us, duration_us);
  return true;
}

bool configureProcessor(detail::GpuScreenConverterState& state,
                        std::uint32_t input_width,
                        std::uint32_t input_height) {
  if (anySlotInUse(state)) return false;
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
  content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  content.InputFrameRate = {state.profile.frames_per_second, 1};
  content.InputWidth = input_width;
  content.InputHeight = input_height;
  content.OutputFrameRate = {state.profile.frames_per_second, 1};
  content.OutputWidth = state.profile.width;
  content.OutputHeight = state.profile.height;
  content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  const HRESULT enumerator_result =
      state.video_device->CreateVideoProcessorEnumerator(&content, &enumerator);
  if (FAILED(enumerator_result))
    throw gpuError("CreateVideoProcessorEnumerator", enumerator_result);
  ComPtr<ID3D11VideoProcessor> processor;
  const HRESULT processor_result = state.video_device->CreateVideoProcessor(
      enumerator.Get(), 0, &processor);
  if (FAILED(processor_result))
    throw gpuError("CreateVideoProcessor", processor_result);
  D3D11_VIDEO_PROCESSOR_CAPS capabilities{};
  if (FAILED(enumerator->GetVideoProcessorCaps(&capabilities)) ||
      capabilities.MaxInputStreams < (state.lab_frame_marker ? 2U : 1U))
    throw std::runtime_error(
        "D3D11 video processor lacks the required input streams");

  ComPtr<ID3D11Texture2D> marker;
  ComPtr<ID3D11VideoProcessorInputView> marker_view;
  if (state.lab_frame_marker) {
    D3D11_TEXTURE2D_DESC marker_texture{};
    marker_texture.Width = input_width;
    marker_texture.Height = input_height;
    marker_texture.MipLevels = 1;
    marker_texture.ArraySize = 1;
    marker_texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    marker_texture.SampleDesc.Count = 1;
    marker_texture.Usage = D3D11_USAGE_DEFAULT;
    marker_texture.BindFlags =
        D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    if (FAILED(state.owner->device()->CreateTexture2D(&marker_texture, nullptr, &marker)))
      throw std::runtime_error("observer marker texture allocation failed");
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC marker_input{};
    marker_input.FourCC = 0;
    marker_input.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    marker_input.Texture2D.MipSlice = 0;
    marker_input.Texture2D.ArraySlice = 0;
    const HRESULT marker_result = state.video_device->CreateVideoProcessorInputView(
        marker.Get(), enumerator.Get(), &marker_input, &marker_view);
    if (FAILED(marker_result))
      throw gpuError("CreateVideoProcessorInputView(marker)", marker_result);
  }

  for (auto& slot : state.slots) {
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output{};
    output.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    output.Texture2D.MipSlice = 0;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    const HRESULT output_result =
        state.video_device->CreateVideoProcessorOutputView(
            slot.texture.Get(), enumerator.Get(), &output, &output_view);
    if (FAILED(output_result))
      throw gpuError("CreateVideoProcessorOutputView", output_result);
    slot.output_view = std::move(output_view);
  }
  for (auto& entry : state.input_views) entry = {};
  state.next_input_view = 0;
  state.enumerator = std::move(enumerator);
  state.processor = std::move(processor);
  state.marker_texture = std::move(marker);
  state.marker_input_view = std::move(marker_view);
  state.input_width = input_width;
  state.input_height = input_height;
  state.stats.texture_bytes =
      static_cast<std::uint64_t>(state.profile.width) *
          state.profile.height * 3ULL / 2ULL * kGpuConversionSlotCapacity +
      (state.lab_frame_marker
           ? static_cast<std::uint64_t>(input_width) * input_height * 4ULL : 0ULL);
  ++state.stats.processor_reconfigurations;
  return true;
}

ID3D11VideoProcessorInputView* inputView(
    detail::GpuScreenConverterState& state, ID3D11Texture2D* texture) {
  for (auto& entry : state.input_views) {
    if (entry.texture == texture) return entry.view.Get();
  }
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input{};
  input.FourCC = 0;
  input.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  input.Texture2D.MipSlice = 0;
  input.Texture2D.ArraySlice = 0;
  auto& entry = state.input_views[state.next_input_view];
  entry = {};
  const HRESULT result = state.video_device->CreateVideoProcessorInputView(
      texture, state.enumerator.Get(), &input, &entry.view);
  if (FAILED(result)) throw gpuError("CreateVideoProcessorInputView", result);
  entry.texture = texture;
  state.next_input_view =
      (state.next_input_view + 1) % state.input_views.size();
  return entry.view.Get();
}

RECT evenCenterCrop(std::uint32_t input_width, std::uint32_t input_height,
                    std::uint32_t output_width,
                    std::uint32_t output_height) {
  std::uint32_t crop_width = input_width;
  std::uint32_t crop_height = input_height;
  if (static_cast<std::uint64_t>(input_width) * output_height >
      static_cast<std::uint64_t>(input_height) * output_width) {
    crop_width = static_cast<std::uint32_t>(
        static_cast<std::uint64_t>(input_height) * output_width /
        output_height);
  } else {
    crop_height = static_cast<std::uint32_t>(
        static_cast<std::uint64_t>(input_width) * output_height /
        output_width);
  }
  crop_width = (std::max)(2U, crop_width & ~1U);
  crop_height = (std::max)(2U, crop_height & ~1U);
  const auto left = ((input_width - crop_width) / 2U) & ~1U;
  const auto top = ((input_height - crop_height) / 2U) & ~1U;
  return {static_cast<LONG>(left), static_cast<LONG>(top),
          static_cast<LONG>(left + crop_width),
          static_cast<LONG>(top + crop_height)};
}

}  // namespace

GpuNv12SlotLease::GpuNv12SlotLease(
    std::shared_ptr<detail::GpuScreenConverterState> state,
    std::uint32_t slot)
    : state_(std::move(state)), slot_(slot) {}

GpuNv12SlotLease::~GpuNv12SlotLease() { release(); }

GpuNv12SlotLease::GpuNv12SlotLease(GpuNv12SlotLease&& other) noexcept
    : state_(std::move(other.state_)), slot_(other.slot_) {}

GpuNv12SlotLease& GpuNv12SlotLease::operator=(
    GpuNv12SlotLease&& other) noexcept {
  if (this == &other) return *this;
  release();
  state_ = std::move(other.state_);
  slot_ = other.slot_;
  return *this;
}

GpuNv12SlotLease::operator bool() const noexcept { return state_ != nullptr; }

std::uint32_t GpuNv12SlotLease::slot() const noexcept { return slot_; }

ID3D11Texture2D* GpuNv12SlotLease::texture() const noexcept {
  if (!state_ || slot_ >= state_->slots.size()) return nullptr;
  return state_->slots[slot_].texture.Get();
}

void GpuNv12SlotLease::release() noexcept {
  if (!state_) return;
  {
    std::lock_guard lock(state_->mutex);
    if (slot_ < state_->slots.size()) {
      auto& slot = state_->slots[slot_];
      collectTiming(*state_, slot);
      slot.in_use = false;
      state_->stats.slots_in_use = slotsInUse(*state_);
    }
  }
  state_.reset();
}

GpuScreenConverter::GpuScreenConverter(
    std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
    ScreenVideoProfile profile, bool lab_frame_marker)
    : state_(std::make_shared<detail::GpuScreenConverterState>()) {
  if (!device_owner || !validProfile(profile))
    throw std::invalid_argument("GPU screen converter configuration is invalid");
  state_->owner = std::move(device_owner);
  state_->profile = profile;
  state_->lab_frame_marker = lab_frame_marker;
  if (FAILED(state_->owner->device()->QueryInterface(
          IID_PPV_ARGS(&state_->video_device))) ||
      FAILED(state_->owner->context()->QueryInterface(
          IID_PPV_ARGS(&state_->video_context)))) {
    throw std::runtime_error("D3D11 video processor interfaces are unavailable");
  }
  (void)state_->video_context.As(&state_->video_context1);

  D3D11_TEXTURE2D_DESC texture{};
  texture.Width = profile.width;
  texture.Height = profile.height;
  texture.MipLevels = 1;
  texture.ArraySize = 1;
  texture.Format = DXGI_FORMAT_NV12;
  texture.SampleDesc.Count = 1;
  texture.Usage = D3D11_USAGE_DEFAULT;
  texture.BindFlags = D3D11_BIND_RENDER_TARGET;
  for (auto& slot : state_->slots) {
    if (FAILED(state_->owner->device()->CreateTexture2D(
            &texture, nullptr, &slot.texture)))
      throw std::runtime_error("NV12 conversion slot allocation failed");
    D3D11_QUERY_DESC query{};
    query.Query = D3D11_QUERY_TIMESTAMP_DISJOINT;
    if (FAILED(state_->owner->device()->CreateQuery(
            &query, &slot.timing_disjoint)))
      throw std::runtime_error("GPU conversion timing allocation failed");
    query.Query = D3D11_QUERY_TIMESTAMP;
    if (FAILED(state_->owner->device()->CreateQuery(&query,
                                                     &slot.timing_start)) ||
        FAILED(state_->owner->device()->CreateQuery(&query,
                                                     &slot.timing_end)))
      throw std::runtime_error("GPU conversion timing allocation failed");
  }
  state_->stats.texture_bytes =
      static_cast<std::uint64_t>(profile.width) * profile.height * 3ULL / 2ULL *
      kGpuConversionSlotCapacity;
}

GpuScreenConverter::~GpuScreenConverter() = default;

std::optional<GpuNv12SlotLease> GpuScreenConverter::convert(
    const capture::D3d11FrameView& frame,
    const capture::FrameMetadata& metadata) {
  std::lock_guard state_lock(state_->mutex);
  ++state_->stats.submitted;
  if (!frame || frame.device_owner.get() != state_->owner.get() ||
      frame.device_owner->adapterLuid() != state_->owner->adapterLuid()) {
    ++state_->stats.adapter_mismatches;
    return std::nullopt;
  }
  if (metadata.width < 2 || metadata.height < 2 ||
      metadata.format != capture::FramePixelFormat::Bgra8)
    return std::nullopt;
  if ((!state_->processor || metadata.width != state_->input_width ||
       metadata.height != state_->input_height) &&
      !configureProcessor(*state_, metadata.width, metadata.height)) {
    return std::nullopt;
  }

  auto found = std::find_if(state_->slots.begin(), state_->slots.end(),
                            [](const auto& slot) { return !slot.in_use; });
  if (found == state_->slots.end()) {
    ++state_->stats.pool_exhausted;
    return std::nullopt;
  }
  const auto slot_index = static_cast<std::uint32_t>(
      std::distance(state_->slots.begin(), found));
  if (found->timing_pending && !collectTiming(*state_, *found)) {
    found->timing_pending = false;
    ++state_->stats.gpu_timing_unavailable;
  }
  found->in_use = true;
  state_->stats.slots_in_use = slotsInUse(*state_);
  state_->stats.maximum_in_use =
      (std::max)(state_->stats.maximum_in_use, slotsInUse(*state_));

  bool converted = false;
  {
    std::lock_guard context_lock(state_->owner->contextMutex());
    auto* input_view = inputView(*state_, frame.texture);
    if (input_view) {
      const bool include_marker = state_->lab_frame_marker && metadata.width >= kScreenMarkerWidth &&
                                  metadata.height >= kScreenMarkerHeight;
      if (include_marker) {
        writeScreenFrameMarker(
            state_->marker_bgra, kScreenMarkerWidth * 4, metadata.sequence,
            captureTimestampEpochMilliseconds(
                metadata.capture_timestamp_100ns),
            metadata.generation, metadata.width, metadata.height);
        const D3D11_BOX marker_box{
            0, 0, 0, static_cast<UINT>(kScreenMarkerWidth),
            static_cast<UINT>(kScreenMarkerHeight), 1};
        state_->owner->context()->UpdateSubresource(
            state_->marker_texture.Get(), 0, &marker_box,
            state_->marker_bgra.data(),
            static_cast<UINT>(kScreenMarkerWidth * 4), 0);
      }
      const auto source = evenCenterCrop(
          metadata.width, metadata.height, state_->profile.width,
          state_->profile.height);
      const RECT destination{0, 0, static_cast<LONG>(state_->profile.width),
                             static_cast<LONG>(state_->profile.height)};
      state_->video_context->VideoProcessorSetStreamFrameFormat(
          state_->processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
      state_->video_context->VideoProcessorSetStreamSourceRect(
          state_->processor.Get(), 0, TRUE, &source);
      state_->video_context->VideoProcessorSetStreamDestRect(
          state_->processor.Get(), 0, TRUE, &destination);
      const RECT marker_source{0, 0, static_cast<LONG>(kScreenMarkerWidth),
                               static_cast<LONG>(kScreenMarkerHeight)};
      const RECT marker_destination = marker_source;
      if (include_marker) {
        state_->video_context->VideoProcessorSetStreamFrameFormat(
            state_->processor.Get(), 1,
            D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        state_->video_context->VideoProcessorSetStreamSourceRect(
            state_->processor.Get(), 1, TRUE, &marker_source);
        state_->video_context->VideoProcessorSetStreamDestRect(
            state_->processor.Get(), 1, TRUE, &marker_destination);
        state_->video_context->VideoProcessorSetStreamAlpha(
            state_->processor.Get(), 1, TRUE, 1.0F);
      }
      if (state_->video_context1) {
        state_->video_context1->VideoProcessorSetStreamColorSpace1(
            state_->processor.Get(), 0,
            DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
        if (include_marker)
          state_->video_context1->VideoProcessorSetStreamColorSpace1(
              state_->processor.Get(), 1,
              DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
        state_->video_context1->VideoProcessorSetOutputColorSpace1(
            state_->processor.Get(),
            DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
      }
      std::array<D3D11_VIDEO_PROCESSOR_STREAM, 2> streams{};
      streams[0].Enable = TRUE;
      streams[0].pInputSurface = input_view;
      streams[1].Enable = TRUE;
      streams[1].pInputSurface = state_->marker_input_view.Get();
      state_->owner->context()->Begin(found->timing_disjoint.Get());
      state_->owner->context()->End(found->timing_start.Get());
      const HRESULT blt_result = state_->video_context->VideoProcessorBlt(
          state_->processor.Get(), found->output_view.Get(), 0,
          include_marker ? static_cast<UINT>(streams.size()) : 1U,
          streams.data());
      state_->owner->context()->End(found->timing_end.Get());
      state_->owner->context()->End(found->timing_disjoint.Get());
      if (FAILED(blt_result)) {
        found->in_use = false;
        state_->stats.slots_in_use = slotsInUse(*state_);
        throw gpuError("VideoProcessorBlt", blt_result);
      }
      found->timing_pending = true;
      converted = true;
    }
  }
  if (!converted) {
    found->in_use = false;
    state_->stats.slots_in_use = slotsInUse(*state_);
    return std::nullopt;
  }
  ++state_->stats.converted;
  return GpuNv12SlotLease{state_, slot_index};
}

ScreenVideoProfile GpuScreenConverter::profile() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->profile;
}

GpuScreenConverterStats GpuScreenConverter::stats() const noexcept {
  std::lock_guard lock(state_->mutex);
  auto result = state_->stats;
  result.gpu_timings_pending = static_cast<std::size_t>(std::count_if(
      state_->slots.begin(), state_->slots.end(),
      [](const auto& slot) { return slot.timing_pending; }));
  return result;
}

}  // namespace syrnike::windows_media::screen
