cmake_minimum_required(VERSION 3.20)

project(syrnike_desktop_hooks LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")
set(CMAKE_COMPILE_PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<CONFIG>")

option(SYRNIKE_ENABLE_ASAN "Enable AddressSanitizer for native hook tests" OFF)

if(NOT DEFINED NAPI_VERSION OR "${NAPI_VERSION}" STREQUAL "")
  set(NAPI_VERSION 8)
endif()

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
  target_include_directories(${target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
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
    else()
      target_compile_options(${target} PRIVATE /guard:cf)
      target_link_options(${target} PRIVATE /guard:cf)
    endif()
  endif()
endfunction()

add_library(syrnike_hooks_core STATIC
  src/hooks/hooks_runtime.cpp
  src/hooks/input_state.cpp
  src/hooks/key_codes.cpp
)
syrnike_native_target(syrnike_hooks_core)
target_link_libraries(syrnike_hooks_core PUBLIC dwmapi user32)

foreach(HOOK_RUNTIME hotkey overlay)
  add_library(syrnike_${HOOK_RUNTIME} MODULE
    ${CMAKE_JS_SRC}
    src/common/cleanup_supervisor.cpp
    src/common/node_event_sink.cpp
    src/hooks/hooks_addon.cpp
  )
  set_target_properties(syrnike_${HOOK_RUNTIME} PROPERTIES PREFIX "" SUFFIX ".node")
  syrnike_native_target(syrnike_${HOOK_RUNTIME})
  target_include_directories(
    syrnike_${HOOK_RUNTIME} SYSTEM PRIVATE ${CMAKE_JS_INC} "${NODE_ADDON_API_DIR}"
  )
  target_compile_definitions(syrnike_${HOOK_RUNTIME} PRIVATE
    NAPI_CPP_EXCEPTIONS
    NAPI_VERSION=${NAPI_VERSION}
    SYRNIKE_NATIVE_COMMIT="${SYRNIKE_NATIVE_COMMIT}"
    SYRNIKE_HOOK_RUNTIME_${HOOK_RUNTIME}=1
  )
  target_link_libraries(
    syrnike_${HOOK_RUNTIME} PRIVATE ${CMAKE_JS_LIB} syrnike_hooks_core
  )
  if(MSVC)
    target_link_libraries(syrnike_${HOOK_RUNTIME} PRIVATE delayimp)
    target_link_options(syrnike_${HOOK_RUNTIME} PRIVATE /DELAYLOAD:node.exe)
  endif()
endforeach()

enable_testing()

add_executable(syrnike-native-hooks-runtime-lifecycle-tests
  tests/hooks_runtime_lifecycle_test.cpp
)
syrnike_native_target(syrnike-native-hooks-runtime-lifecycle-tests)
target_link_libraries(
  syrnike-native-hooks-runtime-lifecycle-tests PRIVATE syrnike_hooks_core
)
add_test(
  NAME syrnike-native-hooks-runtime-lifecycle-tests
  COMMAND syrnike-native-hooks-runtime-lifecycle-tests
)

add_executable(syrnike-native-cleanup-supervisor-tests
  tests/cleanup_supervisor_test.cpp
  src/common/cleanup_supervisor.cpp
)
syrnike_native_target(syrnike-native-cleanup-supervisor-tests)
add_test(
  NAME syrnike-native-cleanup-supervisor-tests
  COMMAND syrnike-native-cleanup-supervisor-tests
)
