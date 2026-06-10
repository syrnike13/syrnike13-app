cmake_minimum_required(VERSION 3.20)

project(syrnike_native_voice_win LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
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
    SDK_SHA256 "${LIVEKIT_SDK_SHA256}"
    GITHUB_TOKEN "$ENV{GITHUB_TOKEN}"
  )
endif()

find_package(LiveKit CONFIG REQUIRED)

add_executable(syrnike-native-voice-win
  src/audio_devices.cpp
  src/audio_processing.cpp
  src/main.cpp
  src/microphone_audio_processor.cpp
  src/microphone_echo_reference.cpp
  src/microphone_preview.cpp
  src/microphone_publisher.cpp
  src/microphone_warmup.cpp
  src/protocol.cpp
  src/runtime_config.cpp
  src/screen_audio_capture.cpp
  src/screen_preflight.cpp
  src/screen_publisher.cpp
  src/screen_sources.cpp
  src/screen_video_capture.cpp
  src/voice_gate.cpp
)

target_link_libraries(syrnike-native-voice-win PRIVATE
  LiveKit::livekit
  d3d11
  dwmapi
  dxgi
  ole32
  user32
  Shell32
  Mmdevapi
  avrt
  runtimeobject
)

target_compile_definitions(syrnike-native-voice-win PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

enable_testing()

add_executable(syrnike-native-voice-win-tests
  tests/voice_gate_processor_test.cpp
  src/protocol.cpp
  src/runtime_config.cpp
  src/voice_gate.cpp
)

target_include_directories(syrnike-native-voice-win-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

add_test(
  NAME syrnike-native-voice-win-tests
  COMMAND syrnike-native-voice-win-tests
)

add_executable(syrnike-native-microphone-audio-processor-tests
  tests/microphone_audio_processor_test.cpp
  src/audio_processing.cpp
  src/microphone_audio_processor.cpp
  src/protocol.cpp
  src/voice_gate.cpp
)

target_include_directories(syrnike-native-microphone-audio-processor-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(syrnike-native-microphone-audio-processor-tests PRIVATE
  LiveKit::livekit
)

target_compile_definitions(syrnike-native-microphone-audio-processor-tests PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

add_test(
  NAME syrnike-native-microphone-audio-processor-tests
  COMMAND syrnike-native-microphone-audio-processor-tests
)

add_executable(syrnike-native-microphone-echo-reference-tests
  tests/microphone_echo_reference_test.cpp
  src/audio_devices.cpp
  src/microphone_echo_reference.cpp
  src/protocol.cpp
)

target_include_directories(syrnike-native-microphone-echo-reference-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(syrnike-native-microphone-echo-reference-tests PRIVATE
  Mmdevapi
  avrt
  ole32
)

target_compile_definitions(syrnike-native-microphone-echo-reference-tests PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)

add_test(
  NAME syrnike-native-microphone-echo-reference-tests
  COMMAND syrnike-native-microphone-echo-reference-tests
)
