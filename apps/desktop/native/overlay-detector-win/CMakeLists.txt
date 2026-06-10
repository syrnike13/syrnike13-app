cmake_minimum_required(VERSION 3.20)

project(syrnike_overlay_detector_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

add_executable(syrnike-overlay-detector-win
  src/main.cpp
)

target_link_libraries(syrnike-overlay-detector-win PRIVATE user32 dwmapi)

target_compile_definitions(syrnike-overlay-detector-win PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
