#include <array>
#include <chrono>
#include <iostream>
#include <stdexcept>

#include "media/capture_backend_supervisor.hpp"

namespace {
using namespace std::chrono_literals;
using namespace syrnike::desktop_native::media;

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
}  // namespace

int main() try {
  const auto started = CaptureBackendSupervisor::Clock::now();

  CaptureBackendSupervisor static_desktop;
  for (int second = 0; second <= 60; ++second) {
    const auto decision = static_desktop.observe(
        {ScreenGpuFrameStatus::NoFrame}, started + std::chrono::seconds(second));
    require(
        decision.action == CaptureBackendAction::None,
        "a static desktop triggered capture recovery");
  }
  CaptureBackendSupervisor encoder_stall;
  for (int second = 0; second <= 60; ++second) {
    const auto encoder_decision = encoder_stall.observe(
        {ScreenGpuFrameStatus::EncoderBackpressure},
        started + std::chrono::seconds(second));
    require(
        encoder_decision.action == CaptureBackendAction::None &&
            encoder_decision.state == CaptureBackendState::Healthy,
        "downstream RTP/encoder stall triggered capture-backend recovery");
  }
  auto publication_decision = encoder_stall.observePublicationStall(started);
  require(
      publication_decision.action == CaptureBackendAction::RestartPublication,
      "unified supervisor did not command the first republish");
  publication_decision = encoder_stall.observePublicationStall(started + 1ms);
  require(
      publication_decision.action == CaptureBackendAction::None,
      "publication recovery bypassed supervisor backoff");
  publication_decision =
      encoder_stall.observePublicationStall(started + 250ms);
  require(
      publication_decision.action == CaptureBackendAction::RestartPublication,
      "unified supervisor did not command the second republish");
  publication_decision =
      encoder_stall.observePublicationStall(started + 750ms);
  require(
      publication_decision.action == CaptureBackendAction::RestartPublication,
      "unified supervisor did not command the third republish");
  publication_decision =
      encoder_stall.observePublicationStall(started + 1750ms);
  require(
      publication_decision.action == CaptureBackendAction::RestartPublication,
      "publication recovery became terminal after repeated stalls");
  publication_decision = encoder_stall.observePublicationStall(started + 3s);
  require(
      publication_decision.action == CaptureBackendAction::None,
      "publication recovery bypassed its capped backoff");
  publication_decision = encoder_stall.observePublicationStall(started + 3750ms);
  require(
      publication_decision.action == CaptureBackendAction::RestartPublication &&
          encoder_stall.publicationRecoveryCount() == 5,
      "publication recovery did not remain available with bounded retries");
  CaptureBackendSupervisor frozen_dxgi;
  frozen_dxgi.backendActivated(CaptureBackend::Dxgi, started);
  auto decision = frozen_dxgi.observe(
      {
          ScreenGpuFrameStatus::NoFrame,
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          false,
          true,
      },
      started + 16s);
  require(
      decision.action == CaptureBackendAction::ReinitializeActive,
      "DXGI acquire watchdog ignored independent desktop activity");

  CaptureBackendSupervisor tdr;
  decision = tdr.observe(
      {ScreenGpuFrameStatus::FatalError,
       ScreenGpuCaptureErrorCode::DeviceLost},
      started);
  require(
      decision.action == CaptureBackendAction::RecreateDevice,
      "device removal did not recreate the D3D device");
  tdr.backendActivated(CaptureBackend::Dxgi, started + 1s, true);
  require(
      tdr.successfulRecoveryCount() == 0 &&
          tdr.recoveryAttemptCount() == 1,
      "unconfirmed D3D recreation was counted as successful");
  decision = tdr.observe(
      {ScreenGpuFrameStatus::NewFrame}, started + 2s);
  require(
      decision.state == CaptureBackendState::Healthy &&
          tdr.successfulRecoveryCount() == 1,
      "TDR recovery did not return to healthy");

  CaptureBackendSupervisor repeated_wgc_device_loss(CaptureBackend::Wgc);
  decision = repeated_wgc_device_loss.observe(
      {
          ScreenGpuFrameStatus::FatalError,
          ScreenGpuCaptureErrorCode::DeviceLost,
      },
      started);
  require(
      decision.action == CaptureBackendAction::RecreateDevice &&
          decision.target == CaptureBackend::Wgc,
      "first WGC device loss did not recreate the active device");
  repeated_wgc_device_loss.backendActivated(
      CaptureBackend::Wgc, started + 1ms, true);
  decision = repeated_wgc_device_loss.observe(
      {
          ScreenGpuFrameStatus::FatalError,
          ScreenGpuCaptureErrorCode::DeviceLost,
      },
      started + 250ms);
  require(
      decision.action == CaptureBackendAction::SwitchBackend &&
          decision.target == CaptureBackend::Dxgi,
      "repeated WGC device loss did not fall back to DXGI");

  CaptureBackendSupervisor secure;
  decision = secure.observe(
      {ScreenGpuFrameStatus::FatalError,
       ScreenGpuCaptureErrorCode::CaptureUnavailable,
       true},
      started);
  require(
      decision.state == CaptureBackendState::NoContent &&
          decision.action == CaptureBackendAction::None,
      "secure desktop changed or killed the capture backend");

  CaptureBackendSupervisor fallback;
  decision = fallback.observe(
      {ScreenGpuFrameStatus::RecoverableLost}, started);
  require(
      decision.action == CaptureBackendAction::ReinitializeActive,
      "first DXGI failure did not reinitialize the active backend");
  for (int millisecond = 1; millisecond < 250; ++millisecond) {
    decision = fallback.observe(
        {ScreenGpuFrameStatus::RecoverableLost},
        started + std::chrono::milliseconds(millisecond));
    require(
        decision.action == CaptureBackendAction::None,
        "capture-loop failures bypassed recovery backoff");
  }
  decision = fallback.observe(
      {ScreenGpuFrameStatus::RecoverableLost}, started + 250ms);
  require(
      decision.action == CaptureBackendAction::SwitchBackend &&
          decision.target == CaptureBackend::Wgc,
      "second recovery attempt did not select WGC");

  fallback.backendActivated(CaptureBackend::Wgc, started + 250ms);
  decision =
      fallback.observe({ScreenGpuFrameStatus::NewFrame}, started + 1s);
  decision = fallback.observe({ScreenGpuFrameStatus::NewFrame}, started + 31s);
  require(
      decision.action == CaptureBackendAction::ProbePreferredBackend &&
          decision.target == CaptureBackend::Dxgi,
      "healthy WGC fallback did not periodically probe DXGI");

  CaptureBackendSupervisor access_lost;
  const CaptureBackendObservation access_lost_observation{
      ScreenGpuFrameStatus::RecoverableLost,
      ScreenGpuCaptureErrorCode::AccessLost,
  };
  const std::array access_lost_attempts{
      started,
      started + 250ms,
      started + 750ms,
      started + 1750ms,
      started + 2750ms,
      started + 3750ms,
  };
  for (const auto attempt_at : access_lost_attempts) {
    decision = access_lost.observe(access_lost_observation, attempt_at);
    require(
        decision.action == CaptureBackendAction::ReinitializeActive &&
            decision.target == CaptureBackend::Dxgi,
        "DXGI access loss switched away from desktop duplication");
    require(
        access_lost.nextRetryAt() - attempt_at <= 1s,
        "DXGI access-loss retry backoff exceeded one second");
    access_lost.backendActivated(CaptureBackend::Dxgi, attempt_at, true);
  }
  decision = access_lost.observe(
      {ScreenGpuFrameStatus::NewFrame}, started + 4s);
  require(
      decision.state == CaptureBackendState::Healthy &&
          decision.action == CaptureBackendAction::None &&
          access_lost.successfulRecoveryCount() == 1,
      "DXGI access-loss recovery did not return to healthy after a frame");

  CaptureBackendSupervisor failed_access_lost;
  decision = failed_access_lost.observe(access_lost_observation, started);
  require(
      decision.action == CaptureBackendAction::ReinitializeActive,
      "ACCESS_LOST did not begin with duplication recreation");
  failed_access_lost.activationFailed(decision, started);
  require(
      failed_access_lost.nextRetryAt() - started <= 1s,
      "failed ACCESS_LOST reinitialization exceeded one-second backoff");
  decision = failed_access_lost.observe(
      access_lost_observation, failed_access_lost.nextRetryAt());
  require(
      decision.action == CaptureBackendAction::RecreateDevice &&
          decision.target == CaptureBackend::Dxgi,
      "failed duplication recreation did not reselect DXGI device/output");
  const auto device_failure_at = failed_access_lost.nextRetryAt();
  failed_access_lost.activationFailed(decision, device_failure_at);
  require(
      failed_access_lost.nextRetryAt() - device_failure_at <= 1s,
      "failed fresh DXGI device exceeded one-second backoff");
  decision = failed_access_lost.observe(
      access_lost_observation, failed_access_lost.nextRetryAt());
  require(
      decision.action == CaptureBackendAction::SwitchBackend &&
          decision.target == CaptureBackend::Wgc,
      "failed fresh DXGI device did not fall back to WGC");

  CaptureBackendSupervisor gpu_timeout;
  const CaptureBackendObservation gpu_timeout_observation{
      ScreenGpuFrameStatus::RecoverableLost,
      ScreenGpuCaptureErrorCode::GpuTimeout,
  };
  const std::array gpu_timeout_attempts{
      started,
      started + 250ms,
      started + 750ms,
      started + 1750ms,
      started + 2750ms,
  };
  for (const auto attempt_at : gpu_timeout_attempts) {
    decision = gpu_timeout.observe(gpu_timeout_observation, attempt_at);
    require(
        decision.action == CaptureBackendAction::RecreateDevice &&
            decision.target == CaptureBackend::Dxgi,
        "exhausted GPU generations did not recreate the active device");
    require(
        gpu_timeout.nextRetryAt() - attempt_at <= 1s,
        "GPU timeout recovery backoff exceeded one second");
    gpu_timeout.backendActivated(CaptureBackend::Dxgi, attempt_at, true);
  }

  CaptureBackendSupervisor ping_pong;
  decision = ping_pong.observe(
      {ScreenGpuFrameStatus::RecoverableLost}, started);
  decision = ping_pong.observe(
      {ScreenGpuFrameStatus::RecoverableLost}, started + 250ms);
  require(
      decision.action == CaptureBackendAction::SwitchBackend &&
          decision.target == CaptureBackend::Wgc,
      "repeated generic DXGI failure did not switch to WGC");
  ping_pong.backendActivated(CaptureBackend::Wgc, started + 250ms);
  decision = ping_pong.observe(
      {
          ScreenGpuFrameStatus::FatalError,
          ScreenGpuCaptureErrorCode::DeviceLost,
      },
      started + 750ms);
  require(
      decision.action == CaptureBackendAction::RecreateDevice &&
          decision.target == CaptureBackend::Wgc,
      "new WGC backend did not receive its own device-recreation attempt");
  ping_pong.backendActivated(CaptureBackend::Wgc, started + 750ms, true);
  decision = ping_pong.observe(
      {
          ScreenGpuFrameStatus::FatalError,
          ScreenGpuCaptureErrorCode::DeviceLost,
      },
      started + 1750ms);
  require(
      decision.action == CaptureBackendAction::SwitchBackend &&
          decision.target == CaptureBackend::Dxgi,
      "repeated WGC failure did not return to DXGI");

  std::cout << "capture backend supervisor scenarios passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
