#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media_contention_handoff_table.hpp"

namespace {

using syrnike::desktop_native::tests::ObservedVideoHandoffTable;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void skippedInitialFramesAllowALaterExactMatch() {
  ObservedVideoHandoffTable<512> handoffs;
  handoffs.observe(1, 10'001);
  handoffs.observe(2, 10'002);
  handoffs.observe(5, 10'005);

  require(
      handoffs.claim(5, 10'005),
      "a later remotely delivered handoff was not claimed");
  require(
      !handoffs.claim(1, 10'001),
      "the matcher claimed a second pipeline identity");
}

void mismatchedIdentityIsRejected() {
  ObservedVideoHandoffTable<512> handoffs;
  handoffs.observe(7, 20'007);

  require(!handoffs.claim(7, 20'008), "a mismatched timestamp was accepted");
  require(!handoffs.claim(8, 20'007), "a mismatched frame id was accepted");
  require(handoffs.claim(7, 20'007), "the exact identity was not accepted");
}

void wrapEvictsOnlyTheOverwrittenIdentity() {
  ObservedVideoHandoffTable<4> handoffs;
  for (std::uint32_t frame_id = 1; frame_id <= 5; ++frame_id) {
    handoffs.observe(frame_id, 30'000 + frame_id);
  }

  require(!handoffs.claim(1, 30'001), "an overwritten identity survived wrap");
  require(handoffs.claim(5, 30'005), "the newest wrapped identity was lost");
}

}  // namespace

int main() try {
  skippedInitialFramesAllowALaterExactMatch();
  mismatchedIdentityIsRejected();
  wrapEvictsOnlyTheOverwrittenIdentity();
  std::cout << "media contention handoff table tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
