cmake_minimum_required(VERSION 3.20)

project(syrnike_windows_media_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_COMPILE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

option(WINDOWS_MEDIA_ENABLE_ASAN "Enable AddressSanitizer for lifecycle tests" OFF)
option(WINDOWS_MEDIA_BUILD_LAB "Build the isolated LiveKit media lab publisher" OFF)

if(NOT DEFINED NAPI_VERSION OR "${NAPI_VERSION}" STREQUAL "")
  set(NAPI_VERSION 8)
endif()

if(NOT DEFINED WINDOWS_MEDIA_COMMIT OR "${WINDOWS_MEDIA_COMMIT}" STREQUAL "")
  execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../.."
    OUTPUT_VARIABLE WINDOWS_MEDIA_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
  )
  if("${WINDOWS_MEDIA_COMMIT}" STREQUAL "")
    set(WINDOWS_MEDIA_COMMIT "unknown")
  endif()
endif()

function(windows_media_target target)
  target_include_directories(${target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_compile_definitions(${target} PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /Zi /FS)
    target_link_options(${target} PRIVATE /DEBUG:FULL)
    if(WINDOWS_MEDIA_ENABLE_ASAN)
      set_property(TARGET ${target} PROPERTY
        MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
      )
      target_compile_options(${target} PRIVATE /fsanitize=address)
      target_link_options(${target} PRIVATE /INCREMENTAL:NO)
    else()
      target_compile_options(${target} PRIVATE /guard:cf)
      target_link_options(${target} PRIVATE /guard:cf)
    endif()
  endif()
endfunction()

add_library(media_core STATIC
  src/core/engine.cpp
  src/core/room_owner.cpp
)
windows_media_target(media_core)
target_include_directories(media_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_library(media_preview_budget STATIC src/capture/optional_preview_budget.cpp)
windows_media_target(media_preview_budget)
target_include_directories(media_preview_budget PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_library(media_camera_core STATIC src/camera/camera_frame.cpp src/camera/camera_device_registry.cpp)
windows_media_target(media_camera_core)
target_link_libraries(media_camera_core PRIVATE bcrypt)
target_include_directories(media_camera_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
add_library(media_camera_devices STATIC src/camera/windows_camera_devices.cpp)
windows_media_target(media_camera_devices)
target_link_libraries(media_camera_devices PUBLIC media_camera_core PRIVATE mf mfplat mfuuid ole32 setupapi cfgmgr32 uuid strmiids)
add_library(media_camera_capture STATIC src/camera/camera_capture.cpp src/camera/media_foundation_camera.cpp)
windows_media_target(media_camera_capture)
target_link_libraries(media_camera_capture PUBLIC media_camera_core PRIVATE mf mfplat mfreadwrite mfuuid ole32)
add_library(media_camera_pipeline STATIC src/camera/camera_pipeline.cpp)
windows_media_target(media_camera_pipeline)
target_link_libraries(media_camera_pipeline PUBLIC media_camera_capture)
add_library(media_camera_publication STATIC src/camera/camera_publication.cpp)
windows_media_target(media_camera_publication)
target_link_libraries(media_camera_publication PUBLIC media_camera_core media_livekit)
add_library(media_camera_preview STATIC src/camera/camera_preview.cpp)
windows_media_target(media_camera_preview)
target_link_libraries(media_camera_preview PUBLIC media_camera_core media_capture media_preview_budget)
add_library(media_camera_owner STATIC src/camera/camera_owner.cpp)
windows_media_target(media_camera_owner)
target_link_libraries(media_camera_owner PUBLIC media_camera_pipeline media_camera_devices media_camera_publication media_camera_preview)
add_library(media_camera_fixture STATIC src/lab/synthetic_camera_reader.cpp)
windows_media_target(media_camera_fixture)
target_link_libraries(media_camera_fixture PUBLIC media_camera_capture)

add_executable(camera_tests tests/camera_test.cpp)
windows_media_target(camera_tests)
target_link_libraries(camera_tests PRIVATE media_camera_pipeline media_camera_fixture media_camera_preview media_screen)
add_test(NAME camera COMMAND camera_tests)
set_tests_properties(camera PROPERTIES TIMEOUT 300)
add_test(NAME camera-preview COMMAND camera_tests --preview)
set_tests_properties(camera-preview PROPERTIES TIMEOUT 30 LABELS "requires-gpu-video")
add_test(NAME camera-preview-quarantine COMMAND camera_tests --preview-quarantine)
set_tests_properties(camera-preview-quarantine PROPERTIES TIMEOUT 30 LABELS "requires-gpu-video")

add_library(media_sources STATIC
  src/sources/source_registry.cpp
  src/sources/utf8.cpp
  src/sources/win32_source_enumerator.cpp
)
windows_media_target(media_sources)
target_include_directories(media_sources PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_sources PRIVATE dwmapi shcore)

add_library(media_capture STATIC
  src/capture/backend_selection_policy.cpp
  src/capture/selecting_monitor_capture.cpp
  src/capture/dxgi_frame_compositor.cpp
  src/capture/dxgi_monitor_capture.cpp
  src/capture/d3d11_device.cpp
  src/capture/monitor_capture.cpp
  src/capture/window_capture.cpp
  src/capture/wgc_capture_support.cpp
  src/capture/wgc_monitor_capture.cpp
  src/capture/wgc_window_capture.cpp
)
windows_media_target(media_capture)
target_include_directories(media_capture PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_capture PUBLIC media_sources PRIVATE d3d11 dxgi dxguid windowsapp d3dcompiler)

add_library(media_screen STATIC
  src/screen/screen_frame_pipeline.cpp
  src/screen/screen_frame_marker.cpp
  src/screen/cpu_screen_converter.cpp
  src/screen/gpu_screen_converter.cpp
  src/screen/hardware_h264_capability.cpp
  src/screen/hardware_h264_encoder.cpp
  src/screen/production_screen_pipeline.cpp
  src/screen/production_screen_adaptation.cpp
  src/screen/production_screen_sender.cpp
  src/screen/local_screen_preview.cpp
)
windows_media_target(media_screen)
target_include_directories(media_screen PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen PUBLIC media_capture media_preview_budget PRIVATE
  mf mfplat mfuuid wmcodecdspuuid)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/LiveKitSDK.cmake")
windows_media_setup_livekit_sdk()
find_package(LiveKit CONFIG REQUIRED)

add_library(media_livekit STATIC
  src/livekit/livekit_room_transport.cpp
  src/livekit/livekit_network_sampler.cpp
)
windows_media_target(media_livekit)
target_include_directories(media_livekit PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_livekit PUBLIC media_core LiveKit::livekit)

add_library(media_screen_audio_capture STATIC
  src/audio/screen_audio_pcm.cpp
  src/audio/process_loopback.cpp
  src/audio/screen_audio_owner.cpp
)
windows_media_target(media_screen_audio_capture)
target_include_directories(media_screen_audio_capture PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen_audio_capture PUBLIC media_sources PRIVATE mmdevapi ole32)

add_library(media_audio_devices STATIC
  src/audio/audio_device_catalog.cpp
  src/audio/audio_device_registry.cpp
  src/audio/windows_audio_device_enumerator.cpp
)
windows_media_target(media_audio_devices)
target_include_directories(media_audio_devices PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_audio_devices PRIVATE mmdevapi ole32 uuid bcrypt)

add_library(media_microphone_capture STATIC
  src/audio/microphone_pcm.cpp
  src/audio/microphone_capture.cpp
)
windows_media_target(media_microphone_capture)
target_include_directories(media_microphone_capture PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_microphone_capture PUBLIC media_audio_devices PRIVATE avrt)

add_library(media_microphone_dsp STATIC src/audio/microphone_dsp.cpp)
windows_media_target(media_microphone_dsp)
target_include_directories(media_microphone_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_library(media_remote_audio_pcm STATIC src/audio/remote_audio_pcm.cpp src/audio/remote_render_plan.cpp)
windows_media_target(media_remote_audio_pcm)
target_include_directories(media_remote_audio_pcm PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_library(media_remote_audio_mixer STATIC src/audio/remote_audio_mixer_worker.cpp)
windows_media_target(media_remote_audio_mixer)
target_link_libraries(media_remote_audio_mixer PUBLIC media_remote_audio_pcm PRIVATE avrt)

add_library(media_wasapi_output STATIC src/audio/wasapi_output.cpp src/audio/remote_audio_output.cpp)
windows_media_target(media_wasapi_output)
target_link_libraries(media_wasapi_output PUBLIC media_remote_audio_mixer media_audio_devices PRIVATE avrt)

add_library(media_microphone_pipeline STATIC src/audio/microphone_pipeline.cpp)
windows_media_target(media_microphone_pipeline)
target_link_libraries(media_microphone_pipeline PUBLIC media_microphone_capture media_microphone_dsp PRIVATE avrt)

add_library(media_microphone_livekit STATIC src/audio/microphone_sender.cpp src/audio/livekit_microphone_dsp.cpp
  src/audio/microphone_owner.cpp)
windows_media_target(media_microphone_livekit)
target_link_libraries(media_microphone_livekit PUBLIC media_microphone_pipeline media_livekit)

add_library(media_remote_audio_livekit STATIC src/audio/remote_audio_tracks.cpp)
windows_media_target(media_remote_audio_livekit)
target_link_libraries(media_remote_audio_livekit PUBLIC media_remote_audio_mixer media_livekit)

add_library(media_output_owner STATIC src/audio/output_owner.cpp)
windows_media_target(media_output_owner)
target_link_libraries(media_output_owner PUBLIC media_remote_audio_livekit media_wasapi_output)

add_library(media_screen_audio_livekit STATIC src/audio/screen_audio_sender.cpp)
windows_media_target(media_screen_audio_livekit)
target_link_libraries(media_screen_audio_livekit PUBLIC media_screen_audio_capture media_livekit)

add_library(media_video STATIC src/video/shared_texture_pool.cpp src/video/remote_video_track.cpp
  src/video/remote_video_owner.cpp)
windows_media_target(media_video)
target_link_libraries(media_video PUBLIC media_capture LiveKit::livekit PRIVATE dxgi)

add_library(media_screen_livekit STATIC
  src/lab/reference_screen_sender.cpp
  src/livekit/livekit_screen_publication_adapter.cpp
)
windows_media_target(media_screen_livekit)
target_include_directories(media_screen_livekit PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen_livekit PUBLIC media_screen LiveKit::livekit)
add_library(media_screen_owner STATIC src/screen/screen_owner.cpp)
windows_media_target(media_screen_owner)
target_link_libraries(media_screen_owner PUBLIC media_screen_livekit media_livekit media_screen_audio_capture)
add_library(media_product_runtime STATIC src/core/windows_media_runtime.cpp src/video/frame_export_owner.cpp
  src/sources/thumbnail_owner.cpp)
windows_media_target(media_product_runtime)
target_include_directories(media_product_runtime PUBLIC src)
target_link_libraries(media_product_runtime PUBLIC media_microphone_livekit media_output_owner
  media_camera_owner media_screen_owner media_screen_audio_livekit media_video)

add_executable(media_probe
  src/probe/media_probe.cpp
  src/probe/window_capture_probe.cpp
)
windows_media_target(media_probe)
target_link_libraries(media_probe PRIVATE media_core media_sources)
target_link_libraries(media_probe PRIVATE media_capture)
target_link_libraries(media_probe PRIVATE media_audio_devices)

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.."
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
file(TO_CMAKE_PATH "${NODE_ADDON_API_DIR}" NODE_ADDON_API_DIR)

add_library(windows_media MODULE
  ${CMAKE_JS_SRC}
  src/addon/windows_media_addon.cpp
)
set_target_properties(windows_media PROPERTIES PREFIX "" SUFFIX ".node")
windows_media_target(windows_media)
target_include_directories(
  windows_media SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}"
)
target_compile_definitions(windows_media PRIVATE
  NAPI_CPP_EXCEPTIONS
  NAPI_VERSION=${NAPI_VERSION}
  WINDOWS_MEDIA_COMMIT="${WINDOWS_MEDIA_COMMIT}"
)
target_link_libraries(windows_media PRIVATE ${CMAKE_JS_LIB} media_product_runtime)
windows_media_copy_livekit_runtime(windows_media)
add_library(windows_media_texture_broker MODULE ${CMAKE_JS_SRC} src/addon/texture_handle_broker.cpp)
set_target_properties(windows_media_texture_broker PROPERTIES PREFIX "" SUFFIX ".node")
windows_media_target(windows_media_texture_broker)
target_include_directories(windows_media_texture_broker SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
target_compile_definitions(windows_media_texture_broker PRIVATE NAPI_CPP_EXCEPTIONS NAPI_VERSION=${NAPI_VERSION})
target_link_libraries(windows_media_texture_broker PRIVATE ${CMAKE_JS_LIB})
if(MSVC)
  target_link_libraries(windows_media_texture_broker PRIVATE delayimp)
  target_link_options(windows_media_texture_broker PRIVATE /DELAYLOAD:node.exe)
  target_link_libraries(windows_media PRIVATE delayimp)
  target_link_options(windows_media PRIVATE /DELAYLOAD:node.exe)
endif()

enable_testing()

add_executable(product_runtime_tests tests/product_runtime_test.cpp)
windows_media_target(product_runtime_tests)
target_link_libraries(product_runtime_tests PRIVATE media_product_runtime)
add_test(NAME product-thumbnails COMMAND product_runtime_tests --thumbnails)
set_tests_properties(product-thumbnails PROPERTIES TIMEOUT 60 LABELS "requires-gpu-video")
windows_media_copy_livekit_runtime(product_runtime_tests)
add_test(NAME product-runtime COMMAND product_runtime_tests)
set_tests_properties(product-runtime PROPERTIES TIMEOUT 30)

add_executable(audio_device_registry_tests tests/audio_device_registry_test.cpp)
windows_media_target(audio_device_registry_tests)
target_link_libraries(audio_device_registry_tests PRIVATE media_audio_devices)
add_test(NAME audio-device-registry COMMAND audio_device_registry_tests)
set_tests_properties(audio-device-registry PROPERTIES TIMEOUT 10)

add_executable(microphone_pcm_tests tests/microphone_pcm_test.cpp)
windows_media_target(microphone_pcm_tests)
target_link_libraries(microphone_pcm_tests PRIVATE media_microphone_capture)
add_test(NAME microphone-pcm COMMAND microphone_pcm_tests)
set_tests_properties(microphone-pcm PROPERTIES TIMEOUT 20)

add_executable(microphone_dsp_tests tests/microphone_dsp_test.cpp)
windows_media_target(microphone_dsp_tests)
target_link_libraries(microphone_dsp_tests PRIVATE media_microphone_dsp)
add_test(NAME microphone-dsp COMMAND microphone_dsp_tests)
set_tests_properties(microphone-dsp PROPERTIES TIMEOUT 10)

add_executable(remote_audio_tests tests/remote_audio_test.cpp)
windows_media_target(remote_audio_tests)
target_link_libraries(remote_audio_tests PRIVATE media_remote_audio_mixer)
add_test(NAME remote-audio COMMAND remote_audio_tests)
set_tests_properties(remote-audio PROPERTIES TIMEOUT 20)

add_executable(backend_selection_policy_tests tests/backend_selection_policy_test.cpp)
windows_media_target(backend_selection_policy_tests)
target_link_libraries(backend_selection_policy_tests PRIVATE media_capture)
add_test(NAME backend-selection-policy COMMAND backend_selection_policy_tests)
set_tests_properties(backend-selection-policy PROPERTIES TIMEOUT 10)
add_executable(dxgi_capture_tests tests/dxgi_capture_test.cpp)
windows_media_target(dxgi_capture_tests)
target_link_libraries(dxgi_capture_tests PRIVATE media_capture)
add_test(NAME dxgi-capture COMMAND dxgi_capture_tests)
set_tests_properties(dxgi-capture PROPERTIES TIMEOUT 180 LABELS "requires-gpu-video")
add_executable(selecting_monitor_capture_tests tests/selecting_monitor_capture_test.cpp)
windows_media_target(selecting_monitor_capture_tests)
target_link_libraries(selecting_monitor_capture_tests PRIVATE media_capture)
add_test(NAME selecting-monitor-capture COMMAND selecting_monitor_capture_tests)
set_tests_properties(selecting-monitor-capture PROPERTIES TIMEOUT 30)
add_executable(screen_frame_cadence_tests tests/screen_frame_cadence_test.cpp)
windows_media_target(screen_frame_cadence_tests)
add_test(NAME screen-frame-cadence COMMAND screen_frame_cadence_tests)
add_test(NAME backend-selection-golden COMMAND ${CMAKE_COMMAND}
  -DPROBE=$<TARGET_FILE:backend_selection_policy_tests>
  -DGOLDEN=${CMAKE_CURRENT_SOURCE_DIR}/../../../docs/native-v2/backend-selection-golden.json
  -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_backend_golden.cmake)
add_executable(screen_encoded_continuity_tests tests/screen_encoded_continuity_test.cpp)
windows_media_target(screen_encoded_continuity_tests)
add_test(NAME screen-encoded-continuity COMMAND screen_encoded_continuity_tests)

add_executable(media_core_tests
  tests/engine_lifecycle_test.cpp
  tests/room_owner_test.cpp
)
windows_media_target(media_core_tests)
target_link_libraries(media_core_tests PRIVATE media_core)

if(MSVC AND WINDOWS_MEDIA_ENABLE_ASAN)
  get_filename_component(WINDOWS_MEDIA_MSVC_BIN "${CMAKE_CXX_COMPILER}" DIRECTORY)
  set(WINDOWS_MEDIA_ASAN_RUNTIME
    "${WINDOWS_MEDIA_MSVC_BIN}/clang_rt.asan_dynamic-x86_64.dll"
  )
  if(NOT EXISTS "${WINDOWS_MEDIA_ASAN_RUNTIME}")
    message(FATAL_ERROR "MSVC AddressSanitizer runtime was not found")
  endif()
  add_custom_command(TARGET media_core_tests POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
      "${WINDOWS_MEDIA_ASAN_RUNTIME}"
      "$<TARGET_FILE_DIR:media_core_tests>"
    VERBATIM
  )
endif()

add_test(NAME media-core-lifecycle COMMAND media_core_tests)
add_test(NAME media-probe-lifecycle-once COMMAND media_probe lifecycle-once)
add_test(NAME media-probe-fail-start COMMAND media_probe fail-start)
add_test(NAME media-probe-hang-worker COMMAND media_probe hang-worker)
add_test(NAME media-probe-enumerate-sources
  COMMAND media_probe enumerate-sources --repeat 10 --diff)
add_test(NAME media-probe-source-json-contract
  COMMAND powershell -NoProfile -NonInteractive -File
    "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/verify_source_probe_json.ps1"
    -Probe "$<TARGET_FILE:media_probe>")
add_test(NAME media-probe-monitor-capture-json-contract
  COMMAND powershell -NoProfile -NonInteractive -File
    "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/verify_monitor_capture_probe_json.ps1"
    -Probe "$<TARGET_FILE:media_probe>")
add_test(NAME media-probe-window-capture-json-contract
  COMMAND powershell -NoProfile -NonInteractive -File
    "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/verify_window_capture_probe_json.ps1"
    -Probe "$<TARGET_FILE:media_probe>")
add_test(NAME media-probe-source-invalid-repeat-junk
  COMMAND media_probe enumerate-sources --repeat 1junk)
add_test(NAME media-probe-source-invalid-repeat-sign
  COMMAND media_probe enumerate-sources --repeat +1)
add_test(NAME media-probe-source-invalid-repeat-range
  COMMAND media_probe enumerate-sources --repeat 1001)
set_tests_properties(
  media-probe-source-invalid-repeat-junk
  media-probe-source-invalid-repeat-sign
  media-probe-source-invalid-repeat-range
  PROPERTIES WILL_FAIL TRUE TIMEOUT 5)
set_tests_properties(
  media-probe-enumerate-sources
  media-probe-source-json-contract
  PROPERTIES TIMEOUT 30)
set_tests_properties(media-probe-monitor-capture-json-contract
  PROPERTIES TIMEOUT 180)
set_tests_properties(media-probe-window-capture-json-contract
  PROPERTIES TIMEOUT 240)

add_executable(source_registry_tests
  tests/source_registry_test.cpp
)
windows_media_target(source_registry_tests)
target_link_libraries(source_registry_tests PRIVATE media_sources)
add_test(NAME source-registry COMMAND source_registry_tests)
set_tests_properties(source-registry PROPERTIES TIMEOUT 10)

add_executable(source_window_fixture WIN32
  fixtures/source_window_fixture.cpp
)
windows_media_target(source_window_fixture)

add_executable(monitor_pattern_fixture WIN32
  fixtures/monitor_pattern_fixture.cpp
)
windows_media_target(monitor_pattern_fixture)
add_dependencies(media_probe monitor_pattern_fixture)
add_dependencies(media_probe source_window_fixture)

add_executable(source_win32_integration_tests
  tests/source_win32_integration_test.cpp
)
windows_media_target(source_win32_integration_tests)
target_link_libraries(source_win32_integration_tests PRIVATE media_sources)
add_dependencies(source_win32_integration_tests source_window_fixture)
add_test(NAME source-win32-integration COMMAND source_win32_integration_tests)
set_tests_properties(source-win32-integration PROPERTIES TIMEOUT 10)

add_executable(monitor_capture_tests
  tests/d3d11_device_test.cpp
  tests/monitor_capture_test.cpp
)
windows_media_target(monitor_capture_tests)
target_link_libraries(monitor_capture_tests PRIVATE media_capture)
add_test(NAME monitor-capture COMMAND monitor_capture_tests)
set_tests_properties(monitor-capture PROPERTIES TIMEOUT 10)

add_executable(window_capture_tests
  tests/window_capture_test.cpp
)
windows_media_target(window_capture_tests)
target_link_libraries(window_capture_tests PRIVATE media_capture)
add_test(NAME window-capture COMMAND window_capture_tests)
set_tests_properties(window-capture PROPERTIES TIMEOUT 30)

add_executable(screen_reference_tests
  tests/screen_reference_test.cpp
)
windows_media_target(screen_reference_tests)
target_link_libraries(screen_reference_tests PRIVATE media_screen)
add_test(NAME screen-reference COMMAND screen_reference_tests)
set_tests_properties(screen-reference PROPERTIES TIMEOUT 10)

add_library(media_screen_policy STATIC
  src/screen/adaptive_screen_policy.cpp src/screen/screen_keyframe_control.cpp)
windows_media_target(media_screen_policy)
target_include_directories(media_screen_policy PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen PUBLIC media_screen_policy)
add_executable(adaptive_screen_policy_tests tests/adaptive_screen_policy_test.cpp)
windows_media_target(adaptive_screen_policy_tests)
target_link_libraries(adaptive_screen_policy_tests PRIVATE media_screen_policy)

add_executable(screen_audio_pcm_tests tests/screen_audio_pcm_test.cpp)
windows_media_target(screen_audio_pcm_tests)
target_link_libraries(screen_audio_pcm_tests PRIVATE media_screen_audio_capture)
add_test(NAME screen-audio-pcm COMMAND screen_audio_pcm_tests)

add_executable(screen_audio_owner_tests tests/screen_audio_owner_test.cpp)
windows_media_target(screen_audio_owner_tests)
target_link_libraries(screen_audio_owner_tests PRIVATE media_screen_audio_capture)
add_test(NAME screen-audio-owner COMMAND screen_audio_owner_tests)
add_test(NAME adaptive-screen-policy COMMAND adaptive_screen_policy_tests)
add_executable(adaptive_screen_pipeline_tests tests/adaptive_screen_pipeline_test.cpp)
add_executable(live_bitrate_probe tests/live_bitrate_probe.cpp)
windows_media_target(live_bitrate_probe)
target_link_libraries(live_bitrate_probe PRIVATE media_screen)
windows_media_target(adaptive_screen_pipeline_tests)
target_link_libraries(adaptive_screen_pipeline_tests PRIVATE media_screen)
add_test(NAME adaptive-screen-pipeline COMMAND adaptive_screen_pipeline_tests)
set_tests_properties(adaptive-screen-pipeline PROPERTIES TIMEOUT 45 LABELS "requires-gpu-video")
set_tests_properties(adaptive-screen-policy PROPERTIES TIMEOUT 10)

add_executable(production_screen_sender_tests
  tests/production_screen_sender_test.cpp
)
windows_media_target(production_screen_sender_tests)
target_link_libraries(production_screen_sender_tests PRIVATE media_screen)
add_test(NAME production-screen-sender COMMAND production_screen_sender_tests)
set_tests_properties(production-screen-sender PROPERTIES TIMEOUT 10)

add_executable(gpu_screen_converter_tests
  tests/gpu_screen_converter_test.cpp
  tests/hardware_h264_capability_test.cpp
  tests/hardware_h264_encoder_test.cpp
)
windows_media_target(gpu_screen_converter_tests)
target_link_libraries(gpu_screen_converter_tests PRIVATE media_screen)
add_test(NAME gpu-screen-converter COMMAND gpu_screen_converter_tests)
set_tests_properties(gpu-screen-converter PROPERTIES TIMEOUT 30)

add_executable(encoder_fault_tests tests/encoder_fault_test.cpp)
add_executable(local_screen_preview_tests tests/local_screen_preview_test.cpp)
windows_media_target(local_screen_preview_tests)
target_link_libraries(local_screen_preview_tests PRIVATE media_screen)
add_test(NAME local-screen-preview COMMAND local_screen_preview_tests)
set_tests_properties(local-screen-preview PROPERTIES TIMEOUT 60 LABELS "requires-gpu-video")
windows_media_target(encoder_fault_tests)
target_link_libraries(encoder_fault_tests PRIVATE media_screen)
add_test(NAME encoder-faults COMMAND encoder_fault_tests)
set_tests_properties(encoder-faults PROPERTIES TIMEOUT 300)

# Hosted Windows runners expose no D3D11 Video interface. Keep these tests in
# the default full suite; only the hosted workflow selects the portable subset.
set_tests_properties(monitor-capture gpu-screen-converter encoder-faults
  PROPERTIES LABELS "requires-gpu-video")

if(WINDOWS_MEDIA_BUILD_LAB)
  add_executable(camera_lab src/lab/camera_lab.cpp)
  windows_media_target(camera_lab)
  target_compile_definitions(camera_lab PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(camera_lab PRIVATE media_camera_pipeline media_camera_devices media_camera_fixture
    media_camera_publication media_camera_preview media_core psapi)
  windows_media_copy_livekit_runtime(camera_lab)
  add_executable(apm_allocation_baseline src/lab/apm_allocation_baseline.cpp)
  windows_media_target(apm_allocation_baseline)
  target_link_libraries(apm_allocation_baseline PRIVATE LiveKit::livekit)
  windows_media_copy_livekit_runtime(apm_allocation_baseline)
  add_executable(media_lab src/lab/microphone_lab.cpp src/lab/microphone_pipeline_lab.cpp
    src/lab/microphone_ducking_lab.cpp src/lab/microphone_dsp_lab.cpp)
  windows_media_target(media_lab)
  target_link_libraries(media_lab PRIVATE media_microphone_livekit media_screen_audio_capture LiveKit::livekit)
  target_compile_definitions(media_lab PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_include_directories(media_lab PRIVATE tests)
  add_test(NAME microphone-candidate-fault COMMAND media_lab microphone-candidate-fault)
  set_tests_properties(microphone-candidate-fault PROPERTIES TIMEOUT 60 LABELS "requires-audio-device")
  windows_media_copy_livekit_runtime(media_lab)
  # Compile the production capture loop with disposable-process heap evidence;
  # allocator hooks never enter the product capture library or normal media_lab.
  add_executable(microphone_capture_allocation src/lab/microphone_capture_allocation.cpp
    src/audio/microphone_capture.cpp src/audio/microphone_pcm.cpp)
  windows_media_target(microphone_capture_allocation)
  target_include_directories(microphone_capture_allocation PRIVATE tests)
  target_compile_definitions(microphone_capture_allocation PRIVATE WINDOWS_MEDIA_CAPTURE_HEAP_PROBE)
  target_link_libraries(microphone_capture_allocation PRIVATE media_audio_devices avrt)
  add_test(NAME microphone-platform-faults COMMAND microphone_capture_allocation --fault-matrix)
  set_tests_properties(microphone-platform-faults PROPERTIES TIMEOUT 300 LABELS "requires-audio-device")
  add_executable(backend_capture_lab src/lab/backend_capture_lab.cpp)
  add_executable(backend_transition_lab src/lab/backend_transition_lab.cpp)
  # Explicit local proof only; restores the selected non-primary display mode.
  add_executable(display_mode_proof src/lab/display_mode_proof.cpp)
  windows_media_target(display_mode_proof)
  windows_media_target(backend_transition_lab)
  target_link_libraries(backend_transition_lab PRIVATE media_capture)
  windows_media_target(backend_capture_lab)
  target_link_libraries(backend_capture_lab PRIVATE media_capture)
  add_dependencies(backend_capture_lab monitor_pattern_fixture)
  add_library(preview_bridge_lab MODULE ${CMAKE_JS_SRC}
    src/lab/preview_bridge_addon.cpp src/lab/screen_cpu_lab.cpp src/lab/gpu_contention.cpp)
  set_target_properties(preview_bridge_lab PROPERTIES PREFIX "" SUFFIX ".node")
  windows_media_target(preview_bridge_lab)
  target_include_directories(preview_bridge_lab SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
  target_compile_definitions(preview_bridge_lab PRIVATE NAPI_CPP_EXCEPTIONS NAPI_VERSION=${NAPI_VERSION})
  target_link_libraries(preview_bridge_lab PRIVATE ${CMAKE_JS_LIB} media_screen_livekit media_livekit delayimp d3dcompiler)
  target_link_options(preview_bridge_lab PRIVATE /DELAYLOAD:node.exe)
  windows_media_copy_livekit_runtime(preview_bridge_lab)
  add_dependencies(preview_bridge_lab monitor_pattern_fixture source_window_fixture)
  add_executable(shared_texture_pool_tests tests/shared_texture_pool_test.cpp)
  windows_media_target(shared_texture_pool_tests)
  target_link_libraries(shared_texture_pool_tests PRIVATE media_video)
  windows_media_copy_livekit_runtime(shared_texture_pool_tests)
  add_test(NAME shared-texture-pool COMMAND shared_texture_pool_tests)
  set_tests_properties(shared-texture-pool PROPERTIES TIMEOUT 30)
  add_library(video_bridge_lab MODULE ${CMAKE_JS_SRC} src/lab/video_bridge_addon.cpp)
  set_target_properties(video_bridge_lab PROPERTIES PREFIX "" SUFFIX ".node")
  windows_media_target(video_bridge_lab)
  target_include_directories(video_bridge_lab SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}")
  target_compile_definitions(video_bridge_lab PRIVATE NAPI_CPP_EXCEPTIONS NAPI_VERSION=${NAPI_VERSION})
  target_link_libraries(video_bridge_lab PRIVATE ${CMAKE_JS_LIB} media_video media_livekit delayimp)
  windows_media_copy_livekit_runtime(video_bridge_lab)
  target_link_options(video_bridge_lab PRIVATE /DELAYLOAD:node.exe)
  add_executable(remote_video_contract_probe src/lab/remote_video_contract_probe.cpp)
  add_executable(remote_video_publisher src/lab/remote_video_publisher.cpp)
  windows_media_target(remote_video_publisher)
  target_compile_definitions(remote_video_publisher PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(remote_video_publisher PRIVATE LiveKit::livekit)
  windows_media_copy_livekit_runtime(remote_video_publisher)
  windows_media_target(remote_video_contract_probe)
  target_compile_definitions(remote_video_contract_probe PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(remote_video_contract_probe PRIVATE LiveKit::livekit)
  windows_media_copy_livekit_runtime(remote_video_contract_probe)

  add_executable(native_media_lab_publisher
    src/lab/native_media_lab_publisher.cpp
    src/lab/screen_cpu_lab.cpp
    src/lab/gpu_contention.cpp
  )
  add_executable(audio_sync_fixture src/lab/audio_sync_fixture.cpp)
  # Explicitly invoked local proof only: this helper temporarily changes and
  # restores normal default endpoints. Never run by the default lab or CI.
  add_executable(default_endpoint_proof src/lab/default_endpoint_proof.cpp)
  windows_media_target(default_endpoint_proof)
  add_dependencies(media_lab default_endpoint_proof)
  target_link_libraries(default_endpoint_proof PRIVATE ole32 uuid)
  windows_media_target(audio_sync_fixture)
  target_link_libraries(audio_sync_fixture PRIVATE winmm)
  add_executable(audio_capture_lab src/lab/audio_capture_lab.cpp)
  windows_media_target(audio_capture_lab)
  target_link_libraries(audio_capture_lab PRIVATE media_screen_audio_capture)
  add_executable(screen_audio_lab src/lab/screen_audio_lab.cpp src/lab/gpu_contention.cpp)
  windows_media_target(screen_audio_lab)
  target_compile_definitions(screen_audio_lab PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(screen_audio_lab PRIVATE media_screen_audio_livekit media_screen_livekit winmm d3dcompiler)
  windows_media_copy_livekit_runtime(screen_audio_lab)
  add_executable(remote_audio_reference src/lab/remote_audio_reference.cpp)
  add_library(media_wasapi_output_lab STATIC src/audio/wasapi_output.cpp src/audio/remote_audio_output.cpp)
  windows_media_target(media_wasapi_output_lab)
  target_compile_definitions(media_wasapi_output_lab PRIVATE WINDOWS_MEDIA_REMOTE_AUDIO_PROBE)
  target_link_libraries(media_wasapi_output_lab PUBLIC media_remote_audio_mixer media_audio_devices PRIVATE avrt)
  add_library(media_remote_audio_livekit_lab STATIC src/audio/remote_audio_tracks.cpp)
  windows_media_target(media_remote_audio_livekit_lab)
  target_compile_definitions(media_remote_audio_livekit_lab PRIVATE WINDOWS_MEDIA_REMOTE_AUDIO_PROBE)
  target_link_libraries(media_remote_audio_livekit_lab PUBLIC media_remote_audio_mixer media_livekit)
  add_executable(remote_audio_lab src/lab/remote_audio_lab.cpp src/lab/remote_audio_livekit_lab.cpp
    src/lab/remote_audio_output_lab.cpp src/lab/remote_audio_aec_lab.cpp src/lab/remote_audio_ducking_lab.cpp
    src/lab/remote_audio_echo_publication_lab.cpp src/audio/output_owner.cpp)
  windows_media_target(remote_audio_lab)
  target_include_directories(remote_audio_lab PRIVATE tests)
  target_link_libraries(remote_audio_lab PRIVATE media_wasapi_output_lab media_remote_audio_livekit_lab media_microphone_livekit
    media_screen_audio_capture psapi)
  target_compile_definitions(remote_audio_lab PRIVATE _CRT_SECURE_NO_WARNINGS)
  windows_media_copy_livekit_runtime(remote_audio_lab)
  add_test(NAME output-platform-faults COMMAND remote_audio_lab fault-matrix)
  set_tests_properties(output-platform-faults PROPERTIES TIMEOUT 180 LABELS "requires-audio-device")
  add_test(NAME output-cancellation-faults COMMAND remote_audio_lab cancellation)
  set_tests_properties(output-cancellation-faults PROPERTIES TIMEOUT 60 LABELS "requires-audio-device")
  windows_media_target(remote_audio_reference)
  target_compile_definitions(remote_audio_reference PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(remote_audio_reference PRIVATE LiveKit::livekit)
  windows_media_copy_livekit_runtime(remote_audio_reference)
  windows_media_target(native_media_lab_publisher)
  target_compile_definitions(native_media_lab_publisher PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(native_media_lab_publisher PRIVATE
    media_core media_livekit media_sources media_capture media_screen_livekit
    LiveKit::livekit d3dcompiler)
  add_dependencies(native_media_lab_publisher monitor_pattern_fixture source_window_fixture)

  get_filename_component(_livekit_cmake_parent "${LiveKit_DIR}" DIRECTORY)
  get_filename_component(_livekit_lib_dir "${_livekit_cmake_parent}" DIRECTORY)
  target_link_directories(native_media_lab_publisher PRIVATE "${_livekit_lib_dir}")
  windows_media_copy_livekit_runtime(native_media_lab_publisher)
endif()
