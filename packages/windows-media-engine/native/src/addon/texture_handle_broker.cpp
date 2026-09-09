#include <napi.h>
#include <windows.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <utility>

namespace {
std::atomic_bool process_exit_deadline_armed{false};
HANDLE process_exit_timer = nullptr;

void CALLBACK terminateCurrentProcess(void*, BOOLEAN) {
  TerminateProcess(GetCurrentProcess(), 0);
}

Napi::Value armProcessExitDeadline(const Napi::CallbackInfo& info) {
  if (!info[0].IsNumber()) throw Napi::TypeError::New(info.Env(), "Invalid process exit deadline");
  const auto timeout = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(timeout) || timeout < 1 || timeout > 4000 || std::floor(timeout) != timeout)
    throw Napi::TypeError::New(info.Env(), "Invalid process exit deadline");
  if (process_exit_deadline_armed.exchange(true)) return info.Env().Undefined();

  // Electron can finish its Node environment before the kernel process exits.
  // Keep this callback's module loaded and leave the one-shot native timer owned
  // by the terminating process, independent of N-API finalizers and JS timers.
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                         reinterpret_cast<LPCWSTR>(&terminateCurrentProcess), &module) ||
      !CreateTimerQueueTimer(&process_exit_timer, nullptr, terminateCurrentProcess, nullptr,
                            static_cast<DWORD>(timeout), 0,
                            WT_EXECUTEINTIMERTHREAD | WT_EXECUTEONLYONCE)) {
    process_exit_deadline_armed = false;
    throw Napi::Error::New(info.Env(), "Cannot arm process exit deadline");
  }
  return info.Env().Undefined();
}

// Retain the kernel process object from spawn through retirement. Termination
// never reopens a PID, which could have been recycled by Windows.
class UtilityProcessGuard : public Napi::ObjectWrap<UtilityProcessGuard> {
 public:
  explicit UtilityProcessGuard(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<UtilityProcessGuard>(info) {
    if (!info[0].IsNumber()) throw Napi::TypeError::New(info.Env(), "Invalid utility PID");
    const auto pid = info[0].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(pid) || pid <= 0 || pid > MAXDWORD || std::floor(pid) != pid)
      throw Napi::TypeError::New(info.Env(), "Invalid utility PID");
    const auto process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | SYNCHRONIZE,
                                    FALSE, static_cast<DWORD>(pid));
    if (!process) throw Napi::Error::New(info.Env(), "Cannot retain utility process");
    const auto job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job, process)) {
      if (job) CloseHandle(job);
      CloseHandle(process);
      throw Napi::Error::New(info.Env(), "Cannot contain utility process lifetime");
    }
    handle_ = process;
    job_ = job;
  }
  ~UtilityProcessGuard() { closeHandles(); }
  static Napi::Value open(const Napi::CallbackInfo& info) {
    auto constructor = DefineClass(info.Env(), "UtilityProcessGuard", {
      InstanceMethod("terminate", &UtilityProcessGuard::terminate),
      InstanceMethod("hasExited", &UtilityProcessGuard::hasExited),
      InstanceMethod("close", &UtilityProcessGuard::close),
    });
    return constructor.New({info[0]});
  }
 private:
  Napi::Value terminate(const Napi::CallbackInfo& info) {
    if (!handle_) throw Napi::Error::New(info.Env(), "Utility process guard is closed");
    if (WaitForSingleObject(handle_, 0) != WAIT_OBJECT_0 && !TerminateProcess(handle_, 1)) {
      // A process already terminating can return ACCESS_DENIED. The caller must
      // still await the retained handle becoming signaled within its deadline.
      if (GetLastError() != ERROR_ACCESS_DENIED)
        throw Napi::Error::New(info.Env(), "Cannot terminate utility process");
    }
    return info.Env().Undefined();
  }
  Napi::Value hasExited(const Napi::CallbackInfo& info) {
    if (!handle_) throw Napi::Error::New(info.Env(), "Utility process guard is closed");
    const auto result = WaitForSingleObject(handle_, 0);
    if (result == WAIT_FAILED) throw Napi::Error::New(info.Env(), "Cannot query utility process exit");
    return Napi::Boolean::New(info.Env(), result == WAIT_OBJECT_0);
  }
  Napi::Value close(const Napi::CallbackInfo& info) {
    closeHandles();
    return info.Env().Undefined();
  }
  void closeHandles() {
    // The unnamed, non-inherited job also closes when main exits abruptly.
    // Native hangs cannot leave the utility alive after its owner disappears.
    if (const auto job = std::exchange(job_, nullptr)) CloseHandle(job);
    if (const auto handle = std::exchange(handle_, nullptr)) CloseHandle(handle);
  }
  HANDLE handle_ = nullptr;
  HANDLE job_ = nullptr;
};

