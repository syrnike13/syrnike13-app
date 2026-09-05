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

add_library(media_sources STATIC
  src/sources/source_registry.cpp
  src/sources/utf8.cpp
  src/sources/win32_source_enumerator.cpp
)
windows_media_target(media_sources)
target_include_directories(media_sources PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_sources PRIVATE dwmapi shcore)

add_library(media_capture STATIC
  src/capture/d3d11_device.cpp
  src/capture/monitor_capture.cpp
  src/capture/window_capture.cpp
  src/capture/wgc_capture_support.cpp
  src/capture/wgc_monitor_capture.cpp
  src/capture/wgc_window_capture.cpp
)
windows_media_target(media_capture)
target_include_directories(media_capture PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_capture PUBLIC media_sources PRIVATE d3d11 dxgi dxguid windowsapp)

add_library(media_screen STATIC
  src/screen/screen_frame_pipeline.cpp
  src/screen/screen_frame_marker.cpp
  src/screen/cpu_screen_converter.cpp
  src/screen/gpu_screen_converter.cpp
  src/screen/hardware_h264_capability.cpp
  src/screen/hardware_h264_encoder.cpp
  src/screen/production_screen_pipeline.cpp
  src/screen/production_screen_sender.cpp
)
windows_media_target(media_screen)
target_include_directories(media_screen PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen PUBLIC media_capture PRIVATE
  mf mfplat mfuuid wmcodecdspuuid)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/LiveKitSDK.cmake")
windows_media_setup_livekit_sdk()
find_package(LiveKit CONFIG REQUIRED)

add_library(media_livekit STATIC
  src/livekit/livekit_room_transport.cpp
)
windows_media_target(media_livekit)
target_include_directories(media_livekit PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_livekit PUBLIC media_core LiveKit::livekit)

add_library(media_video STATIC src/video/shared_texture_pool.cpp src/video/remote_video_track.cpp)
windows_media_target(media_video)
target_link_libraries(media_video PUBLIC media_capture LiveKit::livekit PRIVATE dxgi)

add_library(media_screen_livekit STATIC
  src/lab/reference_screen_sender.cpp
  src/livekit/livekit_screen_publication_adapter.cpp
)
windows_media_target(media_screen_livekit)
target_include_directories(media_screen_livekit PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_screen_livekit PUBLIC media_screen LiveKit::livekit)

add_executable(media_probe
  src/probe/media_probe.cpp
  src/probe/window_capture_probe.cpp
)
windows_media_target(media_probe)
target_link_libraries(media_probe PRIVATE media_core media_sources)
target_link_libraries(media_probe PRIVATE media_capture)

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
target_link_libraries(windows_media PRIVATE ${CMAKE_JS_LIB} media_core media_livekit)
windows_media_copy_livekit_runtime(windows_media)
if(MSVC)
  target_link_libraries(windows_media PRIVATE delayimp)
  target_link_options(windows_media PRIVATE /DELAYLOAD:node.exe)
endif()

enable_testing()

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
set_tests_properties(window-capture PROPERTIES TIMEOUT 10)

add_executable(screen_reference_tests
  tests/screen_reference_test.cpp
)
windows_media_target(screen_reference_tests)
target_link_libraries(screen_reference_tests PRIVATE media_screen)
add_test(NAME screen-reference COMMAND screen_reference_tests)
set_tests_properties(screen-reference PROPERTIES TIMEOUT 10)

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
windows_media_target(encoder_fault_tests)
target_link_libraries(encoder_fault_tests PRIVATE media_screen)
add_test(NAME encoder-faults COMMAND encoder_fault_tests)
set_tests_properties(encoder-faults PROPERTIES TIMEOUT 20)

if(WINDOWS_MEDIA_BUILD_LAB)
  add_executable(shared_texture_pool_tests tests/shared_texture_pool_test.cpp)
  windows_media_target(shared_texture_pool_tests)
  target_link_libraries(shared_texture_pool_tests PRIVATE media_video)
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
  )
  windows_media_target(native_media_lab_publisher)
  target_compile_definitions(native_media_lab_publisher PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(native_media_lab_publisher PRIVATE
    media_core media_livekit media_sources media_capture media_screen_livekit
    LiveKit::livekit)
  add_dependencies(native_media_lab_publisher monitor_pattern_fixture source_window_fixture)

  get_filename_component(_livekit_cmake_parent "${LiveKit_DIR}" DIRECTORY)
  get_filename_component(_livekit_lib_dir "${_livekit_cmake_parent}" DIRECTORY)
  target_link_directories(native_media_lab_publisher PRIVATE "${_livekit_lib_dir}")
  windows_media_copy_livekit_runtime(native_media_lab_publisher)
endif()
