#include <iostream>
#include <stdexcept>

#include "media_contention_viewer_track_filter.hpp"

namespace {

using syrnike::desktop_native::tests::ExpectedPublisherTrackFilter;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void stalePublisherTracksCannotSatisfyTheCurrentEpoch() {
  ExpectedPublisherTrackFilter filter("contention-publisher-2");

  require(
      !filter.acceptsPublisher("contention-publisher-1"),
      "a stale publisher identity satisfied the next epoch");
  require(
      !filter.acceptsPublisher(""),
      "an empty publisher identity was accepted");
  require(
      filter.acceptsPublisher("contention-publisher-2"),
      "the current epoch publisher identity was rejected");
  require(
      !filter.accepts("contention-publisher-1", "TR_current", "TR_current"),
      "a stale publisher track satisfied the next epoch");
  require(
      !filter.accepts("", "TR_current", "TR_current"),
      "a track without a publisher identity was accepted");
  require(
      !filter.accepts("contention-publisher-2", "TR_old", "TR_current"),
      "a publication/track SID alias was accepted");
  require(
      filter.accepts("contention-publisher-2", "TR_current", "TR_current"),
      "the current epoch publisher track was rejected");
}

}  // namespace

int main() try {
  stalePublisherTracksCannotSatisfyTheCurrentEpoch();
  std::cout << "media contention viewer track filter tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
