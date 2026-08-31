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

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/LiveKitSDK.cmake")
windows_media_setup_livekit_sdk()
find_package(LiveKit CONFIG REQUIRED)

add_library(media_livekit STATIC
  src/livekit/livekit_room_transport.cpp
)
windows_media_target(media_livekit)
target_include_directories(media_livekit PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(media_livekit PUBLIC media_core LiveKit::livekit)

add_executable(media_probe
  src/probe/media_probe.cpp
)
windows_media_target(media_probe)
target_link_libraries(media_probe PRIVATE media_core)

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

if(WINDOWS_MEDIA_BUILD_LAB)
  add_executable(native_media_lab_publisher
    src/lab/native_media_lab_publisher.cpp
  )
  windows_media_target(native_media_lab_publisher)
  target_compile_definitions(native_media_lab_publisher PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(native_media_lab_publisher PRIVATE media_core media_livekit LiveKit::livekit)

  get_filename_component(_livekit_cmake_parent "${LiveKit_DIR}" DIRECTORY)
  get_filename_component(_livekit_lib_dir "${_livekit_cmake_parent}" DIRECTORY)
  target_link_directories(native_media_lab_publisher PRIVATE "${_livekit_lib_dir}")
  windows_media_copy_livekit_runtime(native_media_lab_publisher)
endif()
