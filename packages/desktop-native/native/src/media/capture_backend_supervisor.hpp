#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <deque>
#include <mutex>

#include "screen_gpu_capture.hpp"

namespace syrnike::desktop_native::media {

enum class CaptureBackend {
  Dxgi,
  Wgc,
};

enum class CaptureBackendState {
  Healthy,
  NoContent,
  Degraded,
  Reinitializing,
  Failed,
};

enum class CaptureBackendAction {
  None,
  ReinitializeActive,
  RecreateDevice,
  SwitchBackend,
  ProbePreferredBackend,
  RestartPublication,
  Fail,
};

struct CaptureBackendObservation {
  ScreenGpuFrameStatus status = ScreenGpuFrameStatus::NoFrame;
  ScreenGpuCaptureErrorCode error =
      ScreenGpuCaptureErrorCode::CaptureUnavailable;
  bool secure_desktop = false;
  bool content_expected = false;
};

struct CaptureBackendDecision {
  CaptureBackendState state = CaptureBackendState::Healthy;
  CaptureBackendAction action = CaptureBackendAction::None;
  CaptureBackend target = CaptureBackend::Dxgi;
};

// Owns the complete monitor-capture recovery policy. Capture backends report
// observations only; they never restart themselves or decide when to fallback.
class CaptureBackendSupervisor final {
 public:
  using Clock = std::chrono::steady_clock;

  explicit CaptureBackendSupervisor(
      CaptureBackend initial = CaptureBackend::Dxgi) noexcept
      : active_(initial), preferred_(CaptureBackend::Dxgi) {}

  [[nodiscard]] CaptureBackendDecision observe(
      CaptureBackendObservation observation,
      Clock::time_point now) noexcept {
    if (observation.status == ScreenGpuFrameStatus::TargetClosed) {
      state_ = CaptureBackendState::Failed;
      return {state_, CaptureBackendAction::Fail, active_};
    }

    if (observation.secure_desktop) {
      state_ = CaptureBackendState::NoContent;
      return {state_, CaptureBackendAction::None, active_};
    }

    if (observation.status == ScreenGpuFrameStatus::NewFrame) {
      state_ = CaptureBackendState::Healthy;
      consecutive_failures_ = 0;
      backoff_exponent_ = 0;
      last_success_at_ = now;
      if (active_ != preferred_ && now >= preferred_probe_at_) {
        if (now < next_reinitialize_at_) {
          return {state_, CaptureBackendAction::None, active_};
        }
        preferred_probe_at_ = now + kPreferredProbeInterval;
        return {
            CaptureBackendState::Reinitializing,
            CaptureBackendAction::ProbePreferredBackend,
            preferred_,
        };
      }
      return {state_, CaptureBackendAction::None, active_};
    }

    if (observation.status == ScreenGpuFrameStatus::NoFrame ||
        observation.status == ScreenGpuFrameStatus::EncoderBackpressure) {
      // No output is normal for static content. Encoder backpressure is owned
      // by the publication control plane, not by capture-backend recovery.
      if (observation.status == ScreenGpuFrameStatus::NoFrame &&
          observation.content_expected &&
          last_success_at_ != Clock::time_point{} &&
          now - last_success_at_ >= kAcquireWatchdog &&
          now >= next_reinitialize_at_) {
        state_ = CaptureBackendState::Reinitializing;
        scheduleBackoff(now);
        return {
            state_,
            CaptureBackendAction::ReinitializeActive,
            active_,
        };
      }
      state_ = observation.status == ScreenGpuFrameStatus::NoFrame
          ? CaptureBackendState::NoContent
          : CaptureBackendState::Healthy;
      return {state_, CaptureBackendAction::None, active_};
    }

    state_ = CaptureBackendState::Degraded;
    if (now < next_reinitialize_at_) {
      return {state_, CaptureBackendAction::None, active_};
    }
    // Count recovery attempts, not capture-loop observations. A backend can
    // report the same failure many times while backoff is active; treating
    // every observation as a new failure skips the required first
    // reinitialization and switches backends immediately.
    ++consecutive_failures_;

    // DXGI_ERROR_ACCESS_LOST invalidates only IDXGIOutputDuplication. It is
    // expected during desktop and display-mode transitions and does not mean
    // that DXGI or the D3D device failed. Stay on DXGI and keep recreating the
    // duplication interface with bounded backoff until a frame confirms that
    // the new session is usable.
    if (observation.error == ScreenGpuCaptureErrorCode::AccessLost) {
      scheduleBackoff(now, kAccessLostMaxRetry);
      state_ = CaptureBackendState::Reinitializing;
      return {
          state_,
          CaptureBackendAction::ReinitializeActive,
          CaptureBackend::Dxgi,
      };
    }

    scheduleBackoff(now);

    if (active_ == CaptureBackend::Dxgi && consecutive_failures_ >= 2) {
      state_ = CaptureBackendState::Reinitializing;
      return {
          state_,
          CaptureBackendAction::SwitchBackend,
          CaptureBackend::Wgc,
      };
    }
    if (active_ == CaptureBackend::Wgc && consecutive_failures_ >= 2) {
      state_ = CaptureBackendState::Reinitializing;
      return {
          state_,
          CaptureBackendAction::SwitchBackend,
          CaptureBackend::Dxgi,
      };
    }

    if (observation.error == ScreenGpuCaptureErrorCode::DeviceLost) {
      state_ = CaptureBackendState::Reinitializing;
      return {state_, CaptureBackendAction::RecreateDevice, active_};
    }

    state_ = CaptureBackendState::Reinitializing;
    return {state_, CaptureBackendAction::ReinitializeActive, active_};
  }

