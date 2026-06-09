cmake_minimum_required(VERSION 3.20)

project(syrnike_hotkey_helper_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

add_executable(syrnike-hotkey-helper-win
  src/input_state.cpp
  src/key_codes.cpp
  src/main.cpp
  src/protocol.cpp
)

target_link_libraries(syrnike-hotkey-helper-win PRIVATE user32)

target_compile_definitions(syrnike-hotkey-helper-win PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

enable_testing()

add_executable(syrnike-hotkey-helper-win-tests
  tests/hotkey_input_state_test.cpp
  src/input_state.cpp
  src/key_codes.cpp
  src/protocol.cpp
)

target_include_directories(syrnike-hotkey-helper-win-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(syrnike-hotkey-helper-win-tests PRIVATE user32)

target_compile_definitions(syrnike-hotkey-helper-win-tests PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

add_test(
  NAME syrnike-hotkey-helper-win-tests
  COMMAND syrnike-hotkey-helper-win-tests
)
