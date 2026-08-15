#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace syrnike::desktop_native::media {

// Single-writer immutable snapshot domain. Reader leases only publish/clear a
// fixed hazard pointer; allocation and payload destruction stay on the control
// thread that calls publish()/reclaim().
template <typename Snapshot, std::size_t ReaderCapacity = 4>
class RealtimeSnapshotDomain final {
  struct Slot;

 public:
  class Reader final {
   public:
    Reader() noexcept = default;
    Reader(Reader&& other) noexcept
      : slot_(std::exchange(other.slot_, nullptr)) {}
    Reader& operator=(Reader&& other) noexcept {
      if (this == &other) return *this;
      reset();
      slot_ = std::exchange(other.slot_, nullptr);
      return *this;
    }
    ~Reader() { reset(); }
    Reader(const Reader&) = delete;
    Reader& operator=(const Reader&) = delete;

   private:
    friend class RealtimeSnapshotDomain;
    Slot* slot_ = nullptr;
    explicit Reader(Slot& slot) noexcept : slot_(&slot) {}
    void reset() noexcept {
      if (!slot_) return;
      slot_->hazard.store(nullptr, std::memory_order_seq_cst);
      slot_->claimed.store(false, std::memory_order_release);
      slot_ = nullptr;
    }
  };

  using ReaderToken = Reader;

  class Lease final {
   public:
    Lease() noexcept = default;
    Lease(Lease&& other) noexcept
      : slot_(std::exchange(other.slot_, nullptr)),
        snapshot_(std::exchange(other.snapshot_, nullptr)) {}
    Lease& operator=(Lease&& other) noexcept {
      if (this == &other) return *this;
      reset();
      slot_ = std::exchange(other.slot_, nullptr);
      snapshot_ = std::exchange(other.snapshot_, nullptr);
      return *this;
    }
    ~Lease() { reset(); }
    Lease(const Lease&) = delete;
    Lease& operator=(const Lease&) = delete;

    const Snapshot& get() const noexcept { return *snapshot_; }

   private:
    friend class RealtimeSnapshotDomain;
    Slot* slot_ = nullptr;
    const Snapshot* snapshot_ = nullptr;
    Lease(Slot& slot, const Snapshot* snapshot) noexcept
      : slot_(&slot), snapshot_(snapshot) {}
    void reset() noexcept {
      if (slot_) slot_->hazard.store(nullptr, std::memory_order_seq_cst);
      slot_ = nullptr;
      snapshot_ = nullptr;
    }
  };

  explicit RealtimeSnapshotDomain(std::unique_ptr<const Snapshot> initial)
      : current_(std::move(initial)) {
    if (!current_) throw std::invalid_argument("realtime snapshot is required");
    source_.store(current_.get(), std::memory_order_seq_cst);
  }

  Reader claimReader() {
    for (auto& slot : readers_) {
      bool available = false;
      if (slot.claimed.compare_exchange_strong(
            available, true, std::memory_order_acq_rel)) {
        return Reader(slot);
      }
    }
    throw std::runtime_error("realtime snapshot reader capacity exhausted");
  }

  Lease acquire(Reader& reader) const noexcept {
    auto* snapshot = source_.load(std::memory_order_seq_cst);
    do {
      reader.slot_->hazard.store(snapshot, std::memory_order_seq_cst);
      const auto* current = source_.load(std::memory_order_seq_cst);
      if (current == snapshot) break;
      snapshot = current;
    } while (true);
    return Lease(*reader.slot_, snapshot);
  }

  void publish(std::unique_ptr<const Snapshot> next) {
    if (!next) return;
    retired_.push_back(std::move(current_));
    current_ = std::move(next);
    source_.store(current_.get(), std::memory_order_seq_cst);
    reclaim();
  }

  void reclaim() noexcept {
    std::erase_if(retired_, [this](const auto& candidate) {
      return std::none_of(readers_.begin(), readers_.end(), [&](const auto& slot) {
        return slot.hazard.load(std::memory_order_seq_cst) == candidate.get();
      });
    });
  }

  std::size_t retiredCount() const noexcept { return retired_.size(); }

 private:
  struct Slot {
    std::atomic_bool claimed{false};
    std::atomic<const Snapshot*> hazard{nullptr};
  };

  std::array<Slot, ReaderCapacity> readers_{};
  std::unique_ptr<const Snapshot> current_;
  std::vector<std::unique_ptr<const Snapshot>> retired_;
  std::atomic<const Snapshot*> source_{nullptr};
};

}  // namespace syrnike::desktop_native::media
