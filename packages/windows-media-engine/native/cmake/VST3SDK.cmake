include_guard(GLOBAL)

# Steinberg VST 3 SDK 3.8.0 (MIT). Only the interfaces and the hosting helpers
# are used; the plugin side, VSTGUI and the base library are not needed.
set(WINDOWS_MEDIA_VST3_SDK_RELEASE "v3.8.0_build_66")
set(WINDOWS_MEDIA_VST3_PLUGINTERFACES_COMMIT "31d6eeba6daaa3e2a8bfbe3e7a90ca0b7fbfbc1c")
set(WINDOWS_MEDIA_VST3_PLUGINTERFACES_SHA256
  "7c9d19af0e81711edde34c3eb2e5e6d150ae1f449501bb5b352605b9590654d7"
)
set(WINDOWS_MEDIA_VST3_PUBLIC_SDK_COMMIT "a3911a4615dabbfdfd9d181ee26b05c70c289a95")
set(WINDOWS_MEDIA_VST3_PUBLIC_SDK_SHA256
  "4cc8a9a57a970172b1efbef62025ae4f0656e132eed994f0e15ed19dfd9b0bb3"
)

function(windows_media_fetch_vst3_part repository commit sha256 destination)
  if(EXISTS "${destination}/.complete")
    return()
  endif()
  set(_archive "${CMAKE_BINARY_DIR}/_downloads/${repository}-${commit}.tar.gz")
  file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/_downloads")
  file(DOWNLOAD
    "https://github.com/steinbergmedia/${repository}/archive/${commit}.tar.gz"
    "${_archive}"
    EXPECTED_HASH "SHA256=${sha256}"
    TLS_VERIFY ON
    STATUS _status
  )
  list(GET _status 0 _code)
  list(GET _status 1 _message)
  if(NOT _code EQUAL 0)
    message(FATAL_ERROR "VST 3 SDK download failed (${repository}): ${_message}")
  endif()
  set(_extract "${CMAKE_BINARY_DIR}/_deps/vst3-extract")
  file(REMOVE_RECURSE "${_extract}" "${destination}")
  file(ARCHIVE_EXTRACT INPUT "${_archive}" DESTINATION "${_extract}")
  get_filename_component(_parent "${destination}" DIRECTORY)
  file(MAKE_DIRECTORY "${_parent}")
  file(RENAME "${_extract}/${repository}-${commit}" "${destination}")
  file(REMOVE_RECURSE "${_extract}")
  file(WRITE "${destination}/.complete" "${commit}\n")
endfunction()

function(windows_media_setup_vst3_sdk)
  set(_root "${CMAKE_BINARY_DIR}/_deps/vst3sdk-${WINDOWS_MEDIA_VST3_SDK_RELEASE}")
  windows_media_fetch_vst3_part(vst3_pluginterfaces "${WINDOWS_MEDIA_VST3_PLUGINTERFACES_COMMIT}"
    "${WINDOWS_MEDIA_VST3_PLUGINTERFACES_SHA256}" "${_root}/pluginterfaces")
  windows_media_fetch_vst3_part(vst3_public_sdk "${WINDOWS_MEDIA_VST3_PUBLIC_SDK_COMMIT}"
    "${WINDOWS_MEDIA_VST3_PUBLIC_SDK_SHA256}" "${_root}/public.sdk")

  add_library(vst3_hosting STATIC
    "${_root}/pluginterfaces/base/coreiids.cpp"
    "${_root}/pluginterfaces/base/funknown.cpp"
    "${_root}/pluginterfaces/base/ustring.cpp"
    "${_root}/public.sdk/source/common/commoniids.cpp"
    "${_root}/public.sdk/source/common/commonstringconvert.cpp"
    "${_root}/public.sdk/source/common/threadchecker_win32.cpp"
    "${_root}/public.sdk/source/common/memorystream.cpp"
    "${_root}/public.sdk/source/vst/hosting/connectionproxy.cpp"
    "${_root}/public.sdk/source/vst/hosting/hostclasses.cpp"
    "${_root}/public.sdk/source/vst/hosting/module.cpp"
    "${_root}/public.sdk/source/vst/hosting/module_win32.cpp"
    "${_root}/public.sdk/source/vst/hosting/parameterchanges.cpp"
    "${_root}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp"
    "${_root}/public.sdk/source/vst/hosting/plugprovider.cpp"
    "${_root}/public.sdk/source/vst/hosting/processdata.cpp"
    "${_root}/public.sdk/source/vst/utility/stringconvert.cpp"
    "${_root}/public.sdk/source/vst/vstinitiids.cpp"
  )
  # The SDK hosting sources are C++17 (u8path), and build outside /WX.
  set_target_properties(vst3_hosting PROPERTIES CXX_STANDARD 17)
  target_include_directories(vst3_hosting SYSTEM PUBLIC "${_root}")
  target_compile_definitions(vst3_hosting PUBLIC RELEASE=1 _SILENCE_ALL_CXX17_DEPRECATION_WARNINGS
    _SILENCE_EXPERIMENTAL_FILESYSTEM_DEPRECATION_WARNING NOMINMAX WIN32_LEAN_AND_MEAN)
  if(MSVC)
    target_compile_options(vst3_hosting PRIVATE /W0 /EHsc /permissive- /utf-8)
  endif()
  target_link_libraries(vst3_hosting PUBLIC ole32 shell32)
endfunction()
