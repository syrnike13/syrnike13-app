#pragma once

#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <string_view>

namespace syrnike::windows_media {

// Endpoint identities survive utility restarts. Hash their private OS values
// instead of assigning enumeration positions, which can select another device
// after a restart or reordering. Catalogs reject collisions before committing.
inline std::optional<std::uint64_t> opaqueDeviceId(std::wstring_view domain,
                                                  std::wstring_view endpoint) {
  std::wstring input(domain);
  input.append(endpoint);
  std::array<unsigned char, 32> digest{};
  const auto status = BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
      reinterpret_cast<PUCHAR>(input.data()),
      static_cast<ULONG>(input.size() * sizeof(wchar_t)), digest.data(),
      static_cast<ULONG>(digest.size()));
  if (status < 0) return {};
  std::uint64_t id = 0;
  std::memcpy(&id, digest.data(), sizeof(id));
  // Keep diagnostic numeric projections exact in JavaScript as well.
  id &= 0x1fffffffffffffULL;
  return id ? std::optional{id} : std::nullopt;
}

}  // namespace syrnike::windows_media
