# rig-devhost: the native core + miniaudio + a WebSocket relay (native/devhost/README.md).
#   cmake -S native/devhost -B native/core/build-<task> -G Ninja && cmake --build native/core/build-<task> -j2
# The core is pulled in as a subdirectory (its own warnings, sanitizer and module rules apply unchanged).
cmake_minimum_required(VERSION 3.20)
project(rig_devhost LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(DEVHOST_CORE_TESTS "Also build and register the core's own tests (rig_tests, golden) in this tree" OFF)
set(RIG_BUILD_TESTS ${DEVHOST_CORE_TESTS} CACHE BOOL "core tests (set by DEVHOST_CORE_TESTS)" FORCE)
set(RIG_SANITIZE "" CACHE STRING "address;undefined | thread (semicolon separated)")
if(RIG_SANITIZE)  # the core applies these in its own directory scope only
  string(REPLACE ";" "," _san "${RIG_SANITIZE}")
  add_compile_options(-fsanitize=${_san} -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_link_options(-fsanitize=${_san})
endif()

get_filename_component(DEVHOST_REPO "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
enable_testing()
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../core ${CMAKE_BINARY_DIR}/core)

# ---- miniaudio (vendored, public domain / MIT-0; third_party/miniaudio/README.md): no warnings, C only ------------
add_library(devhost_miniaudio STATIC src/miniaudio_impl.c)
target_include_directories(devhost_miniaudio SYSTEM PUBLIC third_party/miniaudio)
target_include_directories(devhost_miniaudio PUBLIC src)
target_compile_options(devhost_miniaudio PRIVATE -w)
find_package(Threads REQUIRED)
target_link_libraries(devhost_miniaudio PUBLIC Threads::Threads ${CMAKE_DL_LIBS})
if(UNIX AND NOT APPLE)
  target_link_libraries(devhost_miniaudio PUBLIC m)
endif()
if(APPLE)
  target_link_libraries(devhost_miniaudio PUBLIC "-framework CoreFoundation" "-framework CoreAudio"
                                                 "-framework AudioToolbox")
endif()

# ---- first-party: warnings as the core (rig_target_defaults, -Werror) ----------------------------------------------
add_library(devhost_lib STATIC src/ws_codec.cpp src/http.cpp src/server.cpp src/audio_host.cpp src/devhost.cpp)
target_include_directories(devhost_lib PUBLIC src)
target_link_libraries(devhost_lib PUBLIC rig_core devhost_miniaudio)
target_compile_definitions(devhost_lib PUBLIC DEVHOST_REPO_DIR="${DEVHOST_REPO}")
rig_target_defaults(devhost_lib)

add_executable(rig-devhost src/main.cpp)
target_link_libraries(rig-devhost PRIVATE devhost_lib)
rig_target_defaults(rig-devhost)

# ---- tests (doctest; one ctest per TEST_SUITE, like the core: unit.devhost-*) -------------------------------------
file(GLOB DEVHOST_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp)
add_executable(devhost_tests ${DEVHOST_TEST_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/../core/tests/alloc_trap.cpp)
target_include_directories(devhost_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../core/third_party/doctest)
target_link_libraries(devhost_tests PRIVATE devhost_lib)
rig_test_defaults(devhost_tests)
foreach(suite devhost-ws devhost-http devhost-audio devhost-relay)
  add_test(NAME unit.${suite} COMMAND devhost_tests -ts=${suite})
  set_tests_properties(unit.${suite} PROPERTIES LABELS "unit;devhost" TIMEOUT 120)
endforeach()
