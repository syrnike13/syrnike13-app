cmake_minimum_required(VERSION 3.20)

project(syrnike_desktop_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_COMPILE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

option(SYRNIKE_ENABLE_ASAN "Enable AddressSanitizer for native core tests" OFF)

if(NOT DEFINED NAPI_VERSION OR "${NAPI_VERSION}" STREQUAL "")
  set(NAPI_VERSION 8)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

if(NOT DEFINED LIVEKIT_SDK_VERSION OR "${LIVEKIT_SDK_VERSION}" STREQUAL "")
  set(LIVEKIT_SDK_VERSION "v1.3.0")
endif()
if(NOT DEFINED LIVEKIT_SDK_SHA256 OR "${LIVEKIT_SDK_SHA256}" STREQUAL "")
  set(LIVEKIT_SDK_SHA256 "27a8707348d7fb094023b7c8af29e26b8e4085a4dab75d26be3968f29b2269c3")
endif()

include(LiveKitSDK)
livekit_sdk_setup(
  VERSION "${LIVEKIT_SDK_VERSION}"
  SDK_DIR "${CMAKE_BINARY_DIR}/_deps/livekit-sdk"
  SDK_SHA256 "${LIVEKIT_SDK_SHA256}"
  GITHUB_TOKEN "$ENV{GITHUB_TOKEN}"
)
find_package(LiveKit CONFIG REQUIRED)
string(REGEX REPLACE "^v" "" LIVEKIT_SDK_VERSION_NUMBER "${LIVEKIT_SDK_VERSION}")
set(LIVEKIT_RUNTIME_DIRECTORY
  "${CMAKE_BINARY_DIR}/_deps/livekit-sdk/livekit-sdk-windows-x64-${LIVEKIT_SDK_VERSION_NUMBER}/bin"
)

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.."
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
file(TO_CMAKE_PATH "${NODE_ADDON_API_DIR}" NODE_ADDON_API_DIR)

if(NOT DEFINED SYRNIKE_NATIVE_COMMIT OR "${SYRNIKE_NATIVE_COMMIT}" STREQUAL "")
  execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../.."
    OUTPUT_VARIABLE SYRNIKE_NATIVE_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
  if("${SYRNIKE_NATIVE_COMMIT}" STREQUAL "")
    set(SYRNIKE_NATIVE_COMMIT "unknown")
  endif()
endif()

function(syrnike_native_target target)
  target_include_directories(${target} PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  target_compile_definitions(${target} PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /Zi /FS)
    target_link_options(${target} PRIVATE /DEBUG:FULL)
    if(SYRNIKE_ENABLE_ASAN)
      set_property(TARGET ${target} PROPERTY
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
      )
      target_compile_options(${target} PRIVATE /fsanitize=address)
      target_link_options(${target} PRIVATE /INCREMENTAL:NO)
      get_filename_component(MSVC_COMPILER_DIRECTORY "${CMAKE_CXX_COMPILER}" DIRECTORY)
      add_custom_command(TARGET ${target} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${MSVC_COMPILER_DIRECTORY}/clang_rt.asan_dynamic-x86_64.dll"
          "$<TARGET_FILE_DIR:${target}>/clang_rt.asan_dynamic-x86_64.dll"
        VERBATIM
      )
    else()
      target_compile_options(${target} PRIVATE /guard:cf)
      target_link_options(${target} PRIVATE /guard:cf)
    endif()
  endif()
endfunction()

function(syrnike_copy_livekit_runtime target)
  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${LIVEKIT_RUNTIME_DIRECTORY}/livekit.dll"
      "$<TARGET_FILE_DIR:${target}>/livekit.dll"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${LIVEKIT_RUNTIME_DIRECTORY}/livekit_ffi.dll"
      "$<TARGET_FILE_DIR:${target}>/livekit_ffi.dll"
    VERBATIM
  )
endfunction()

add_library(syrnike_media_core STATIC
  src/common/diagnostic_log.cpp
  src/media/audio_devices.cpp
  src/media/audio_processing.cpp
  src/media/display_sources.cpp
  src/media/livekit_publication_client.cpp
  src/media/media_runtime.cpp
  src/media/microphone_actor.cpp
  src/media/microphone_audio_processor.cpp
  src/media/microphone_publication_controller.cpp
  src/media/microphone_echo_reference.cpp
  src/media/preview_actor.cpp
  src/media/screen_actor.cpp
  src/media/screen_publication_controller.cpp
  src/media/screen_audio_capture.cpp
  src/media/screen_capture_priority.cpp
  src/media/screen_video_capture.cpp
  src/media/voice_gate.cpp
)
syrnike_native_target(syrnike_media_core)
target_link_libraries(syrnike_media_core PUBLIC
  LiveKit::livekit
  avrt
  Mmdevapi
  ole32
  d3d11
  dwmapi
  dxgi
  runtimeobject
  Shell32
  user32
)

add_library(syrnike_hooks_core STATIC
  src/hooks/hooks_runtime.cpp
  src/hooks/input_state.cpp
  src/hooks/key_codes.cpp
)
syrnike_native_target(syrnike_hooks_core)
target_link_libraries(syrnike_hooks_core PUBLIC dwmapi user32)

add_library(syrnike_media MODULE
  ${CMAKE_JS_SRC}
  src/common/node_event_sink.cpp
  src/media/media_addon.cpp
)
set_target_properties(syrnike_media PROPERTIES PREFIX "" SUFFIX ".node")
syrnike_native_target(syrnike_media)
target_include_directories(syrnike_media SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
target_compile_definitions(syrnike_media PRIVATE
  NAPI_CPP_EXCEPTIONS
  NAPI_VERSION=${NAPI_VERSION}
  SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
)
target_link_libraries(syrnike_media PRIVATE ${CMAKE_JS_LIB} syrnike_media_core)
if(MSVC)
  target_link_libraries(syrnike_media PRIVATE delayimp)
  target_link_options(syrnike_media PRIVATE /DELAYLOAD:node.exe /DELAYLOAD:livekit.dll)
endif()

add_library(syrnike_hooks MODULE
  ${CMAKE_JS_SRC}
  src/common/node_event_sink.cpp
  src/hooks/hooks_addon.cpp
)
set_target_properties(syrnike_hooks PROPERTIES PREFIX "" SUFFIX ".node")
syrnike_native_target(syrnike_hooks)
target_include_directories(syrnike_hooks SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
target_compile_definitions(syrnike_hooks PRIVATE
  NAPI_CPP_EXCEPTIONS
  NAPI_VERSION=${NAPI_VERSION}
  SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
)
target_link_libraries(syrnike_hooks PRIVATE ${CMAKE_JS_LIB} syrnike_hooks_core)
if(MSVC)
  target_link_libraries(syrnike_hooks PRIVATE delayimp)
  target_link_options(syrnike_hooks PRIVATE /DELAYLOAD:node.exe)
endif()

enable_testing()
add_executable(syrnike-native-runtime-core-tests
  tests/runtime_core_test.cpp
  src/common/diagnostic_log.cpp
  src/hooks/input_state.cpp
  src/hooks/key_codes.cpp
)
syrnike_native_target(syrnike-native-runtime-core-tests)

add_test(NAME syrnike-native-runtime-core-tests COMMAND syrnike-native-runtime-core-tests)

add_executable(syrnike-native-media-processing-tests
  tests/media_processing_test.cpp
)
syrnike_native_target(syrnike-native-media-processing-tests)
target_link_libraries(syrnike-native-media-processing-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-media-processing-tests)
add_test(NAME syrnike-native-media-processing-tests COMMAND syrnike-native-media-processing-tests)

add_executable(syrnike-native-media-actor-lifecycle-tests
  tests/media_actor_lifecycle_test.cpp
)
syrnike_native_target(syrnike-native-media-actor-lifecycle-tests)
target_link_libraries(syrnike-native-media-actor-lifecycle-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-media-actor-lifecycle-tests)
add_test(
  NAME syrnike-native-media-actor-lifecycle-tests
  COMMAND syrnike-native-media-actor-lifecycle-tests
)

add_executable(syrnike-native-livekit-publication-client-tests
  tests/livekit_publication_client_test.cpp
)
syrnike_native_target(syrnike-native-livekit-publication-client-tests)
target_link_libraries(syrnike-native-livekit-publication-client-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-livekit-publication-client-tests)
add_test(
  NAME syrnike-native-livekit-publication-client-tests
  COMMAND syrnike-native-livekit-publication-client-tests
)

add_executable(syrnike-native-runtime-integration-tests
  tests/runtime_integration_test.cpp
)
syrnike_native_target(syrnike-native-runtime-integration-tests)
target_link_libraries(syrnike-native-runtime-integration-tests PRIVATE
  syrnike_media_core
  syrnike_hooks_core
)
syrnike_copy_livekit_runtime(syrnike-native-runtime-integration-tests)
add_test(
  NAME syrnike-native-runtime-integration-tests
  COMMAND syrnike-native-runtime-integration-tests
)

add_executable(syrnike-native-media-runtime-probe-tests
  tests/media_runtime_probe_test.cpp
)
syrnike_native_target(syrnike-native-media-runtime-probe-tests)
target_link_libraries(syrnike-native-media-runtime-probe-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-media-runtime-probe-tests)
add_test(
  NAME syrnike-native-media-runtime-probe-tests
  COMMAND syrnike-native-media-runtime-probe-tests
)

add_executable(syrnike-native-microphone-publication-control-plane-tests
  tests/microphone_publication_control_plane_test.cpp
)
syrnike_native_target(syrnike-native-microphone-publication-control-plane-tests)
target_link_libraries(
  syrnike-native-microphone-publication-control-plane-tests
  PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-microphone-publication-control-plane-tests)
add_test(
  NAME syrnike-native-microphone-publication-control-plane-tests
  COMMAND syrnike-native-microphone-publication-control-plane-tests
)

add_executable(syrnike-native-screen-publication-control-plane-tests
  tests/screen_publication_control_plane_test.cpp
)
syrnike_native_target(syrnike-native-screen-publication-control-plane-tests)
target_link_libraries(
  syrnike-native-screen-publication-control-plane-tests
  PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-screen-publication-control-plane-tests)
add_test(
  NAME syrnike-native-screen-publication-control-plane-tests
  COMMAND syrnike-native-screen-publication-control-plane-tests
)

add_executable(syrnike-native-hooks-runtime-lifecycle-tests
  tests/hooks_runtime_lifecycle_test.cpp
)
syrnike_native_target(syrnike-native-hooks-runtime-lifecycle-tests)
target_link_libraries(syrnike-native-hooks-runtime-lifecycle-tests PRIVATE syrnike_hooks_core)
add_test(
  NAME syrnike-native-hooks-runtime-lifecycle-tests
  COMMAND syrnike-native-hooks-runtime-lifecycle-tests
)
