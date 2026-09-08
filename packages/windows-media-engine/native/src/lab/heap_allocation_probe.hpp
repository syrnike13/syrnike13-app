#pragma once

#include <windows.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>

namespace syrnike::windows_media::lab {
// Disposable-process instrumentation only. Interpose heap imports in the SDK
// and CRT, count calls from the sampling thread, then restore every import.
// No registry/ETW settings, global allocator changes or product hooks are used.
class HeapAllocationProbe final {
 public:
  struct Counts { std::uint64_t allocations = 0, reallocations = 0, bytes = 0; };
  HeapAllocationProbe() {
    if (instance_) throw std::logic_error("Only one heap probe may be installed");
    instance_ = this;
    try {
      for (const auto name : {L"ucrtbase.dll", L"livekit.dll", L"livekit_ffi.dll"}) {
        if (const auto module = GetModuleHandleW(name)) patch(module);
      }
      if (!count_) throw std::runtime_error("No heap imports found for allocation evidence");
    } catch (...) {
      restore();
      instance_ = nullptr;
      throw;
    }
  }
  ~HeapAllocationProbe() { sampling_ = false; restore(); instance_ = nullptr; }
  void begin() noexcept { counts_ = {}; sampling_ = true; }
  Counts end() noexcept { sampling_ = false; return counts_; }
  std::size_t imports() const noexcept { return count_; }
 private:
  using Allocate = LPVOID (WINAPI*)(HANDLE, DWORD, SIZE_T);
  using Reallocate = LPVOID (WINAPI*)(HANDLE, DWORD, LPVOID, SIZE_T);
  struct Patch { ULONG_PTR* address = nullptr; ULONG_PTR original = 0; };
  inline static HeapAllocationProbe* instance_ = nullptr;
  inline static thread_local bool sampling_ = false;
  inline static thread_local Counts counts_{0, 0, 0};
  std::array<Patch, 32> patches_{};
  std::size_t count_ = 0;
  static LPVOID WINAPI allocate(HANDLE heap, DWORD flags, SIZE_T size) {
    if (sampling_) { ++counts_.allocations; counts_.bytes += size; }
    return HeapAlloc(heap, flags, size);
  }
  static LPVOID WINAPI reallocate(HANDLE heap, DWORD flags, LPVOID memory, SIZE_T size) {
    if (sampling_) { ++counts_.reallocations; counts_.bytes += size; }
    return HeapReAlloc(heap, flags, memory, size);
  }
  void patch(HMODULE module) {
    const auto base = reinterpret_cast<unsigned char*>(module);
    const auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) throw std::runtime_error("Invalid module DOS header");
    const auto nt = reinterpret_cast<IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) throw std::runtime_error("Invalid module NT header");
    const auto directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!directory.VirtualAddress) return;
    const auto descriptors = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + directory.VirtualAddress);
    for (std::size_t entry = 0; entry < directory.Size / sizeof(IMAGE_IMPORT_DESCRIPTOR) && descriptors[entry].Name; ++entry) {
      const auto& descriptor = descriptors[entry];
      if (!descriptor.OriginalFirstThunk) continue;
      const auto names = reinterpret_cast<IMAGE_THUNK_DATA*>(base + descriptor.OriginalFirstThunk);
      const auto imports = reinterpret_cast<IMAGE_THUNK_DATA*>(base + descriptor.FirstThunk);
      for (std::size_t index = 0; names[index].u1.AddressOfData; ++index) {
        if (IMAGE_SNAP_BY_ORDINAL(names[index].u1.Ordinal)) continue;
        const auto name = reinterpret_cast<IMAGE_IMPORT_BY_NAME*>(base + names[index].u1.AddressOfData);
        ULONG_PTR replacement = 0;
        if (std::strcmp(reinterpret_cast<const char*>(name->Name), "HeapAlloc") == 0)
          replacement = reinterpret_cast<ULONG_PTR>(static_cast<Allocate>(allocate));
        else if (std::strcmp(reinterpret_cast<const char*>(name->Name), "HeapReAlloc") == 0)
          replacement = reinterpret_cast<ULONG_PTR>(static_cast<Reallocate>(reallocate));
        if (!replacement) continue;
        if (count_ == patches_.size()) throw std::runtime_error("Heap probe import capacity exceeded");
        auto* address = &imports[index].u1.Function;
        const auto original = *address;
        DWORD protection = 0;
        if (!VirtualProtect(address, sizeof(*address), PAGE_READWRITE, &protection))
          throw std::runtime_error("Heap probe import protection failed");
        InterlockedExchangePointer(reinterpret_cast<void* volatile*>(address), reinterpret_cast<void*>(replacement));
        DWORD ignored = 0;
        if (!VirtualProtect(address, sizeof(*address), protection, &ignored)) std::terminate();
        patches_[count_++] = {address, original};
      }
    }
  }
  void restore() noexcept {
    while (count_) {
      const auto& patch = patches_[--count_];
      DWORD protection = 0;
      if (!VirtualProtect(patch.address, sizeof(*patch.address), PAGE_READWRITE, &protection)) std::terminate();
      InterlockedExchangePointer(reinterpret_cast<void* volatile*>(patch.address), reinterpret_cast<void*>(patch.original));
      DWORD ignored = 0;
      if (!VirtualProtect(patch.address, sizeof(*patch.address), protection, &ignored)) std::terminate();
    }
  }
};
}  // namespace syrnike::windows_media::lab
