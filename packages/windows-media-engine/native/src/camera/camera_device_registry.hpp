#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace syrnike::windows_media::camera {
using CameraDeviceId = std::uint64_t;
enum class CameraDeviceKind { unknown, physical_usb, integrated, virtual_camera };
enum class CameraRegistryStatus { ready, enumeration_failed, capacity_exceeded };
enum class CameraDeviceChange { added, removed, default_changed, availability_changed };
struct CameraDevice {
  CameraDeviceId id = 0;
  std::string label;
  CameraDeviceKind kind = CameraDeviceKind::unknown;
  bool available = true, is_default = false;
  bool operator==(const CameraDevice&) const = default;
};
struct CameraDeviceEvent { CameraDeviceChange change; CameraDeviceId id; };
struct CameraDeviceSnapshot {
  CameraRegistryStatus status = CameraRegistryStatus::ready;
  std::uint64_t revision = 0;
  std::vector<CameraDevice> devices;
  std::vector<CameraDeviceEvent> events;
};
struct CameraEndpoint {
  // Native-only opaque MF symbolic link; never a label-derived identity.
  std::wstring symbolic_link;
  std::string label;
  CameraDeviceKind kind = CameraDeviceKind::unknown;
  bool available = true;
};
class CameraDeviceEnumerator {
 public:
  virtual ~CameraDeviceEnumerator() = default;
  virtual std::optional<std::vector<CameraEndpoint>> enumerate() = 0;
  virtual bool changed() const noexcept = 0;
};
std::unique_ptr<CameraDeviceEnumerator> makeWindowsCameraDeviceEnumerator();

// One control owner; 64 present devices and 256 lifetime identities. Windows
// exposes no default video role equivalent to MMDevice's default audio role.
// Our explicit application default is the lowest available stable registry ID.
class CameraDeviceRegistry final {
 public:
  explicit CameraDeviceRegistry(std::unique_ptr<CameraDeviceEnumerator>);
  CameraDeviceSnapshot refresh();
  bool changed() const;
  std::optional<CameraEndpoint> resolve(std::optional<CameraDeviceId> id) const;
 private:
  void requireOwner() const;
  struct Identity { std::wstring symbolic_link; CameraDeviceId id; };
  const std::thread::id owner_ = std::this_thread::get_id();
  std::unique_ptr<CameraDeviceEnumerator> enumerator_;
  std::vector<Identity> identities_;
  std::vector<CameraEndpoint> endpoints_;
  CameraDeviceSnapshot snapshot_;
};
}  // namespace syrnike::windows_media::camera
