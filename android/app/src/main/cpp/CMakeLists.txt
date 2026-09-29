cmake_minimum_required(VERSION 3.22)
project(pythona_engine C)

if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    message(FATAL_ERROR "PythonA 0.3.0 embeds CPython only for arm64-v8a")
endif()
if(NOT DEFINED PYTHONA_PYTHON_PREFIX)
    message(FATAL_ERROR "Set PYTHONA_PYTHON_PREFIX to the official CPython 3.14.7 Android prefix")
endif()

set(PYTHON_INCLUDE "${PYTHONA_PYTHON_PREFIX}/include/python3.14")
set(PYTHON_LIBRARY "${PYTHONA_PYTHON_PREFIX}/lib/libpython3.14.so")
if(NOT EXISTS "${PYTHON_INCLUDE}/Python.h" OR NOT EXISTS "${PYTHON_LIBRARY}")
    message(FATAL_ERROR "PYTHONA_PYTHON_PREFIX is not a CPython 3.14 Android prefix")
endif()

add_library(python314 SHARED IMPORTED)
set_target_properties(python314 PROPERTIES IMPORTED_LOCATION "${PYTHON_LIBRARY}")

add_library(pythona_engine SHARED pythona_engine.c)
target_include_directories(pythona_engine PRIVATE "${PYTHON_INCLUDE}")
target_compile_features(pythona_engine PRIVATE c_std_11)
target_compile_options(pythona_engine PRIVATE
    -Wall
    -Wextra
    -Werror=implicit-function-declaration
    -fvisibility=hidden
    -D__BIONIC_NO_PAGE_SIZE_MACRO
)
target_link_options(pythona_engine PRIVATE
    -Wl,--build-id=sha1
    -Wl,--no-undefined
    -Wl,--no-rosegment
    -Wl,-z,max-page-size=16384
)

find_library(log-lib log)
find_library(android-lib android)
target_link_libraries(pythona_engine PRIVATE python314 ${log-lib} ${android-lib} dl m)
