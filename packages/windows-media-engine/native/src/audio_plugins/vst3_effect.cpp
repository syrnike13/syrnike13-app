#include "audio_plugins/vst3_effect.hpp"

#include <windows.h>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <map>
#include <mutex>
#include <stdexcept>

namespace syrnike::windows_media::audio_plugins {
using namespace Steinberg;
using namespace Steinberg::Vst;
namespace {
constexpr std::int32_t kMaximumParameterChanges = 512;
constexpr char kStateMagic[4] = {'S', 'X', 'V', '3'};

HostApplication& hostApplication() {
  static auto* host = [] {
    auto* value = new HostApplication;
    PluginContextFactory::instance().setPluginContext(value);
    return value;
  }();
  return *host;
}

// Modules stay loaded for the host lifetime: plugins commonly keep globals
// that outlive their last instance, and unloading them is a classic crash.
VST3::Hosting::Module::Ptr loadModule(const std::string& path, std::string& error) {
  static std::map<std::string, VST3::Hosting::Module::Ptr> modules;
  if (const auto found = modules.find(path); found != modules.end()) return found->second;
  auto module = VST3::Hosting::Module::create(path, error);
  if (module) modules.emplace(path, module);
  return module;
}

bool isAudioEffect(const VST3::Hosting::ClassInfo& info) {
  if (info.category() != kVstAudioEffectClass) return false;
  const auto& categories = info.subCategories();
  const bool instrument = std::ranges::find(categories, "Instrument") != categories.end();
  return !instrument;
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size);
  return out;
}

class ComponentHandler final : public U::Implements<U::Directly<IComponentHandler>> {
 public:
  ComponentHandler(ParameterChangeTransfer& transfer, Vst3Effect::Notify notify)
      : transfer_(transfer), notify_(std::move(notify)) {}
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override {
    transfer_.addChange(id, value, 0);
    return kResultOk;
  }
  tresult PLUGIN_API endEdit(ParamID) override {
    if (notify_) notify_(Vst3Notice::edited);
    return kResultOk;
  }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    if ((flags & (kLatencyChanged | kIoChanged | kReloadComponent)) && notify_) notify_(Vst3Notice::restart);
    else if ((flags & kParamValuesChanged) && notify_) notify_(Vst3Notice::edited);
    return kResultOk;
  }
 private:
  ParameterChangeTransfer& transfer_;
  Vst3Effect::Notify notify_;
};

class EditorFrame;
LRESULT CALLBACK editorProcedure(HWND, UINT, WPARAM, LPARAM);
const wchar_t* editorClass() {
  static const wchar_t* name = [] {
    WNDCLASSEXW value{sizeof(value)};
    value.lpfnWndProc = editorProcedure;
    value.hInstance = GetModuleHandleW(nullptr);
    value.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    value.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    value.lpszClassName = L"SyrnikeAudioPluginEditor";
    RegisterClassExW(&value);
    return value.lpszClassName;
  }();
  return name;
}

constexpr DWORD kEditorStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;

