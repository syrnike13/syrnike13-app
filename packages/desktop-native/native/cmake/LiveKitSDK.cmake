function(livekit_sdk_setup)
  set(options)
  set(oneValueArgs SOURCE_DIR VERSION REVISION RUST_REVISION)
  cmake_parse_arguments(LIVEKIT_SDK "${options}" "${oneValueArgs}" "" ${ARGN})

  if(NOT LIVEKIT_SDK_SOURCE_DIR)
    message(FATAL_ERROR "Set LIVEKIT_SDK_SOURCE_DIR to the vendored LiveKit C++ source tree")
  endif()
  if(NOT EXISTS "${LIVEKIT_SDK_SOURCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "Vendored LiveKit source is missing: ${LIVEKIT_SDK_SOURCE_DIR}")
  endif()
  if(NOT EXISTS "${LIVEKIT_SDK_SOURCE_DIR}/client-sdk-rust/livekit-ffi/Cargo.toml")
    message(FATAL_ERROR "Vendored LiveKit Rust FFI source is incomplete")
  endif()
  if(NOT EXISTS "${LIVEKIT_SDK_SOURCE_DIR}/client-sdk-rust/livekit-protocol/protocol/protobufs/livekit_room.proto")
    message(FATAL_ERROR "Vendored livekit-protocol source is incomplete")
  endif()
  if(NOT EXISTS "${LIVEKIT_SDK_SOURCE_DIR}/client-sdk-rust/yuv-sys/libyuv/CMakeLists.txt")
    message(FATAL_ERROR "Vendored libyuv source is incomplete")
  endif()
  if(MSVC AND MSVC_VERSION LESS 1944)
    message(FATAL_ERROR
      "Vendored LiveKit WebRTC requires MSVC 19.44 / toolset 14.44 or newer; "
      "install MSVC toolset 14.44 or newer before building the Windows native runtime"
    )
  endif()

  string(REGEX REPLACE "^v" "" LIVEKIT_VERSION_NUMBER "${LIVEKIT_SDK_VERSION}")
  set(LIVEKIT_VERSION "${LIVEKIT_VERSION_NUMBER}" CACHE STRING "Vendored LiveKit version" FORCE)
  set(LIVEKIT_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LIVEKIT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  add_subdirectory("${LIVEKIT_SDK_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/_deps/livekit-client-build")

  if(NOT TARGET livekit)
    message(FATAL_ERROR "Vendored LiveKit source did not define the livekit target")
  endif()
  if(NOT TARGET LiveKit::livekit)
    add_library(LiveKit::livekit ALIAS livekit)
  endif()
  # LiveKit is an independently maintained vendored dependency. Treat its
  # public headers like the former imported SDK so Syrnike's /W4 /WX policy
  # applies to our code without turning upstream DLL-interface diagnostics
  # into consumer build failures.
  get_target_property(_livekit_public_includes livekit INTERFACE_INCLUDE_DIRECTORIES)
  if(_livekit_public_includes)
    set_property(TARGET livekit APPEND PROPERTY
      INTERFACE_SYSTEM_INCLUDE_DIRECTORIES "${_livekit_public_includes}"
    )
  endif()

  set(LIVEKIT_RUNTIME_DIRECTORY "$<TARGET_FILE_DIR:livekit>" PARENT_SCOPE)
  set(LIVEKIT_FFI_RUNTIME_FILE
    "$<IF:$<CONFIG:Debug>,${LIVEKIT_RUST_TARGET_DIR}/debug/livekit_ffi.dll,${LIVEKIT_RUST_TARGET_DIR}/release/livekit_ffi.dll>"
    PARENT_SCOPE
  )
endfunction()
