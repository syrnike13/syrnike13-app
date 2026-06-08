include(FetchContent)

function(livekit_sdk_setup)
  set(options)
  set(oneValueArgs VERSION SDK_DIR GITHUB_TOKEN)
  set(multiValueArgs)
  cmake_parse_arguments(LIVEKIT_SDK "${options}" "${oneValueArgs}" "${multiValueArgs}" ${ARGN})

  if(NOT LIVEKIT_SDK_VERSION)
    set(LIVEKIT_SDK_VERSION "latest")
  endif()
  if(NOT LIVEKIT_SDK_SDK_DIR)
    set(LIVEKIT_SDK_SDK_DIR "${CMAKE_BINARY_DIR}/_deps/livekit-sdk")
  endif()

  if(LIVEKIT_SDK_VERSION STREQUAL "latest")
    message(FATAL_ERROR "Use a pinned LIVEKIT_SDK_VERSION such as v1.0.0")
  endif()
  string(REGEX REPLACE "^v" "" LIVEKIT_SDK_VERSION_NUMBER "${LIVEKIT_SDK_VERSION}")
  set(release_url "https://github.com/livekit/client-sdk-cpp/releases/download/${LIVEKIT_SDK_VERSION}/livekit-sdk-windows-x64-${LIVEKIT_SDK_VERSION_NUMBER}.zip")
  set(extracted_dir "${LIVEKIT_SDK_SDK_DIR}/livekit-sdk-windows-x64-${LIVEKIT_SDK_VERSION_NUMBER}")

  file(MAKE_DIRECTORY "${LIVEKIT_SDK_SDK_DIR}")
  set(archive_path "${CMAKE_BINARY_DIR}/_deps/livekit-sdk-windows-x64.zip")

  if(NOT EXISTS "${extracted_dir}/lib/cmake/LiveKit/LiveKitConfig.cmake")
    message(STATUS "Downloading LiveKit C++ SDK from ${release_url}")
    file(DOWNLOAD
      "${release_url}"
      "${archive_path}"
      SHOW_PROGRESS
      STATUS download_status
    )
    list(GET download_status 0 status_code)
    list(GET download_status 1 status_message)
    if(NOT status_code EQUAL 0)
      message(FATAL_ERROR "Failed to download LiveKit C++ SDK: ${status_message}")
    endif()
    file(ARCHIVE_EXTRACT INPUT "${archive_path}" DESTINATION "${LIVEKIT_SDK_SDK_DIR}")
  endif()

  list(PREPEND CMAKE_PREFIX_PATH "${extracted_dir}")
  set(CMAKE_PREFIX_PATH "${CMAKE_PREFIX_PATH}" PARENT_SCOPE)
endfunction()
