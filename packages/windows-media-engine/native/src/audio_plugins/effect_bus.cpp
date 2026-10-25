#include "audio_plugins/effect_bus.hpp"

#include <windows.h>
#include <algorithm>
#include <cmath>
#include <new>

namespace syrnike::windows_media::audio_plugins {
namespace {
using Clock = std::chrono::steady_clock;
std::wstring name(std::string_view prefix, std::string_view id) {
  std::wstring value(L"Local\\syrnike-fx-");
  value.append(prefix.begin(), prefix.end());
  value.append(id.begin(), id.end());
  return value;
}
void closeHandles(void*& mapping, void*& request, void*& response, EffectBusShared*& shared) noexcept {
  if (shared) UnmapViewOfFile(shared);
  if (mapping) CloseHandle(mapping);
  if (request) CloseHandle(request);
  if (response) CloseHandle(response);
  shared = nullptr;
  mapping = request = response = nullptr;
}
}  // namespace

bool validEffectBusId(std::string_view id) noexcept {
  return !id.empty() && id.size() <= 64 && std::ranges::all_of(id, [](char value) {
    return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
        (value >= '0' && value <= '9') || value == '-' || value == '_';
  });
}
std::wstring effectBusSectionName(std::string_view id) { return name("bus-", id); }
std::wstring effectBusRequestEventName(std::string_view id) { return name("request-", id); }
std::wstring effectBusResponseEventName(std::string_view id) { return name("response-", id); }

std::unique_ptr<EffectBusClient> EffectBusClient::open(std::string_view id) {
  if (!validEffectBusId(id)) return nullptr;
  std::unique_ptr<EffectBusClient> client(new EffectBusClient);
  client->id_ = id;
  client->mapping_ = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, effectBusSectionName(id).c_str());
  client->request_ = OpenEventW(EVENT_MODIFY_STATE, FALSE, effectBusRequestEventName(id).c_str());
  client->response_ = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, effectBusResponseEventName(id).c_str());
  if (!client->mapping_ || !client->request_ || !client->response_) return nullptr;
  client->shared_ = static_cast<EffectBusShared*>(
      MapViewOfFile(client->mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(EffectBusShared)));
  if (!client->shared_ || client->shared_->magic != kEffectBusMagic ||
      client->shared_->version != kEffectBusVersion) return nullptr;
  return client;
}
EffectBusClient::~EffectBusClient() { closeHandles(mapping_, request_, response_, shared_); }
EffectBusClientStats EffectBusClient::stats() const noexcept {
  return {processed_.load(std::memory_order_relaxed), timeouts_.load(std::memory_order_relaxed),
          busy_.load(std::memory_order_relaxed)};
}
bool EffectBusClient::process(std::array<std::int16_t, kEffectBusFrameSamples>& samples) noexcept {
  if (!shared_->active.load(std::memory_order_acquire)) return false;
  const auto previous = shared_->request_sequence.load(std::memory_order_relaxed);
  // A host that missed the last deadline may still read the input slot.
  if (shared_->response_sequence.load(std::memory_order_acquire) != previous) {
    busy_.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  for (std::size_t index = 0; index < samples.size(); ++index)
    shared_->input[index] = static_cast<float>(samples[index]) / 32768.0f;
  const auto sequence = previous + 1;
  shared_->request_sequence.store(sequence, std::memory_order_release);
  SetEvent(request_);
  const auto deadline = Clock::now() + kEffectBusDeadline;
  // The response event may still carry a late wake for an older request, so
  // the sequence, not the wake, decides. A hung host costs one deadline: the
  // following frames see it busy and stay dry without waiting.
  while (shared_->response_sequence.load(std::memory_order_acquire) != sequence) {
    const auto now = Clock::now();
    if (now >= deadline) {
      timeouts_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    const auto left = std::chrono::ceil<std::chrono::milliseconds>(deadline - now).count();
    WaitForSingleObject(response_, static_cast<DWORD>(left));
  }
  for (std::size_t index = 0; index < samples.size(); ++index) {
    const float value = shared_->output[index];
    samples[index] = std::isfinite(value) ? static_cast<std::int16_t>(std::lround(
        (std::clamp)(value * 32768.0f, -32768.0f, 32767.0f))) : 0;
  }
  processed_.fetch_add(1, std::memory_order_relaxed);
  return true;
}

std::unique_ptr<EffectBusServer> EffectBusServer::create(std::string_view id) {
  if (!validEffectBusId(id)) return nullptr;
  std::unique_ptr<EffectBusServer> server(new EffectBusServer);
  server->mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                        sizeof(EffectBusShared), effectBusSectionName(id).c_str());
  // An existing name belongs to someone else: never serve a foreign bus.
  if (!server->mapping_ || GetLastError() == ERROR_ALREADY_EXISTS) return nullptr;
  server->request_ = CreateEventW(nullptr, FALSE, FALSE, effectBusRequestEventName(id).c_str());
  if (!server->request_ || GetLastError() == ERROR_ALREADY_EXISTS) return nullptr;
  server->response_ = CreateEventW(nullptr, FALSE, FALSE, effectBusResponseEventName(id).c_str());
  if (!server->response_ || GetLastError() == ERROR_ALREADY_EXISTS) return nullptr;
  auto* view = MapViewOfFile(server->mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(EffectBusShared));
  if (!view) return nullptr;
  server->shared_ = new (view) EffectBusShared{};
  server->shared_->version = kEffectBusVersion;
  std::atomic_thread_fence(std::memory_order_release);
  server->shared_->magic = kEffectBusMagic;
  return server;
}
EffectBusServer::~EffectBusServer() {
  if (shared_) shared_->active.store(0, std::memory_order_release);
  closeHandles(mapping_, request_, response_, shared_);
}
void EffectBusServer::setActive(bool active, std::uint32_t latency_samples) noexcept {
  shared_->latency_samples.store(latency_samples, std::memory_order_relaxed);
  shared_->active.store(active ? 1 : 0, std::memory_order_release);
}
bool EffectBusServer::waitRequest(std::chrono::milliseconds wait) noexcept {
  return WaitForSingleObject(request_, static_cast<DWORD>(wait.count())) == WAIT_OBJECT_0;
}
void EffectBusServer::signalResponse() noexcept { SetEvent(response_); }
}  // namespace syrnike::windows_media::audio_plugins
