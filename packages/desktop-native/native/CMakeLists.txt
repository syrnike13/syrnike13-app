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
include(LiveKitSDK)
livekit_sdk_setup(
  VERSION "${LIVEKIT_SDK_VERSION}"
  REVISION "7596552cdba189fd908c8daa1b55c353efd015a3"
  RUST_REVISION "dad794d414fda9e8c1de83af1c0f190506a15f8f"
  SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/livekit-client"
)
# The vendored SDK uses C++17 internally; restore the consumer's standard.
set(CMAKE_CXX_STANDARD 20)

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
      "${LIVEKIT_FFI_RUNTIME_FILE}"
      "$<TARGET_FILE_DIR:${target}>/livekit_ffi.dll"
    VERBATIM
  )
endfunction()

add_library(syrnike_media_core STATIC
  src/common/cleanup_supervisor.cpp
  src/common/diagnostic_log.cpp
  src/media/audio_devices.cpp
  src/media/audio_failure.cpp
  src/media/audio_failure.hpp
  src/media/audio_processing.cpp
  src/media/camera_actor.cpp
  src/media/camera_capture.cpp
  src/media/camera_device_notification.cpp
  src/media/display_sources.cpp
  src/media/livekit_voice_session.cpp
  src/media/media_incident_timeline.cpp
  src/media/media_runtime.cpp
  src/media/media_runtime_support.cpp
  src/media/media_operation.hpp
  src/media/microphone_actor.cpp
  src/media/microphone_audio_processor.cpp
  src/media/microphone_publication_controller.cpp
  src/media/microphone_echo_reference.cpp
  src/media/preview_actor.cpp
  src/media/remote_audio_ingress.cpp
  src/media/remote_audio_operation_supervisor.cpp
  src/media/remote_audio_playout.hpp
  src/media/remote_audio_output.cpp
  src/media/remote_publication_reconciler.cpp
  src/media/remote_video_bridge.cpp
  src/media/remote_video_texture_pool.cpp
  src/media/screen_actor.cpp
  src/media/screen_publication_controller.cpp
  src/media/screen_audio_capture.cpp
  src/media/screen_capture_target.cpp
  src/media/screen_capture_priority.cpp
  src/media/screen_dxgi_compositor.cpp
  src/media/screen_gpu_capture.cpp
  src/media/voice_gate.cpp
  src/media/voice_activity_detector.cpp
  src/media/voice_actor.cpp
  src/media/video_resource_admission.cpp
  src/media/windows_audio_session_policy.cpp
)
syrnike_native_target(syrnike_media_core)
target_link_libraries(syrnike_media_core PUBLIC
  LiveKit::livekit
  avrt
  cfgmgr32
  Mmdevapi
  mf
  mfplat
  mfreadwrite
  mfuuid
  ole32
  d3d11
  d3dcompiler
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

foreach(HOOK_RUNTIME hotkey overlay)
  add_library(syrnike_${HOOK_RUNTIME} MODULE
    ${CMAKE_JS_SRC}
    src/common/cleanup_supervisor.cpp
    src/common/diagnostic_log.cpp
    src/common/node_event_sink.cpp
    src/hooks/hooks_addon.cpp
  )
  set_target_properties(syrnike_${HOOK_RUNTIME} PROPERTIES PREFIX "" SUFFIX ".node")
  syrnike_native_target(syrnike_${HOOK_RUNTIME})
  target_include_directories(syrnike_${HOOK_RUNTIME} SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
  target_compile_definitions(syrnike_${HOOK_RUNTIME} PRIVATE
    NAPI_CPP_EXCEPTIONS
    NAPI_VERSION=${NAPI_VERSION}
    SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
    SYRNIKE_HOOK_RUNTIME_${HOOK_RUNTIME}=1
  )
  target_link_libraries(syrnike_${HOOK_RUNTIME} PRIVATE ${CMAKE_JS_LIB} syrnike_hooks_core)
  if(MSVC)
    target_link_libraries(syrnike_${HOOK_RUNTIME} PRIVATE delayimp)
    target_link_options(syrnike_${HOOK_RUNTIME} PRIVATE /DELAYLOAD:node.exe)
  endif()
endforeach()

enable_testing()

add_library(syrnike_native_message_contract_addon MODULE
  ${CMAKE_JS_SRC}
  src/common/node_event_sink.cpp
  tests/native_message_contract_addon.cpp
)
set_target_properties(syrnike_native_message_contract_addon PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)
syrnike_native_target(syrnike_native_message_contract_addon)
target_include_directories(
  syrnike_native_message_contract_addon SYSTEM PRIVATE
  ${CMAKE_JS_INC}
  "${NODE_ADDON_API_DIR}"
)
target_compile_definitions(syrnike_native_message_contract_addon PRIVATE
  NAPI_CPP_EXCEPTIONS
  NAPI_VERSION=${NAPI_VERSION}
  SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
  SYRNIKE_NATIVE_CONTRACT_RUNTIME_VALIDATION=1
)
target_link_libraries(
  syrnike_native_message_contract_addon PRIVATE
  ${CMAKE_JS_LIB}
  syrnike_media_core
)
if(MSVC)
  target_link_libraries(syrnike_native_message_contract_addon PRIVATE delayimp)
  target_link_options(
    syrnike_native_message_contract_addon PRIVATE
    /DELAYLOAD:node.exe
    /DELAYLOAD:livekit.dll
  )
endif()
syrnike_copy_livekit_runtime(syrnike_native_message_contract_addon)
if(WIN32)
  set(SYRNIKE_PNPM_LAUNCHER cmd /c pnpm)
else()
  set(SYRNIKE_PNPM_LAUNCHER pnpm)
endif()
add_test(
  NAME syrnike-native-message-contract-boundary-tests
  COMMAND "${CMAKE_COMMAND}" -E env
    "SYRNIKE_NATIVE_MESSAGE_CONTRACT_ADDON=$<TARGET_FILE:syrnike_native_message_contract_addon>"
    ${SYRNIKE_PNPM_LAUNCHER}
    --filter @syrnike13/desktop exec vitest run
    src/main/native-runtime/native-message-boundary.test.ts
)
set_tests_properties(
  syrnike-native-message-contract-boundary-tests PROPERTIES
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../.."
)

add_executable(syrnike-native-cleanup-supervisor-tests
  tests/cleanup_supervisor_test.cpp
  src/common/cleanup_supervisor.cpp
  src/common/diagnostic_log.cpp
)
syrnike_native_target(syrnike-native-cleanup-supervisor-tests)
add_test(
  NAME syrnike-native-cleanup-supervisor-tests
  COMMAND syrnike-native-cleanup-supervisor-tests
)

add_executable(syrnike-native-media-runtime-shutdown-order-tests
  tests/media_runtime_shutdown_order_test.cpp
)
syrnike_native_target(syrnike-native-media-runtime-shutdown-order-tests)
add_test(
  NAME syrnike-native-media-runtime-shutdown-order-tests
  COMMAND syrnike-native-media-runtime-shutdown-order-tests
)

add_executable(syrnike-native-windows-resource-snapshot-tests
  tests/windows_process_resource_snapshot_test.cpp
  tests/windows_process_resource_snapshot.cpp
)
syrnike_native_target(syrnike-native-windows-resource-snapshot-tests)
add_test(
  NAME syrnike-native-windows-resource-snapshot-tests
  COMMAND syrnike-native-windows-resource-snapshot-tests
)

add_executable(syrnike-native-camera-device-notification-tests
  tests/camera_device_notification_test.cpp
  src/media/camera_device_notification.cpp
)
syrnike_native_target(syrnike-native-camera-device-notification-tests)
target_link_libraries(
  syrnike-native-camera-device-notification-tests PRIVATE cfgmgr32
)
add_test(
  NAME syrnike-native-camera-device-notification-tests
  COMMAND syrnike-native-camera-device-notification-tests
)

add_executable(syrnike-native-renderer-texture-lease-registry-tests
  tests/renderer_texture_lease_registry_test.cpp
)
syrnike_native_target(
  syrnike-native-renderer-texture-lease-registry-tests
)
add_test(
  NAME syrnike-native-renderer-texture-lease-registry-tests
  COMMAND syrnike-native-renderer-texture-lease-registry-tests
)

add_executable(syrnike-native-video-resource-admission-tests
  tests/video_resource_admission_test.cpp
  src/media/video_resource_admission.cpp
)
syrnike_native_target(syrnike-native-video-resource-admission-tests)
add_test(
  NAME syrnike-native-video-resource-admission-tests
  COMMAND syrnike-native-video-resource-admission-tests
)

add_executable(syrnike-native-media-incident-timeline-tests
  tests/media_incident_timeline_test.cpp
  src/media/media_incident_timeline.cpp
  src/common/diagnostic_log.cpp
)
target_compile_definitions(syrnike-native-media-incident-timeline-tests PRIVATE
  SYRNIKE_MEDIA_TIMELINE_SAMPLER_GOLDEN_VECTORS="${CMAKE_CURRENT_SOURCE_DIR}/../../../test-fixtures/media-timeline-sampler-vectors.tsv"
)
syrnike_native_target(syrnike-native-media-incident-timeline-tests)
add_test(
  NAME syrnike-native-media-incident-timeline-tests
  COMMAND syrnike-native-media-incident-timeline-tests
)

add_executable(syrnike-native-actor-mailbox-tests
  tests/actor_mailbox_test.cpp
)
syrnike_native_target(syrnike-native-actor-mailbox-tests)
add_test(
  NAME syrnike-native-actor-mailbox-tests
  COMMAND syrnike-native-actor-mailbox-tests
)

add_executable(syrnike-native-voice-control-lane-tests
  tests/voice_control_lane_test.cpp
)
syrnike_native_target(syrnike-native-voice-control-lane-tests)
add_test(
  NAME syrnike-native-voice-control-lane-tests
  COMMAND syrnike-native-voice-control-lane-tests
)

add_executable(syrnike-native-message-policy-tests
  tests/native_message_policy_test.cpp
)
syrnike_native_target(syrnike-native-message-policy-tests)
add_test(
  NAME syrnike-native-message-policy-tests
  COMMAND syrnike-native-message-policy-tests
)

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

add_executable(syrnike-native-microphone-hot-path-tests
  tests/microphone_hot_path_test.cpp
  src/media/audio_processing.cpp
  src/media/microphone_audio_processor.cpp
  src/media/voice_gate.cpp
)
syrnike_native_target(syrnike-native-microphone-hot-path-tests)
target_link_libraries(
  syrnike-native-microphone-hot-path-tests PRIVATE LiveKit::livekit
)
syrnike_copy_livekit_runtime(syrnike-native-microphone-hot-path-tests)
add_test(
  NAME syrnike-native-microphone-hot-path-tests
  COMMAND syrnike-native-microphone-hot-path-tests
)

add_executable(syrnike-native-windows-audio-session-policy-tests
  tests/windows_audio_session_policy_test.cpp
  src/media/windows_audio_session_policy.cpp
)
syrnike_native_target(syrnike-native-windows-audio-session-policy-tests)
target_link_libraries(
  syrnike-native-windows-audio-session-policy-tests PRIVATE ole32
)
add_test(
  NAME syrnike-native-windows-audio-session-policy-tests
  COMMAND syrnike-native-windows-audio-session-policy-tests
)

add_executable(syrnike-native-windows-audio-policy-matrix
  tests/windows_audio_policy_matrix.cpp
  src/media/windows_audio_session_policy.cpp
)
syrnike_native_target(syrnike-native-windows-audio-policy-matrix)
target_link_libraries(
  syrnike-native-windows-audio-policy-matrix PRIVATE Mmdevapi ole32
)
add_test(
  NAME syrnike-native-windows-audio-policy-matrix
  COMMAND syrnike-native-windows-audio-policy-matrix
)

add_executable(syrnike-native-remote-audio-operation-supervisor-tests
  tests/remote_audio_operation_supervisor_test.cpp
  src/common/cleanup_supervisor.cpp
  src/common/diagnostic_log.cpp
  src/media/audio_failure.cpp
  src/media/remote_audio_operation_supervisor.cpp
)
syrnike_native_target(
  syrnike-native-remote-audio-operation-supervisor-tests
)
add_test(
  NAME syrnike-native-remote-audio-operation-supervisor-tests
  COMMAND syrnike-native-remote-audio-operation-supervisor-tests
)

add_executable(syrnike-native-remote-audio-output-adapter-tests
  tests/remote_audio_output_adapter_test.cpp
  src/common/cleanup_supervisor.cpp
  src/common/diagnostic_log.cpp
  src/media/audio_devices.cpp
  src/media/audio_failure.cpp
  src/media/remote_audio_ingress.cpp
  src/media/remote_audio_operation_supervisor.cpp
  src/media/remote_audio_output.cpp
  src/media/voice_activity_detector.cpp
  src/media/windows_audio_session_policy.cpp
)
syrnike_native_target(syrnike-native-remote-audio-output-adapter-tests)
target_link_libraries(
  syrnike-native-remote-audio-output-adapter-tests PRIVATE
  LiveKit::livekit
  avrt
  cfgmgr32
  Mmdevapi
  ole32
)
syrnike_copy_livekit_runtime(syrnike-native-remote-audio-output-adapter-tests)
add_test(
  NAME syrnike-native-remote-audio-output-adapter-tests
  COMMAND syrnike-native-remote-audio-output-adapter-tests
)

add_executable(syrnike-native-remote-publication-reconciler-tests
  tests/remote_publication_reconciler_test.cpp
  src/media/remote_publication_reconciler.cpp
)
syrnike_native_target(syrnike-native-remote-publication-reconciler-tests)
if(MSVC AND SYRNIKE_ENABLE_ASAN)
  # This focused test links generated protobuf objects directly. Match the
  # vendored LiveKit/protobuf dynamic CRT and STL annotation mode instead of
  # mixing them with the default ASan target settings.
  set_property(
    TARGET syrnike-native-remote-publication-reconciler-tests
    PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL"
  )
  target_compile_definitions(
    syrnike-native-remote-publication-reconciler-tests
    PRIVATE
      _DISABLE_OPTIONAL_ANNOTATION
      _DISABLE_STRING_ANNOTATION
      _DISABLE_VECTOR_ANNOTATION
  )
endif()

# Production-shaped microphone soak addon. It exports the same media runtime
# interface, but lives in an isolated output directory and links only test
# external ports around the real MediaRuntime/MicrophoneActor ownership tree.
add_library(syrnike_microphone_resilience_addon MODULE
  ${CMAKE_JS_SRC}
  src/common/node_event_sink.cpp
  tests/microphone_resilience_addon.cpp
)
set_target_properties(syrnike_microphone_resilience_addon PROPERTIES
  OUTPUT_NAME "syrnike_media"
  PREFIX ""
  SUFFIX ".node"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Debug"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Release"
  LIBRARY_OUTPUT_DIRECTORY_DEBUG
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Debug"
  LIBRARY_OUTPUT_DIRECTORY_RELEASE
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Release"
  ARCHIVE_OUTPUT_DIRECTORY_DEBUG
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Debug/import"
  ARCHIVE_OUTPUT_DIRECTORY_RELEASE
    "${CMAKE_CURRENT_BINARY_DIR}/microphone-resilience-addon/Release/import"
)
syrnike_native_target(syrnike_microphone_resilience_addon)
target_include_directories(
  syrnike_microphone_resilience_addon SYSTEM PRIVATE
  ${CMAKE_JS_INC}
  "${NODE_ADDON_API_DIR}"
)
target_compile_definitions(syrnike_microphone_resilience_addon PRIVATE
  NAPI_CPP_EXCEPTIONS
  NAPI_VERSION=${NAPI_VERSION}
  SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
)
target_link_libraries(
  syrnike_microphone_resilience_addon PRIVATE
  ${CMAKE_JS_LIB}
  syrnike_media_core
)
if(MSVC)
  target_link_libraries(syrnike_microphone_resilience_addon PRIVATE delayimp)
  target_link_options(
    syrnike_microphone_resilience_addon PRIVATE
    /DELAYLOAD:node.exe
    /DELAYLOAD:livekit.dll
  )
endif()
syrnike_copy_livekit_runtime(syrnike_microphone_resilience_addon)
if(NOT TARGET protobuf::libprotobuf)
  find_package(Protobuf CONFIG REQUIRED)
endif()
get_target_property(
  SYRNIKE_LIVEKIT_PROTO_INCLUDE_DIRECTORIES
  livekit_proto
  INCLUDE_DIRECTORIES
)
target_link_libraries(
  syrnike-native-remote-publication-reconciler-tests
  PRIVATE
    LiveKit::livekit
    livekit_proto
    protobuf::libprotobuf
)
target_include_directories(
  syrnike-native-remote-publication-reconciler-tests
  SYSTEM PRIVATE
    ${SYRNIKE_LIVEKIT_PROTO_INCLUDE_DIRECTORIES}
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-publication-reconciler-tests
)
add_test(
  NAME syrnike-native-remote-publication-reconciler-tests
  COMMAND syrnike-native-remote-publication-reconciler-tests
)

add_executable(syrnike-native-voice-activity-tests
  tests/voice_activity_detector_test.cpp
  src/media/voice_activity_detector.cpp
)
syrnike_native_target(syrnike-native-voice-activity-tests)
add_test(NAME syrnike-native-voice-activity-tests COMMAND syrnike-native-voice-activity-tests)

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

add_executable(syrnike-native-preview-actor-attempt-tests
  tests/preview_actor_attempt_test.cpp
)
syrnike_native_target(syrnike-native-preview-actor-attempt-tests)
target_link_libraries(
  syrnike-native-preview-actor-attempt-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-preview-actor-attempt-tests)
add_test(
  NAME syrnike-native-preview-actor-attempt-tests
  COMMAND syrnike-native-preview-actor-attempt-tests
)

add_executable(syrnike-native-livekit-voice-session-tests
  tests/livekit_voice_session_test.cpp
)
syrnike_native_target(syrnike-native-livekit-voice-session-tests)
target_link_libraries(syrnike-native-livekit-voice-session-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-livekit-voice-session-tests)
add_test(
  NAME syrnike-native-livekit-voice-session-tests
  COMMAND syrnike-native-livekit-voice-session-tests
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

add_executable(syrnike-native-microphone-resilience-soak-tests
  tests/microphone_resilience_soak_test.cpp
)
syrnike_native_target(syrnike-native-microphone-resilience-soak-tests)
target_link_libraries(
  syrnike-native-microphone-resilience-soak-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-microphone-resilience-soak-tests)
add_test(
  NAME syrnike-native-microphone-resilience-soak-tests
  COMMAND syrnike-native-microphone-resilience-soak-tests
)
set_tests_properties(
  syrnike-native-microphone-resilience-soak-tests
  PROPERTIES
    ENVIRONMENT "SYRNIKE_MICROPHONE_SOAK_PROFILE=ci"
    TIMEOUT 60
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

add_executable(syrnike-native-screen-capture-target-tests
  tests/screen_capture_target_test.cpp
  src/media/screen_capture_target.cpp
)
syrnike_native_target(syrnike-native-screen-capture-target-tests)
target_link_libraries(syrnike-native-screen-capture-target-tests PRIVATE user32)
add_test(
  NAME syrnike-native-screen-capture-target-tests
  COMMAND syrnike-native-screen-capture-target-tests
)

add_executable(syrnike-native-screen-capture-slot-state-tests
  tests/screen_capture_slot_state_test.cpp
)
syrnike_native_target(syrnike-native-screen-capture-slot-state-tests)
add_test(
  NAME syrnike-native-screen-capture-slot-state-tests
  COMMAND syrnike-native-screen-capture-slot-state-tests
)

add_executable(syrnike-native-screen-frame-pipeline-tests
  tests/screen_frame_pipeline_test.cpp
  src/common/cleanup_supervisor.cpp
  src/common/diagnostic_log.cpp
)
syrnike_native_target(syrnike-native-screen-frame-pipeline-tests)
add_test(
  NAME syrnike-native-screen-frame-pipeline-tests
  COMMAND syrnike-native-screen-frame-pipeline-tests
)

add_executable(syrnike-native-screen-stream-publisher-policy-soak-tests
  tests/screen_stream_publisher_policy_soak_test.cpp
)
syrnike_native_target(
  syrnike-native-screen-stream-publisher-policy-soak-tests
)
add_test(
  NAME syrnike-native-screen-stream-publisher-policy-soak-tests
  COMMAND syrnike-native-screen-stream-publisher-policy-soak-tests
)

add_executable(syrnike-native-remote-audio-ingress-soak-tests
  tests/remote_audio_ingress_soak_test.cpp
)
syrnike_native_target(syrnike-native-remote-audio-ingress-soak-tests)
target_link_libraries(
  syrnike-native-remote-audio-ingress-soak-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-audio-ingress-soak-tests
)
add_test(
  NAME syrnike-native-remote-audio-ingress-soak-tests
  COMMAND syrnike-native-remote-audio-ingress-soak-tests
)

add_executable(syrnike-native-screen-audio-packetizer-soak-tests
  tests/screen_audio_packetizer_soak_test.cpp
)
syrnike_native_target(syrnike-native-screen-audio-packetizer-soak-tests)
add_test(
  NAME syrnike-native-screen-audio-packetizer-soak-tests
  COMMAND syrnike-native-screen-audio-packetizer-soak-tests
)

add_executable(syrnike-native-screen-audio-capture-tests
  tests/screen_audio_capture_test.cpp
)
syrnike_native_target(syrnike-native-screen-audio-capture-tests)
target_link_libraries(
  syrnike-native-screen-audio-capture-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-screen-audio-capture-tests)
add_test(
  NAME syrnike-native-screen-audio-capture-tests
  COMMAND syrnike-native-screen-audio-capture-tests
)

add_executable(syrnike-native-display-source-window-probe-tests
  tests/display_source_window_probe_test.cpp
)
syrnike_native_target(syrnike-native-display-source-window-probe-tests)
add_test(
  NAME syrnike-native-display-source-window-probe-tests
  COMMAND syrnike-native-display-source-window-probe-tests
)

add_executable(syrnike-native-capture-backend-supervisor-tests
  tests/capture_backend_supervisor_test.cpp
)
syrnike_native_target(syrnike-native-capture-backend-supervisor-tests)
target_link_libraries(
  syrnike-native-capture-backend-supervisor-tests PRIVATE user32 dxgi
)
add_test(
  NAME syrnike-native-capture-backend-supervisor-tests
  COMMAND syrnike-native-capture-backend-supervisor-tests
)

add_executable(syrnike-native-camera-actor-lifecycle-tests
  tests/camera_actor_lifecycle_test.cpp
)
syrnike_native_target(syrnike-native-camera-actor-lifecycle-tests)
target_link_libraries(syrnike-native-camera-actor-lifecycle-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-camera-actor-lifecycle-tests)
add_test(
  NAME syrnike-native-camera-actor-lifecycle-tests
  COMMAND syrnike-native-camera-actor-lifecycle-tests
)

add_executable(syrnike-native-voice-actor-lifecycle-tests
  tests/voice_actor_lifecycle_test.cpp
)
syrnike_native_target(syrnike-native-voice-actor-lifecycle-tests)
target_link_libraries(syrnike-native-voice-actor-lifecycle-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-voice-actor-lifecycle-tests)
add_test(
  NAME syrnike-native-voice-actor-lifecycle-tests
  COMMAND syrnike-native-voice-actor-lifecycle-tests
)

add_executable(syrnike-native-remote-audio-output-failure-tests
  tests/remote_audio_output_failure_test.cpp
)
syrnike_native_target(syrnike-native-remote-audio-output-failure-tests)
target_link_libraries(syrnike-native-remote-audio-output-failure-tests PRIVATE syrnike_media_core)
syrnike_copy_livekit_runtime(syrnike-native-remote-audio-output-failure-tests)
add_test(
  NAME syrnike-native-remote-audio-output-failure-tests
  COMMAND syrnike-native-remote-audio-output-failure-tests
)

add_executable(syrnike-native-remote-video-bridge-shutdown-tests
  tests/remote_video_bridge_shutdown_test.cpp
)
syrnike_native_target(syrnike-native-remote-video-bridge-shutdown-tests)
target_link_libraries(
  syrnike-native-remote-video-bridge-shutdown-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-remote-video-bridge-shutdown-tests)
add_test(
  NAME syrnike-native-remote-video-bridge-shutdown-tests
  COMMAND syrnike-native-remote-video-bridge-shutdown-tests
)

add_executable(syrnike-native-remote-video-static-frame-tests
  tests/remote_video_static_frame_test.cpp
)
syrnike_native_target(syrnike-native-remote-video-static-frame-tests)
target_link_libraries(
  syrnike-native-remote-video-static-frame-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-remote-video-static-frame-tests)
add_test(
  NAME syrnike-native-remote-video-static-frame-tests
  COMMAND syrnike-native-remote-video-static-frame-tests
)
set_tests_properties(
  syrnike-native-remote-video-static-frame-tests
  PROPERTIES TIMEOUT 15
)

add_executable(syrnike-native-remote-video-renderer-stall-tests
  tests/remote_video_renderer_stall_test.cpp
)
syrnike_native_target(syrnike-native-remote-video-renderer-stall-tests)
target_link_libraries(
  syrnike-native-remote-video-renderer-stall-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-video-renderer-stall-tests
)
add_test(
  NAME syrnike-native-remote-video-renderer-stall-tests
  COMMAND syrnike-native-remote-video-renderer-stall-tests
)
set_tests_properties(
  syrnike-native-remote-video-renderer-stall-tests
  PROPERTIES TIMEOUT 30
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

add_executable(syrnike-native-d3d11-gpu-completion-tests
  tests/d3d11_gpu_completion_test.cpp
)
syrnike_native_target(syrnike-native-d3d11-gpu-completion-tests)
target_link_libraries(syrnike-native-d3d11-gpu-completion-tests PRIVATE d3d11 dxgi)
add_test(
  NAME syrnike-native-d3d11-gpu-completion-tests
  COMMAND syrnike-native-d3d11-gpu-completion-tests
)

add_executable(syrnike-native-remote-video-completion-control-tests
  tests/remote_video_texture_completion_control_test.cpp
)

add_executable(syrnike-native-remote-video-d3d-device-owner-tests
  tests/remote_video_d3d_device_owner_test.cpp
)
syrnike_native_target(syrnike-native-remote-video-d3d-device-owner-tests)
target_link_libraries(
  syrnike-native-remote-video-d3d-device-owner-tests PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-video-d3d-device-owner-tests
)
add_test(
  NAME syrnike-native-remote-video-d3d-device-owner-tests
  COMMAND syrnike-native-remote-video-d3d-device-owner-tests
)
syrnike_native_target(syrnike-native-remote-video-completion-control-tests)
target_link_libraries(
  syrnike-native-remote-video-completion-control-tests
  PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-video-completion-control-tests
)
add_test(
  NAME syrnike-native-remote-video-completion-control-tests
  COMMAND syrnike-native-remote-video-completion-control-tests
)

# Manual, non-gating benchmark for the exact decoded-BGRA to Electron shared
# texture path. It verifies cross-device contents and reports 1080p throughput.
add_executable(syrnike-native-remote-video-texture-pool-benchmark
  tests/remote_video_texture_pool_benchmark.cpp
)
syrnike_native_target(syrnike-native-remote-video-texture-pool-benchmark)
target_link_libraries(
  syrnike-native-remote-video-texture-pool-benchmark
  PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(
  syrnike-native-remote-video-texture-pool-benchmark
)

# Checked native priority policy and failure-outcome contract.
add_executable(syrnike-native-screen-capture-priority-tests
  tests/screen_capture_priority_test.cpp
  src/common/diagnostic_log.cpp
  src/media/screen_capture_priority.cpp
)
syrnike_native_target(syrnike-native-screen-capture-priority-tests)
target_link_libraries(
  syrnike-native-screen-capture-priority-tests PRIVATE avrt dxgi
)
add_test(
  NAME syrnike-native-screen-capture-priority-tests
  COMMAND syrnike-native-screen-capture-priority-tests
)

# The protocol writer keeps a blocked child stdout pipe off the media loop and
# reserves lossless capacity for control/anomaly records.
add_executable(syrnike-native-media-contention-protocol-writer-tests
  tests/media_contention_protocol_writer_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-protocol-writer-tests)
add_test(
  NAME syrnike-native-media-contention-protocol-writer-tests
  COMMAND syrnike-native-media-contention-protocol-writer-tests
)

add_executable(syrnike-native-media-contention-handoff-table-tests
  tests/media_contention_handoff_table_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-handoff-table-tests)
add_test(
  NAME syrnike-native-media-contention-handoff-table-tests
  COMMAND syrnike-native-media-contention-handoff-table-tests
)

add_executable(syrnike-native-media-contention-viewer-track-filter-tests
  tests/media_contention_viewer_track_filter_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-viewer-track-filter-tests)
add_test(
  NAME syrnike-native-media-contention-viewer-track-filter-tests
  COMMAND syrnike-native-media-contention-viewer-track-filter-tests
)

add_executable(syrnike-native-media-contention-resource-baseline-tests
  tests/media_contention_resource_baseline_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-resource-baseline-tests)
add_test(
  NAME syrnike-native-media-contention-resource-baseline-tests
  COMMAND syrnike-native-media-contention-resource-baseline-tests
)

add_executable(syrnike-native-media-contention-terminal-resource-tests
  tests/media_contention_terminal_resource_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-terminal-resource-tests)
add_test(
  NAME syrnike-native-media-contention-terminal-resource-tests
  COMMAND syrnike-native-media-contention-terminal-resource-tests
)

add_executable(syrnike-native-media-contention-audio-recovery-tests
  tests/media_contention_audio_recovery_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-audio-recovery-tests)
add_test(
  NAME syrnike-native-media-contention-audio-recovery-tests
  COMMAND syrnike-native-media-contention-audio-recovery-tests
)

add_executable(syrnike-native-media-contention-screen-cadence-tests
  tests/media_contention_screen_cadence_test.cpp
)
syrnike_native_target(syrnike-native-media-contention-screen-cadence-tests)
add_test(
  NAME syrnike-native-media-contention-screen-cadence-tests
  COMMAND syrnike-native-media-contention-screen-cadence-tests
)

# Manual production-shaped contention lane. Electron owns the orchestration,
# renderer fence, bounded artifact, and the short/ten-minute profiles.
add_executable(syrnike-native-media-contention-probe
  tests/media_contention_probe.cpp
  tests/windows_process_resource_snapshot.cpp
)
syrnike_native_target(syrnike-native-media-contention-probe)
target_link_libraries(
  syrnike-native-media-contention-probe PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-media-contention-probe)

add_executable(syrnike-native-screen-dxgi-compositor-tests
  tests/screen_dxgi_compositor_test.cpp
)
syrnike_native_target(syrnike-native-screen-dxgi-compositor-tests)
target_link_libraries(
  syrnike-native-screen-dxgi-compositor-tests
  PRIVATE syrnike_media_core
)
syrnike_copy_livekit_runtime(syrnike-native-screen-dxgi-compositor-tests)
add_test(
  NAME syrnike-native-screen-dxgi-compositor-tests
  COMMAND syrnike-native-screen-dxgi-compositor-tests
)

# Manual, non-gating benchmark. Run the executable directly; its hardware paths
# report SKIP rather than silently falling back when the adapter lacks support.
add_executable(syrnike-native-screen-streaming-benchmark
  tests/screen_streaming_benchmark.cpp
  tests/windows_process_resource_snapshot.cpp
  src/common/diagnostic_log.cpp
  src/media/screen_capture_target.cpp
  src/media/screen_capture_priority.cpp
  src/media/screen_dxgi_compositor.cpp
  src/media/screen_gpu_capture.cpp
  src/media/video_resource_admission.cpp
  tests/screen_video_capture_benchmark.cpp
)
syrnike_native_target(syrnike-native-screen-streaming-benchmark)
target_link_libraries(syrnike-native-screen-streaming-benchmark PRIVATE
  avrt
  d3d11
  d3dcompiler
  dxgi
  mf
  mfplat
  mfuuid
  ole32
  runtimeobject
  user32
)
