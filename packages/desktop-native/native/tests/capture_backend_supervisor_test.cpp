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
      publication_decision.action == CaptureBackendAction::Fail,
      "publication recovery budget did not terminate the session");
  publication_decision = encoder_stall.observePublicationStall(started + 3s);
  require(
      publication_decision.action == CaptureBackendAction::None,
      "exhausted publication recovery emitted more than one terminal");
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
      tdr.successfulRecoveryCount() == 1,
      "successful D3D recreation was not counted");
  decision = tdr.observe(
      {ScreenGpuFrameStatus::NewFrame}, started + 2s);
  require(
      decision.state == CaptureBackendState::Healthy,
      "TDR recovery did not return to healthy");

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

  fallback.backendActivated(CaptureBackend::Wgc, started + 1s);
  decision =
      fallback.observe({ScreenGpuFrameStatus::NewFrame}, started + 2s);
  decision = fallback.observe({ScreenGpuFrameStatus::NewFrame}, started + 32s);
  require(
      decision.action == CaptureBackendAction::ProbePreferredBackend &&
          decision.target == CaptureBackend::Dxgi,
      "healthy WGC fallback did not periodically probe DXGI");

  std::cout << "capture backend supervisor scenarios passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