// A top-level window that hosts one IPlugView and follows its size requests.
class EditorFrame final : public U::Implements<U::Directly<IPlugFrame>> {
 public:
  bool open(IPtr<IPlugView> view, const std::string& title, HWND owner) {
    view_ = std::move(view);
    if (view_->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return false;
    resizable_ = view_->canResize() == kResultTrue;
    const DWORD style = kEditorStyle | (resizable_ ? WS_THICKFRAME | WS_MAXIMIZEBOX : 0);
    window_ = CreateWindowExW(0, editorClass(), widen(title).c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT,
                              400, 300, owner, nullptr, GetModuleHandleW(nullptr), this);
    if (!window_) return false;
    view_->setFrame(this);
    if (auto scale = U::cast<IPlugViewContentScaleSupport>(view_))
      scale->setContentScaleFactor(static_cast<float>(GetDpiForWindow(window_)) / 96.0f);
    if (view_->attached(window_, kPlatformTypeHWND) != kResultTrue) {
      view_->setFrame(nullptr);
      DestroyWindow(window_);
      window_ = nullptr;
      return false;
    }
    ViewRect rect;
    if (view_->getSize(&rect) == kResultTrue) fitClient(rect);
    if (owner) centerOver(owner);
    ShowWindow(window_, SW_SHOWNORMAL);
    SetForegroundWindow(window_);
    return true;
  }
  void close() {
    if (!window_) return;
    const HWND window = std::exchange(window_, nullptr);
    if (view_) {
      view_->removed();
      view_->setFrame(nullptr);
      view_ = nullptr;
    }
    SetWindowLongPtrW(window, GWLP_USERDATA, 0);
    DestroyWindow(window);
  }
  bool isOpen() const noexcept { return window_ != nullptr; }
  void focus() const noexcept {
    if (!window_) return;
    if (IsIconic(window_)) ShowWindow(window_, SW_RESTORE);
    SetForegroundWindow(window_);
  }
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* rect) override {
    if (!window_ || !rect || view != view_.get()) return kInvalidArgument;
    fitClient(*rect);
    view->onSize(rect);
    return kResultTrue;
  }
  // `window` is the real handle: window_ is set only after CreateWindowExW
  // returns, and WM_NCCREATE must reach DefWindowProc for creation to succeed.
  LRESULT handle(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
      case WM_CLOSE:
        close();
        return 0;
      case WM_SIZE:
        if (window_ && view_ && resizable_ && !in_fit_) {
          ViewRect rect{0, 0, LOWORD(lparam), HIWORD(lparam)};
          if (view_->checkSizeConstraint(&rect) == kResultTrue) view_->onSize(&rect);
        }
        return 0;
      case WM_DPICHANGED: {
        if (auto scale = U::cast<IPlugViewContentScaleSupport>(view_))
          scale->setContentScaleFactor(static_cast<float>(HIWORD(wparam)) / 96.0f);
        const auto* suggested = reinterpret_cast<const RECT*>(lparam);
        SetWindowPos(window, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
                     suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
      }
      default:
        return DefWindowProcW(window, message, wparam, lparam);
    }
  }
 private:
  // Opens on the app's monitor instead of wherever Windows places new windows.
  void centerOver(HWND owner) {
    RECT anchor{}, own{};
    if (!GetWindowRect(owner, &anchor) || !GetWindowRect(window_, &own)) return;
    MONITORINFO monitor{sizeof(monitor)};
    if (!GetMonitorInfoW(MonitorFromWindow(owner, MONITOR_DEFAULTTONEAREST), &monitor)) return;
    const LONG width = own.right - own.left, height = own.bottom - own.top;
    const RECT& work = monitor.rcWork;
    const LONG x = (std::clamp)((anchor.left + anchor.right - width) / 2, work.left, (std::max)(work.left, work.right - width));
    const LONG y = (std::clamp)((anchor.top + anchor.bottom - height) / 2, work.top, (std::max)(work.top, work.bottom - height));
    SetWindowPos(window_, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  }
  void fitClient(const ViewRect& rect) {
    RECT bounds{0, 0, rect.getWidth(), rect.getHeight()};
    AdjustWindowRectExForDpi(&bounds, static_cast<DWORD>(GetWindowLongW(window_, GWL_STYLE)), FALSE, 0,
                             GetDpiForWindow(window_));
    in_fit_ = true;
    SetWindowPos(window_, nullptr, 0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    in_fit_ = false;
  }
  IPtr<IPlugView> view_;
  HWND window_ = nullptr;
  bool resizable_ = false, in_fit_ = false;
};

LRESULT CALLBACK editorProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  if (auto* frame = reinterpret_cast<EditorFrame*>(GetWindowLongPtrW(window, GWLP_USERDATA)))
    return frame->handle(window, message, wparam, lparam);
  return DefWindowProcW(window, message, wparam, lparam);
}

bool readStream(MemoryStream& stream, std::vector<std::uint8_t>& out) {
  int64 size = 0;
  stream.seek(0, IBStream::kIBSeekEnd, &size);
  stream.seek(0, IBStream::kIBSeekSet, nullptr);
  if (size < 0 || size > std::numeric_limits<std::uint32_t>::max()) return false;
  const auto begin = out.size();
  const auto length = static_cast<std::uint32_t>(size);
  out.resize(begin + 4 + length);
  std::memcpy(out.data() + begin, &length, 4);
  if (length) std::memcpy(out.data() + begin + 4, stream.getData(), length);
  return true;
}
}  // namespace

struct Vst3Effect::Impl {
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  IPtr<IEditController> controller;
  IPtr<ComponentHandler> handler;
  IPtr<EditorFrame> editor;
  HostProcessData data;
  ParameterChanges input_changes{kMaximumParameterChanges};
  ParameterChanges output_changes{kMaximumParameterChanges};
  ParameterChangeTransfer to_processor{kMaximumParameterChanges};
  ParameterChangeTransfer to_controller{kMaximumParameterChanges};
  ProcessContext context{};
  std::int32_t input_channels = 0, output_channels = 0;
  bool active = false, processing = false;

