#include "camera/camera_device_registry.hpp"

#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::camera {
CameraDeviceRegistry::CameraDeviceRegistry(std::unique_ptr<CameraDeviceEnumerator> enumerator)
    : enumerator_(std::move(enumerator)) {
  if (!enumerator_) throw std::invalid_argument("Camera enumerator is required");
  identities_.reserve(256);
}
void CameraDeviceRegistry::requireOwner() const {
  if (owner_ != std::this_thread::get_id()) throw std::logic_error("Camera registry owner mismatch");
}
bool CameraDeviceRegistry::changed() const { requireOwner(); return enumerator_->changed(); }
CameraDeviceSnapshot CameraDeviceRegistry::refresh() {
  requireOwner();
  auto endpoints = enumerator_->enumerate();
  snapshot_.events.clear();
  const auto fail = [&](CameraRegistryStatus status) {
    if (snapshot_.status != status) ++snapshot_.revision;
    snapshot_.status = status;
    return snapshot_;
  };
  if (!endpoints) return fail(CameraRegistryStatus::enumeration_failed);
  if (endpoints->size() > 64) return fail(CameraRegistryStatus::capacity_exceeded);
  // Stabilize initial identity assignment independently of enumeration order.
  std::sort(endpoints->begin(), endpoints->end(), [](const auto& left, const auto& right) {
    return left.symbolic_link < right.symbolic_link;
  });
  auto identities = identities_;
  std::vector<CameraDevice> next;
  next.reserve(endpoints->size());
  CameraDeviceId default_id = 0;
  for (const auto& endpoint : *endpoints) {
    if (endpoint.symbolic_link.empty() || endpoint.symbolic_link.size() > 4096 || endpoint.label.size() > 1024)
      return fail(CameraRegistryStatus::enumeration_failed);
    auto identity = std::find_if(identities.begin(), identities.end(), [&](const auto& value) {
      return value.symbolic_link == endpoint.symbolic_link;
    });
    if (identity == identities.end()) {
      if (identities.size() == 256) return fail(CameraRegistryStatus::capacity_exceeded);
      identities.push_back({endpoint.symbolic_link, identities.size() + 1});
      identity = std::prev(identities.end());
    }
    if (std::any_of(next.begin(), next.end(), [&](const auto& value) { return value.id == identity->id; }))
      return fail(CameraRegistryStatus::enumeration_failed);
    next.push_back({identity->id, endpoint.label, endpoint.kind, endpoint.available, false});
    if (endpoint.available && (!default_id || identity->id < default_id)) default_id = identity->id;
  }
  CameraDeviceId old_default = 0;
  for (const auto& old : snapshot_.devices) {
    if (old.is_default) old_default = old.id;
    const auto replacement = std::find_if(next.begin(), next.end(), [&](const auto& value) { return value.id == old.id; });
    if (replacement == next.end()) snapshot_.events.push_back({CameraDeviceChange::removed, old.id});
    else if (replacement->available != old.available)
      snapshot_.events.push_back({CameraDeviceChange::availability_changed, old.id});
  }
  for (auto& device : next) {
    device.is_default = device.id == default_id;
    if (std::none_of(snapshot_.devices.begin(), snapshot_.devices.end(), [&](const auto& old) { return old.id == device.id; }))
      snapshot_.events.push_back({CameraDeviceChange::added, device.id});
  }
  if (old_default != default_id) snapshot_.events.push_back({CameraDeviceChange::default_changed, default_id});
  if (next != snapshot_.devices || snapshot_.status != CameraRegistryStatus::ready) ++snapshot_.revision;
  snapshot_.status = CameraRegistryStatus::ready;
  snapshot_.devices = std::move(next);
  identities_ = std::move(identities);
  endpoints_ = std::move(*endpoints);
  return snapshot_;
}
std::optional<CameraEndpoint> CameraDeviceRegistry::resolve(std::optional<CameraDeviceId> id) const {
  requireOwner();
  if (snapshot_.status != CameraRegistryStatus::ready) return {};
  for (std::size_t index = 0; index < snapshot_.devices.size(); ++index) {
    const auto& value = snapshot_.devices[index];
    if (value.available && (id ? value.id == *id : value.is_default)) return endpoints_[index];
  }
  return {};
}
}  // namespace syrnike::windows_media::camera