  [[nodiscard]] CaptureBackendDecision observePublicationStall(
      Clock::time_point now) noexcept {
    std::lock_guard lock(publication_mutex_);
    while (!publication_recovery_attempts_.empty() &&
           now - publication_recovery_attempts_.front() >=
               kPublicationRecoveryWindow) {
      publication_recovery_attempts_.pop_front();
    }
    if (publication_recovery_failed_) {
      return {CaptureBackendState::Failed, CaptureBackendAction::None, active_};
    }
    if (now < next_publication_recovery_at_) {
      return {state_, CaptureBackendAction::None, active_};
    }
    if (publication_recovery_attempts_.size() >=
        kMaxPublicationRecoveryAttempts) {
      publication_recovery_failed_ = true;
      state_ = CaptureBackendState::Failed;
      return {state_, CaptureBackendAction::Fail, active_};
    }
    publication_recovery_attempts_.push_back(now);
    const auto exponent = std::min<std::size_t>(
        publication_recovery_attempts_.size() - 1, 4);
    next_publication_recovery_at_ =
        now + std::chrono::milliseconds(250 * (std::size_t{1} << exponent));
    return {
        CaptureBackendState::Reinitializing,
        CaptureBackendAction::RestartPublication,
        active_,
    };
  }

  void resetPublicationRecovery() noexcept {
    std::lock_guard lock(publication_mutex_);
    publication_recovery_attempts_.clear();
    next_publication_recovery_at_ = {};
    publication_recovery_failed_ = false;
  }

  [[nodiscard]] std::size_t publicationRecoveryCount() const noexcept {
    std::lock_guard lock(publication_mutex_);
    return publication_recovery_attempts_.size();
  }

  void backendActivated(
      CaptureBackend backend,
      Clock::time_point now,
      bool recovered = false) noexcept {
    const bool switched_backend = active_ != backend;
    active_ = backend;
    state_ = CaptureBackendState::Reinitializing;
    // A newly selected backend gets its own recovery attempt budget. Preserve
    // exponential backoff across switches so two broken backends cannot form a
    // hot DXGI/WGC ping-pong loop.
    if (switched_backend) consecutive_failures_ = 0;
    if (recovered) ++successful_recoveries_;
    if (last_success_at_ == Clock::time_point{}) last_success_at_ = now;
    if (backend != preferred_) {
      preferred_probe_at_ = now + kPreferredProbeInterval;
    }
  }

  void activationFailed(Clock::time_point now) noexcept {
    state_ = CaptureBackendState::Degraded;
    scheduleBackoff(now);
    if (active_ != preferred_) {
      preferred_probe_at_ = now + kPreferredProbeInterval;
    }
  }

  [[nodiscard]] CaptureBackend activeBackend() const noexcept {
    return active_;
  }

  [[nodiscard]] CaptureBackendState state() const noexcept { return state_; }
  [[nodiscard]] std::uint64_t successfulRecoveryCount() const noexcept {
    return successful_recoveries_;
  }

  [[nodiscard]] Clock::time_point nextRetryAt() const noexcept {
    return next_reinitialize_at_;
  }

  static constexpr auto kSecureDesktopRetry = std::chrono::milliseconds(200);
  static constexpr auto kPreferredProbeInterval = std::chrono::seconds(30);
  static constexpr auto kAcquireWatchdog = std::chrono::seconds(15);
  static constexpr auto kAccessLostMaxRetry = std::chrono::seconds(1);
  static constexpr std::size_t kMaxPublicationRecoveryAttempts = 3;
  static constexpr auto kPublicationRecoveryWindow = std::chrono::seconds(60);

 private:
  void scheduleBackoff(
      Clock::time_point now,
      std::chrono::milliseconds maximum = std::chrono::seconds(5)) noexcept {
    constexpr auto base = std::chrono::milliseconds(250);
    const auto multiplier = std::uint32_t{1}
        << std::min<std::uint32_t>(backoff_exponent_, 4);
    next_reinitialize_at_ =
        now + std::min(maximum, base * multiplier);
    backoff_exponent_ = std::min<std::uint32_t>(backoff_exponent_ + 1, 5);
  }

  CaptureBackend active_;
  CaptureBackend preferred_;
  CaptureBackendState state_ = CaptureBackendState::Healthy;
  std::uint32_t consecutive_failures_ = 0;
  std::uint32_t backoff_exponent_ = 0;
  std::uint64_t successful_recoveries_ = 0;
  Clock::time_point last_success_at_{};
  Clock::time_point next_reinitialize_at_{};
  Clock::time_point preferred_probe_at_{};
  std::deque<Clock::time_point> publication_recovery_attempts_;
  Clock::time_point next_publication_recovery_at_{};
  bool publication_recovery_failed_ = false;
  mutable std::mutex publication_mutex_;
};

}  // namespace syrnike::desktop_native::media
