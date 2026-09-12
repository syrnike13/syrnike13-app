#include "lab/gpu_contention.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

// Standalone external-load fixture. Its parent owns and confirms process exit;
// the deadline bounds a forgotten fixture without changing any product limits.
int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("Expected workload duration in milliseconds");
    const auto duration = std::chrono::milliseconds(std::stoul(argv[1]));
    if (duration.count() < 100 || duration.count() > 30'000)
      throw std::runtime_error("GPU fixture duration exceeds bounds");
    using Clock = std::chrono::steady_clock;
    std::uint64_t completed = 0;
    {
      auto device = syrnike::windows_media::capture::processD3d11Device(false);
      syrnike::windows_media::lab::GpuContention workload(device);
      workload.setActive(true);
      const auto startup_deadline = Clock::now() + std::chrono::seconds{3};
      while (workload.batches() == 0) {
        if (FAILED(workload.failure()) || Clock::now() >= startup_deadline)
          throw std::runtime_error("GPU workload made no progress before deadline");
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
      }
      std::cout << "GPU_CONTENTION_READY {}" << std::endl;
      const auto deadline = Clock::now() + duration;
      while (Clock::now() < deadline) {
        if (FAILED(workload.failure())) throw std::runtime_error("GPU workload failed");
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
      }
      workload.setActive(false);
      completed = workload.batches();
    }
    std::cout << "GPU_CONTENTION_RESULT {\"batches\":" << completed
              << ",\"allocatedBytes\":" << syrnike::windows_media::lab::GpuContention::allocated_bytes
              << ",\"maximumOutstandingDispatches\":1}" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
