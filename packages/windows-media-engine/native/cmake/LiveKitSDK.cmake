include_guard(GLOBAL)

set(WINDOWS_MEDIA_LIVEKIT_VERSION "1.10.0-syrnike.6")
set(WINDOWS_MEDIA_LIVEKIT_UPSTREAM_COMMIT
  "336d14e17d9432acce89e4c0d57078bbfbb23026"
)
set(WINDOWS_MEDIA_LIVEKIT_FORK_COMMIT
  "a5d707889d1e940c8685600f217ee911e66fd22f"
)
set(WINDOWS_MEDIA_LIVEKIT_FORK_RELEASE "v1.10.0-syrnike.6")
set(WINDOWS_MEDIA_LIVEKIT_WINDOWS_X64_SHA256
  "37f50cb0b795c33f33b85cbf48d566053e07651c44346fdd3cc0c2a59955f927"
)
set(WINDOWS_MEDIA_LIVEKIT_SDK_ROOT "" CACHE PATH
  "Optional explicit LiveKit SDK root for isolated Media Lab validation"
)

function(windows_media_setup_livekit_sdk)
  if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "Native v2 Media Lab currently requires Windows x64")
  endif()

  if(WINDOWS_MEDIA_LIVEKIT_SDK_ROOT)
    set(_local_config
      "${WINDOWS_MEDIA_LIVEKIT_SDK_ROOT}/lib/cmake/LiveKit/LiveKitConfig.cmake"
    )
    if(NOT EXISTS "${_local_config}")
      message(FATAL_ERROR
        "Explicit LiveKit SDK root has no lib/cmake/LiveKit/LiveKitConfig.cmake: ${WINDOWS_MEDIA_LIVEKIT_SDK_ROOT}"
      )
    endif()
    set(LiveKit_DIR
      "${WINDOWS_MEDIA_LIVEKIT_SDK_ROOT}/lib/cmake/LiveKit" PARENT_SCOPE
    )
    return()
  endif()

  set(_archive_name
    "livekit-sdk-windows-x64-${WINDOWS_MEDIA_LIVEKIT_VERSION}.zip"
  )
  set(_archive_path
    "${CMAKE_BINARY_DIR}/_downloads/syrnike-${_archive_name}"
  )
  set(_sdk_parent "${CMAKE_BINARY_DIR}/_deps/syrnike-livekit-sdk")
  set(_sdk_root "${_sdk_parent}/livekit-sdk-windows-x64-${WINDOWS_MEDIA_LIVEKIT_VERSION}")
  set(_url
    "https://github.com/syrnike13/client-sdk-cpp/releases/download/${WINDOWS_MEDIA_LIVEKIT_FORK_RELEASE}/${_archive_name}"
  )

  if(NOT EXISTS "${_sdk_root}/lib/cmake/LiveKit/LiveKitConfig.cmake")
    file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/_downloads" "${_sdk_parent}")
    file(DOWNLOAD "${_url}" "${_archive_path}"
      EXPECTED_HASH "SHA256=${WINDOWS_MEDIA_LIVEKIT_WINDOWS_X64_SHA256}"
      TLS_VERIFY ON
      SHOW_PROGRESS
      STATUS _download_status
    )
    list(GET _download_status 0 _download_code)
    list(GET _download_status 1 _download_message)
    if(NOT _download_code EQUAL 0)
      message(FATAL_ERROR "LiveKit SDK download failed: ${_download_message}")
    endif()
    file(REMOVE_RECURSE "${_sdk_root}")
    file(ARCHIVE_EXTRACT INPUT "${_archive_path}" DESTINATION "${_sdk_parent}")
  endif()

  if(NOT EXISTS "${_sdk_root}/lib/cmake/LiveKit/LiveKitConfig.cmake")
    message(FATAL_ERROR "LiveKit SDK archive has an unexpected layout: ${_sdk_root}")
  endif()

  set(LiveKit_DIR "${_sdk_root}/lib/cmake/LiveKit" PARENT_SCOPE)
  set(WINDOWS_MEDIA_LIVEKIT_SDK_ROOT "${_sdk_root}" PARENT_SCOPE)
endfunction()

function(windows_media_copy_livekit_runtime target_name)
  if(NOT WIN32)
    return()
  endif()
  get_filename_component(_cmake_parent "${LiveKit_DIR}" DIRECTORY)
  get_filename_component(_lib_dir "${_cmake_parent}" DIRECTORY)
  get_filename_component(_sdk_root "${_lib_dir}" DIRECTORY)
  foreach(_runtime_dll IN ITEMS livekit.dll livekit_ffi.dll)
    if(NOT EXISTS "${_sdk_root}/bin/${_runtime_dll}")
      message(FATAL_ERROR "Pinned LiveKit runtime is missing ${_runtime_dll}")
    endif()
    add_custom_command(TARGET ${target_name} POST_BUILD
      COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "${_sdk_root}/bin/${_runtime_dll}"
        "$<TARGET_FILE_DIR:${target_name}>"
      VERBATIM
    )
  endforeach()
endfunction()