// A crashed renderer can leave its WebFrameMain alive for a replacement
// document. Retain the actual process object for release proof, without taking
// ownership of the renderer's termination or changing Chromium's jobs.
class ReceiverProcessReference : public Napi::ObjectWrap<ReceiverProcessReference> {
 public:
  explicit ReceiverProcessReference(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<ReceiverProcessReference>(info) {
    if (!info[0].IsNumber()) throw Napi::TypeError::New(info.Env(), "Invalid receiver PID");
    const auto pid = info[0].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(pid) || pid <= 0 || pid > MAXDWORD || std::floor(pid) != pid)
      throw Napi::TypeError::New(info.Env(), "Invalid receiver PID");
    handle_ = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
    if (!handle_) throw Napi::Error::New(info.Env(), "Cannot retain texture receiver");
  }
  ~ReceiverProcessReference() { closeHandle(); }
  static Napi::Value open(const Napi::CallbackInfo& info) {
    auto constructor = DefineClass(info.Env(), "ReceiverProcessReference", {
      InstanceMethod("hasExited", &ReceiverProcessReference::hasExited),
      InstanceMethod("close", &ReceiverProcessReference::close),
    });
    return constructor.New({info[0]});
  }
 private:
  Napi::Value hasExited(const Napi::CallbackInfo& info) {
    if (!handle_) throw Napi::Error::New(info.Env(), "Receiver process reference is closed");
    const auto result = WaitForSingleObject(handle_, 0);
    if (result == WAIT_FAILED) throw Napi::Error::New(info.Env(), "Cannot query receiver process exit");
    return Napi::Boolean::New(info.Env(), result == WAIT_OBJECT_0);
  }
  Napi::Value close(const Napi::CallbackInfo& info) {
    closeHandle();
    return info.Env().Undefined();
  }
  void closeHandle() {
    if (const auto handle = std::exchange(handle_, nullptr)) CloseHandle(handle);
  }
  HANDLE handle_ = nullptr;
};

struct ProducerProcess {
  HANDLE handle = nullptr;
  ~ProducerProcess() { if (handle) CloseHandle(handle); }
};
std::uint64_t integer(const Napi::Value& value) {
  if (!value.IsNumber()) throw Napi::TypeError::New(value.Env(), "Expected bounded integer");
  const auto number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number <= 0 || number > 9007199254740991.0 || std::floor(number) != number)
    throw Napi::TypeError::New(value.Env(), "Invalid bounded integer");
  return static_cast<std::uint64_t>(number);
}
ProducerProcess& producer(const Napi::Value& value) {
  if (!value.IsExternal()) throw Napi::TypeError::New(value.Env(), "Invalid producer process");
  return *value.As<Napi::External<ProducerProcess>>().Data();
}
Napi::Value openProducer(const Napi::CallbackInfo& info) {
  const auto pid = integer(info[0]);
  if (pid > MAXDWORD) throw Napi::TypeError::New(info.Env(), "Invalid producer PID");
  const auto process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, static_cast<DWORD>(pid));
  if (!process) throw Napi::Error::New(info.Env(), "Cannot open texture producer");
  auto owner = new ProducerProcess{process};
  return Napi::External<ProducerProcess>::New(info.Env(), owner,
      [](Napi::Env, ProducerProcess* value) { delete value; });
}
Napi::Value closeProducer(const Napi::CallbackInfo& info) {
  if (const auto handle = std::exchange(producer(info[0]).handle, nullptr)) CloseHandle(handle);
  return info.Env().Undefined();
}
Napi::Value duplicate(const Napi::CallbackInfo& info) {
  const auto process = producer(info[0]).handle;
  HANDLE handle = nullptr;
  if (!process || !DuplicateHandle(process, reinterpret_cast<HANDLE>(integer(info[1])),
      GetCurrentProcess(), &handle, 0, FALSE, DUPLICATE_SAME_ACCESS))
    throw Napi::Error::New(info.Env(), "Texture handle duplication failed");
  return Napi::Buffer<std::uint8_t>::Copy(info.Env(), reinterpret_cast<const std::uint8_t*>(&handle), sizeof(handle));
}
Napi::Value closeHandle(const Napi::CallbackInfo& info) {
  if (!info[0].IsBuffer()) throw Napi::TypeError::New(info.Env(), "Invalid texture handle");
  const auto buffer = info[0].As<Napi::Buffer<std::uint8_t>>();
  if (buffer.Length() != sizeof(HANDLE)) throw Napi::TypeError::New(info.Env(), "Invalid texture handle size");
  HANDLE handle = nullptr;
  std::memcpy(&handle, buffer.Data(), sizeof(handle));
  std::memset(buffer.Data(), 0, buffer.Length());
  if (handle) CloseHandle(handle);
  return info.Env().Undefined();
}
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("armProcessExitDeadline", Napi::Function::New(env, armProcessExitDeadline));
  exports.Set("openUtilityProcess", Napi::Function::New(env, UtilityProcessGuard::open));
  exports.Set("openReceiverProcess", Napi::Function::New(env, ReceiverProcessReference::open));
  exports.Set("openProducer", Napi::Function::New(env, openProducer));
  exports.Set("closeProducer", Napi::Function::New(env, closeProducer));
  exports.Set("duplicate", Napi::Function::New(env, duplicate));
  exports.Set("closeHandle", Napi::Function::New(env, closeHandle));
  return exports;
}
}  // namespace
// Main-only process/handle broker: no D3D device, media owner, or SDK work.
// Its terminal process timer has no N-API references or media callbacks.
NODE_API_MODULE(windows_media_texture_broker, initialize)
