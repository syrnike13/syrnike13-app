#pragma once

#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include "probe/resource_thread_diagnostics.hpp"

namespace syrnike::windows_media::tests {

struct FaultResources {
  DWORD handles = 0;
  DWORD threads = 0;
};

inline void beginFaultEvidence(std::ostream& output, std::string_view id) {
  output << "NATIVE_FAULT_RESULT {\"id\":\"" << id << "\",\"build\":{\"commit\":\""
         << WINDOWS_MEDIA_FAULT_COMMIT << "\",\"configuration\":\"" << WINDOWS_MEDIA_FAULT_CONFIGURATION
         << "\",\"asan\":" << (WINDOWS_MEDIA_FAULT_ASAN ? "true" : "false")
         << ",\"msvc\":" << _MSC_FULL_VER << '}';
}

inline FaultResources faultResources() {
  FaultResources result;
  if (!GetProcessHandleCount(GetCurrentProcess(), &result.handles))
    throw std::runtime_error("Cannot sample fault-test process handles");
  const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    throw std::runtime_error("Cannot sample fault-test process threads");
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++result.threads;
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

// Test-only aggregation. The body owns behavioral assertions and synchronization;
// this helper never substitutes a delay or a forged terminal event for the fault.
template <typename Test>
void repeatFault(std::string_view id, Test test, unsigned warmup = 1) {
  // Initialize the same runtime boundary before the measured batch. A caller
  // may specify a representative driver warmup; it remains visible in evidence.
  for (unsigned iteration = 0; iteration < warmup; ++iteration) test();
  const auto baseline = faultResources();
  probe::logResourceThreads((std::string(id) + "-baseline").c_str());
  double maximum_iteration_ms = 0;
  unsigned passed = 0;
  try {
    for (; passed < 100; ++passed) {
      const auto started = std::chrono::steady_clock::now();
      test();
      maximum_iteration_ms = std::max(maximum_iteration_ms,
          std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());
    }
  } catch (...) {
    beginFaultEvidence(std::cerr, id);
    std::cerr << ",\"passed\":" << passed
              << ",\"required\":100,\"ownerChecksPassed\":false}\n";
    throw;
  }
  const auto final = faultResources();
  probe::logResourceThreads((std::string(id) + "-final").c_str());
  const bool resources_recovered = final.handles <= baseline.handles && final.threads <= baseline.threads;
  beginFaultEvidence(std::cout, id);
  std::cout << ",\"passed\":" << passed
            << ",\"required\":100,\"warmup\":" << warmup
            << ",\"ownerChecksPassed\":true,\"resourceChecksPassed\":"
            << (resources_recovered ? "true" : "false") << ",\"maximumIterationMs\":"
            << maximum_iteration_ms << ",\"resources\":{\"baseline\":{\"handles\":" << baseline.handles
            << ",\"threads\":" << baseline.threads << "},\"final\":{\"handles\":" << final.handles
            << ",\"threads\":" << final.threads << "},\"delta\":{\"handles\":"
            << static_cast<long long>(final.handles) - baseline.handles << ",\"threads\":"
            << static_cast<long long>(final.threads) - baseline.threads << "}}}" << std::endl;
  if (!resources_recovered) {
    wchar_t observe[2]{};
    if (GetEnvironmentVariableW(L"WINDOWS_MEDIA_FAULT_RESOURCE_OBSERVE", observe, 2) == 1 &&
        observe[0] == L'1') {
      // Post-failure diagnostics only: the result above remains failed even if
      // Windows subsequently retires an idle worker. Never move the acceptance
      // snapshot or turn delayed cleanup into a passing resource assertion.
      const auto observation_started = std::chrono::steady_clock::now();
      for (unsigned sample = 1; sample <= 10; ++sample) {
        std::this_thread::sleep_until(observation_started + std::chrono::seconds(sample));
        const auto resources = faultResources();
        std::cerr << "NATIVE_FAULT_RESOURCE_FOLLOWUP {\"id\":\"" << id
                  << "\",\"sampleSeconds\":" << sample << ",\"handles\":" << resources.handles
                  << ",\"threads\":" << resources.threads << "}\n";
        probe::logResourceThreads((std::string(id) + "-followup-" + std::to_string(sample)).c_str());
      }
    }
    throw std::runtime_error(std::string(id) + " did not return process handles/threads to baseline");
  }
}

}  // namespace syrnike::windows_media::tests
