#pragma once

#include <atomic>
#include <cstdint>

namespace syrnike::windows_media::lab {
// Only the opt-in lab build compiles these hooks. Requests are consumed once
// by the selected renderer epoch, on its own worker outside any WASAPI lease.
inline std::atomic_uint64_t render_probe_epoch{0};
inline std::atomic_uint32_t render_delay_ms{0};
inline std::atomic_bool render_stop_client{false};
inline std::atomic_bool render_device_loss{false};
// Only the output owner's retry schedule uses this test clock. WASAPI start,
// progress and shutdown keep their real clocks and production deadlines.
inline std::atomic_int64_t output_retry_time_ms{-1};
inline std::atomic_uint32_t decoded_reader_delay_ms{0};
}
