#pragma once

#include <string>
#include <string_view>
#include <utility>

namespace syrnike::desktop_native::tests {

class ExpectedPublisherTrackFilter final {
 public:
  explicit ExpectedPublisherTrackFilter(std::string expected_identity)
      : expected_identity_(std::move(expected_identity)) {}

  [[nodiscard]] bool acceptsPublisher(
      std::string_view publisher_identity) const noexcept {
    return !publisher_identity.empty() &&
        publisher_identity == expected_identity_;
  }

  [[nodiscard]] bool accepts(
      std::string_view publisher_identity,
      std::string_view publication_sid,
      std::string_view track_sid) const noexcept {
    return acceptsPublisher(publisher_identity) &&
        !publication_sid.empty() && publication_sid == track_sid;
  }

 private:
  std::string expected_identity_;
};

}  // namespace syrnike::desktop_native::tests
