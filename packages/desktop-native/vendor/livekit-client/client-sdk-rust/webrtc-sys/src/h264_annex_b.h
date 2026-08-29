/*
 * Copyright 2026 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <utility>

namespace livekit_ffi::h264 {

struct AnnexBNaluSpan {
  std::size_t start;
  std::size_t payload;
  std::size_t end;
};

// Iterates Annex-B NAL units without allocating on the media path.
class AnnexBNaluIterator final {
 public:
  AnnexBNaluIterator(const std::uint8_t* data, std::size_t size)
      : data_(data), size_(size), current_(FindStartCode(data, size, 0)) {}

  std::optional<AnnexBNaluSpan> Next() {
    if (!current_.has_value()) return std::nullopt;
    const std::size_t start = current_->first;
    const std::size_t payload = start + current_->second;
    const auto next = FindStartCode(data_, size_, payload);
    current_ = next;
    return AnnexBNaluSpan{
        start, payload, next.has_value() ? next->first : size_};
  }

 private:
  static std::optional<std::pair<std::size_t, std::size_t>> FindStartCode(
      const std::uint8_t* data,
      std::size_t size,
      std::size_t from) {
    if (!data) return std::nullopt;
    for (std::size_t i = from; i + 3 <= size; ++i) {
      if (data[i] != 0 || data[i + 1] != 0) continue;
      if (data[i + 2] == 1) return std::pair{i, std::size_t{3}};
      if (i + 4 <= size && data[i + 2] == 0 && data[i + 3] == 1) {
        return std::pair{i, std::size_t{4}};
      }
    }
    return std::nullopt;
  }

  const std::uint8_t* data_;
  std::size_t size_;
  std::optional<std::pair<std::size_t, std::size_t>> current_;
};

}  // namespace livekit_ffi::h264
