cmake_minimum_required(VERSION 3.20)

project(syrnike_native_voice_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

if(LIVEKIT_LOCAL_SDK_DIR)
  list(PREPEND CMAKE_PREFIX_PATH "${LIVEKIT_LOCAL_SDK_DIR}")
else()
  include(LiveKitSDK)
  livekit_sdk_setup(
    VERSION "${LIVEKIT_SDK_VERSION}"
    SDK_DIR "${CMAKE_BINARY_DIR}/_deps/livekit-sdk"
    GITHUB_TOKEN "$ENV{GITHUB_TOKEN}"
  )
endif()

find_package(LiveKit CONFIG REQUIRED)

add_executable(syrnike-native-voice-win
  src/audio_devices.cpp
  src/audio_processing.cpp
  src/main.cpp
  src/microphone_preview.cpp
  src/microphone_publisher.cpp
  src/protocol.cpp
  src/runtime_config.cpp
)

target_link_libraries(syrnike-native-voice-win PRIVATE
  LiveKit::livekit
  ole32
  avrt
)

target_compile_definitions(syrnike-native-voice-win PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