  ~Impl() {
    if (editor) editor->close();
    if (processing) processor->setProcessing(false);
    if (active) component->setActive(false);
    data.unprepare();
    if (controller) controller->setComponentHandler(nullptr);
  }
};

std::vector<std::string> vst3ModulePaths() { return VST3::Hosting::Module::getModulePaths(); }

std::vector<Vst3PluginInfo> scanVst3Module(const std::string& path, std::string& error) {
  hostApplication();
  std::vector<Vst3PluginInfo> plugins;
  const auto module = loadModule(path, error);
  if (!module) return plugins;
  const auto& factory = module->getFactory();
  for (const auto& info : factory.classInfos()) {
    if (!isAudioEffect(info)) continue;
    plugins.push_back({path, info.ID().toString(), info.name(), info.vendor(), info.version(),
                       info.subCategoriesString()});
  }
  return plugins;
}

Vst3Effect::Vst3Effect(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {
  latency_ = std::min<std::uint32_t>(impl_->processor->getLatencySamples(), EffectSlot::kMaximumLatencySamples);
}
Vst3Effect::~Vst3Effect() = default;

std::unique_ptr<Vst3Effect> Vst3Effect::create(const std::string& path, const std::string& class_id,
                                               const std::vector<std::uint8_t>* state, Notify notify) {
  hostApplication();
  std::string error;
  auto impl = std::make_unique<Impl>();
  impl->module = loadModule(path, error);
  if (!impl->module) throw std::runtime_error(error.empty() ? "The plugin file could not be loaded" : error);
  const auto& factory = impl->module->getFactory();
  const auto infos = factory.classInfos();
  const auto info = std::ranges::find_if(infos, [&](const auto& value) {
    return isAudioEffect(value) && value.ID().toString() == class_id;
  });
  if (info == infos.end()) throw std::runtime_error("The plugin no longer provides this effect");
  impl->provider = owned(new PlugProvider(factory, *info, true));
  if (!impl->provider->initialize()) throw std::runtime_error("The plugin failed to initialize");
  impl->component = impl->provider->getComponentPtr();
  impl->controller = impl->provider->getControllerPtr();
  impl->processor = U::cast<IAudioProcessor>(impl->component);
  if (!impl->component || !impl->processor) throw std::runtime_error("The plugin has no audio processor");
  if (impl->processor->canProcessSampleSize(kSample32) != kResultTrue)
    throw std::runtime_error("The plugin does not process 32-bit audio");

  // The voice is mono; prefer a mono effect, accept a stereo one.
  const auto inputs = impl->component->getBusCount(kAudio, kInput);
  const auto outputs = impl->component->getBusCount(kAudio, kOutput);
  if (inputs < 1 || outputs < 1) throw std::runtime_error("The plugin has no audio input or output");
  for (auto arrangement : {SpeakerArr::kMono, SpeakerArr::kStereo}) {
    std::vector<SpeakerArrangement> in(static_cast<std::size_t>(inputs), arrangement);
    std::vector<SpeakerArrangement> out(static_cast<std::size_t>(outputs), arrangement);
    if (impl->processor->setBusArrangements(in.data(), inputs, out.data(), outputs) == kResultTrue) break;
  }
  BusInfo bus{};
  impl->component->getBusInfo(kAudio, kInput, 0, bus);
  impl->input_channels = bus.channelCount;
  impl->component->getBusInfo(kAudio, kOutput, 0, bus);
  impl->output_channels = bus.channelCount;
  if (impl->input_channels < 1 || impl->output_channels < 1 || impl->input_channels > 2 ||
      impl->output_channels > 2) throw std::runtime_error("The plugin needs a channel layout other than mono or stereo");
  for (int32 index = 0; index < inputs; ++index) impl->component->activateBus(kAudio, kInput, index, index == 0);
  for (int32 index = 0; index < outputs; ++index) impl->component->activateBus(kAudio, kOutput, index, index == 0);

  ProcessSetup setup{kRealtime, kSample32, static_cast<int32>(kEffectBusFrameSamples), kEffectSampleRate};
  if (impl->processor->setupProcessing(setup) != kResultTrue)
    throw std::runtime_error("The plugin rejected 48 kHz processing");

  bool restored = false;
  if (state && state->size() >= 12 && std::memcmp(state->data(), kStateMagic, 4) == 0) {
    std::uint32_t component_size = 0, controller_size = 0;
    std::memcpy(&component_size, state->data() + 4, 4);
    if (8ull + component_size + 4 <= state->size()) {
      std::memcpy(&controller_size, state->data() + 8 + component_size, 4);
      if (12ull + component_size + controller_size == state->size()) {
        auto* bytes = const_cast<std::uint8_t*>(state->data());
        MemoryStream component_state(bytes + 8, component_size);
        if (impl->component->setState(&component_state) == kResultOk) restored = true;
        if (impl->controller) {
          component_state.seek(0, IBStream::kIBSeekSet, nullptr);
          impl->controller->setComponentState(&component_state);
          MemoryStream controller_state(bytes + 12 + component_size, controller_size);
          if (controller_size) impl->controller->setState(&controller_state);
        }
      }
    }
  }
  if (!restored && impl->controller) {
    MemoryStream initial;
    if (impl->component->getState(&initial) == kResultOk) {
      initial.seek(0, IBStream::kIBSeekSet, nullptr);
      impl->controller->setComponentState(&initial);
    }
  }
  if (impl->controller) {
    impl->handler = owned(new ComponentHandler(impl->to_processor, std::move(notify)));
    impl->controller->setComponentHandler(impl->handler);
  }
  if (!impl->data.prepare(*impl->component, static_cast<int32>(kEffectBusFrameSamples), kSample32))
    throw std::runtime_error("The plugin audio buffers could not be prepared");
  if (impl->component->setActive(true) != kResultOk) throw std::runtime_error("The plugin failed to activate");
  impl->active = true;
  impl->processing = impl->processor->setProcessing(true) == kResultOk;
  impl->data.inputParameterChanges = &impl->input_changes;
  impl->data.outputParameterChanges = &impl->output_changes;
  impl->context.sampleRate = kEffectSampleRate;
  impl->context.tempo = 120;
  impl->context.timeSigNumerator = 4;
  impl->context.timeSigDenominator = 4;
  impl->context.state = ProcessContext::kPlaying | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
  impl->data.processContext = &impl->context;
  return std::unique_ptr<Vst3Effect>(new Vst3Effect(std::move(impl)));
}

void Vst3Effect::process(float* samples, std::size_t count) noexcept {
  auto& impl = *impl_;
  auto& data = impl.data;
  data.numSamples = static_cast<int32>(count);
  for (int32 channel = 0; channel < impl.input_channels; ++channel)
    std::memcpy(data.inputs[0].channelBuffers32[channel], samples, count * sizeof(float));
  data.inputs[0].silenceFlags = 0;
  impl.input_changes.clearQueue();
  impl.output_changes.clearQueue();
  impl.to_processor.transferChangesTo(impl.input_changes);
  if (impl.processor->process(data) != kResultOk) return;
  impl.to_controller.transferChangesFrom(impl.output_changes);
  impl.context.projectTimeSamples += static_cast<TSamples>(count);
  const float scale = 1.0f / static_cast<float>(impl.output_channels);
  for (std::size_t index = 0; index < count; ++index) {
    float value = 0;
    for (int32 channel = 0; channel < impl.output_channels; ++channel)
      value += data.outputs[0].channelBuffers32[channel][index];
    samples[index] = value * scale;
  }
}

std::vector<std::uint8_t> Vst3Effect::saveState() {
  std::vector<std::uint8_t> state(kStateMagic, kStateMagic + 4);
  MemoryStream component_state, controller_state;
  if (impl_->component->getState(&component_state) != kResultOk) component_state.setSize(0);
  if (!impl_->controller || impl_->controller->getState(&controller_state) != kResultOk) controller_state.setSize(0);
  if (!readStream(component_state, state) || !readStream(controller_state, state)) return {};
  return state;
}
bool Vst3Effect::hasEditor() const noexcept { return impl_->controller != nullptr; }
bool Vst3Effect::openEditor(const std::string& title, void* owner) {
  if (impl_->editor && impl_->editor->isOpen()) {
    // Bring an already open editor forward instead of creating a second view.
    impl_->editor->focus();
    return true;
  }
  if (!impl_->controller) return false;
  auto view = owned(impl_->controller->createView(ViewType::kEditor));
  if (!view) return false;
  impl_->editor = owned(new EditorFrame);
  return impl_->editor->open(view, title, static_cast<HWND>(owner));
}
void Vst3Effect::closeEditor() {
  if (impl_->editor) impl_->editor->close();
}
bool Vst3Effect::editorOpen() const noexcept { return impl_->editor && impl_->editor->isOpen(); }
void Vst3Effect::pumpOutputChanges() {
  ParamID id = 0;
  ParamValue value = 0;
  int32 offset = 0;
  while (impl_->to_controller.getNextChange(id, value, offset))
    if (impl_->controller) impl_->controller->setParamNormalized(id, value);
}
}  // namespace syrnike::windows_media::audio_plugins
