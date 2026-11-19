cmake_minimum_required(VERSION 3.20)
project(rig_core VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(RIG_BUILD_TESTS "Build unit tests and tools" ON)
set(RIG_SANITIZE "" CACHE STRING "address;undefined | thread (semicolon separated)")

list(APPEND CMAKE_MODULE_PATH ${CMAKE_CURRENT_SOURCE_DIR}/cmake)
include(RigWarnings)

get_filename_component(RIG_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
find_package(Git QUIET)
set(RIG_GIT_DESCRIBE "nogit")
if(GIT_FOUND)
  execute_process(COMMAND ${GIT_EXECUTABLE} -C ${RIG_REPO_ROOT} rev-parse --short HEAD
                  OUTPUT_VARIABLE _sha OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  if(_sha)
    set(RIG_GIT_DESCRIBE "${_sha}")
  endif()
endif()

set(_san_flags "")
if(RIG_SANITIZE)
  string(REPLACE ";" "," _san "${RIG_SANITIZE}")
  set(_san_flags -fsanitize=${_san} -fno-omit-frame-pointer -fno-sanitize-recover=all)
  add_compile_options(${_san_flags})
  add_link_options(${_san_flags})
endif()

# ---- third party (vendored, see third_party/README.md): compiled without warnings -------------------------------
add_library(rig_third_party STATIC
  third_party/yyjson/yyjson.c
  third_party/pffft/src/pffft.c
  third_party/pffft/src/pffft_common.c
  third_party/impl/dr_libs_impl.c)
target_include_directories(rig_third_party PUBLIC
  third_party/yyjson third_party/dr_libs third_party/pffft/include/pffft)
target_include_directories(rig_third_party PRIVATE third_party/pffft/src)
target_compile_options(rig_third_party PRIVATE -w)
if(UNIX)
  target_link_libraries(rig_third_party PUBLIC m)
endif()

# ---- the core ----------------------------------------------------------------------------------------------------
add_library(rig_core STATIC
  src/api/rig_engine.cpp src/api/engine.cpp
  src/bridge/bridge.cpp
  src/graph/graph.cpp
  src/model/model.cpp src/model/patch.cpp
  src/params/params.cpp
  src/time/param.cpp
  src/dsp/biquad.cpp src/dsp/test_voice.cpp
  src/mix/slot_eq.cpp
  src/io/wav.cpp)
target_include_directories(rig_core PUBLIC include PRIVATE src)
target_include_directories(rig_core PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>)
target_compile_definitions(rig_core PRIVATE RIG_GIT_DESCRIBE="${RIG_GIT_DESCRIBE}")
target_link_libraries(rig_core PUBLIC rig_third_party)
find_package(Threads REQUIRED)
target_link_libraries(rig_core PUBLIC Threads::Threads)
rig_target_defaults(rig_core)
set_target_properties(rig_core PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)

if(RIG_BUILD_TESTS)
  enable_testing()
  find_program(NODE_EXECUTABLE node)

  add_library(rig_fixture STATIC tools/common/fixture_runner.cpp)
  target_link_libraries(rig_fixture PUBLIC rig_core)
  rig_target_defaults(rig_fixture)

  add_executable(rig_render tools/rig_render/main.cpp)
  target_link_libraries(rig_render PRIVATE rig_fixture)
  rig_target_defaults(rig_render)
  # the name the architecture / build plan use
  add_executable(rig-golden tools/rig_render/main.cpp)
  target_link_libraries(rig-golden PRIVATE rig_fixture)
  rig_target_defaults(rig-golden)

  add_executable(rig_bench tools/rig_bench/main.cpp)
  target_link_libraries(rig_bench PRIVATE rig_core)
  rig_target_defaults(rig_bench)

  set(RIG_TEST_SOURCES
    tests/test_main.cpp tests/alloc_trap.cpp tests/test_queues.cpp tests/test_param.cpp tests/test_biquad.cpp
    tests/test_wav.cpp tests/test_params.cpp tests/test_bridge.cpp tests/test_offline.cpp tests/test_voice.cpp
    tests/test_realtime.cpp tests/test_third_party.cpp tests/test_golden.cpp)
  add_executable(rig_tests ${RIG_TEST_SOURCES})
  target_include_directories(rig_tests PRIVATE third_party/doctest tools/common)
  target_compile_definitions(rig_tests PRIVATE
    RIG_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}" RIG_REPO_DIR="${RIG_REPO_ROOT}")
  target_link_libraries(rig_tests PRIVATE rig_fixture)
  rig_test_defaults(rig_tests)

  foreach(suite queues param biquad wav params bridge offline voice thirdparty golden-analytic)
    add_test(NAME unit.${suite} COMMAND rig_tests -ts=${suite})
    set_tests_properties(unit.${suite} PROPERTIES LABELS unit)
  endforeach()
  add_test(NAME rt.realtime COMMAND rig_tests -ts=realtime)
  set_tests_properties(rt.realtime PROPERTIES LABELS rt)
  if(NODE_EXECUTABLE)
    add_test(NAME unit.params-drift
             COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen-params.mjs --check)
    set_tests_properties(unit.params-drift PROPERTIES LABELS unit)
    # fixtures the skeleton is expected to match (single-band slot EQ through the strip); grows with T02+
    set(RIG_GOLDEN_IDS
      "eq-lowshelf-a,eq-lowshelf-b,eq-lowshelf-c,eq-peak-a,eq-peak-b,eq-peak-c,eq-highshelf-a,eq-highshelf-b,eq-highshelf-c"
      "eq-notch-a,eq-notch-b,eq-notch-c,eq-lowcut-a,eq-lowcut-b,eq-lowcut-c,eq-highcut-a,eq-highcut-b,eq-highcut-c")
    string(REPLACE ";" "," RIG_GOLDEN_IDS "${RIG_GOLDEN_IDS}")
    add_test(NAME golden.eq
             COMMAND ${CMAKE_COMMAND} -DRENDER=$<TARGET_FILE:rig_render> -DREPO=${RIG_REPO_ROOT}
                     -DNODE=${NODE_EXECUTABLE} -DOUT=${CMAKE_BINARY_DIR}/golden-out -DIDS=${RIG_GOLDEN_IDS}
                     -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/run_golden.cmake)
    set_tests_properties(golden.eq PROPERTIES LABELS golden)
  endif()
endif()
