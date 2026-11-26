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
# -ffp-contract=off here too: pffft/dr_mp3 feed parity paths, and clang on arm64 contracts a*b+c into FMA by default
# (SETUP_REVIEW A9)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(rig_third_party PRIVATE -w -ffp-contract=off)
else()
  target_compile_options(rig_third_party PRIVATE -w)
endif()
if(UNIX)
  target_link_libraries(rig_third_party PUBLIC m)
endif()

# ---- module lists ------------------------------------------------------------------------------------------------
# Adding a module = adding files (BUILD_PLAN "Rules"): every src/**/*.cpp is compiled into rig_core, every
# src/**/*_register.cpp is a self-registration point (api/registry.h), every src/**/*.cmake is a build hook (below),
# every tests/**/*.cpp is a test source, every
# TEST_SUITE("x") becomes ctest `unit.x` (suite "realtime" -> `rt.realtime`), every tests/golden_ids/<name>.ids becomes
# ctest `golden.<name>`. No task edits this file to add a module.
include(RigModules)
set(RIG_GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
set(RIG_SOURCE_EXCLUDE "" CACHE STRING
    "regex of src/ paths left out of rig_core (orchestrator: isolate a task's unfinished files; empty in CI)")
file(GLOB_RECURSE RIG_CORE_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
list(FILTER RIG_CORE_SOURCES EXCLUDE REGEX "/third_party/")  # vendored code: added by its module's .cmake hook
if(RIG_SOURCE_EXCLUDE)
  list(FILTER RIG_CORE_SOURCES EXCLUDE REGEX "${RIG_SOURCE_EXCLUDE}")
endif()
list(SORT RIG_CORE_SOURCES)
rig_module_list(${CMAKE_CURRENT_SOURCE_DIR}/src "" ${RIG_GEN_DIR}/rig_modules.inc)

# ---- the core ----------------------------------------------------------------------------------------------------
add_library(rig_core STATIC ${RIG_CORE_SOURCES})
target_include_directories(rig_core PUBLIC include PRIVATE src ${RIG_GEN_DIR})
target_include_directories(rig_core PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>)
target_compile_definitions(rig_core PRIVATE RIG_GIT_DESCRIBE="${RIG_GIT_DESCRIBE}")
target_link_libraries(rig_core PUBLIC rig_third_party)
find_package(Threads REQUIRED)
target_link_libraries(rig_core PUBLIC Threads::Threads)
rig_target_defaults(rig_core)
set_target_properties(rig_core PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
# Per-module build hooks: every src/**/*.cmake is included here, after rig_core exists, so a module can add include
# directories (e.g. -isystem for vendored headers), definitions or vendored sources without editing this file.
# Hooks touch only rig_core settings for their own files (target_sources, set_source_files_properties,
# target_include_directories(rig_core SYSTEM PRIVATE ...)).
file(GLOB_RECURSE RIG_MODULE_HOOKS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cmake)
list(SORT RIG_MODULE_HOOKS)
foreach(hook ${RIG_MODULE_HOOKS})
  include(${hook})
endforeach()

if(RIG_BUILD_TESTS)
  enable_testing()
  find_program(NODE_EXECUTABLE node)

  file(GLOB_RECURSE RIG_FIXTURE_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tools/common/*.cpp)
  add_library(rig_fixture STATIC ${RIG_FIXTURE_SOURCES})
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

  file(GLOB_RECURSE RIG_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp)
  list(SORT RIG_TEST_SOURCES)
  rig_module_list(${CMAKE_CURRENT_SOURCE_DIR}/tests "tests_" ${RIG_GEN_DIR}/rig_test_modules.inc)
  add_executable(rig_tests ${RIG_TEST_SOURCES})
  target_include_directories(rig_tests PRIVATE third_party/doctest tools/common tests ${RIG_GEN_DIR})
  target_compile_definitions(rig_tests PRIVATE
    RIG_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}" RIG_REPO_DIR="${RIG_REPO_ROOT}")
  target_link_libraries(rig_tests PRIVATE rig_fixture)
  rig_test_defaults(rig_tests)

  rig_test_suites("${RIG_TEST_SOURCES}" _suites)
  foreach(suite ${_suites})
    if(suite STREQUAL "realtime")
      add_test(NAME rt.realtime COMMAND rig_tests -ts=realtime)
      # Lane F1 (CORE1 open 3): xrun and render-time bounds; alone under `ctest -j`, not next to the heavy suites
      set_tests_properties(rt.realtime PROPERTIES LABELS rt RUN_SERIAL TRUE)
    else()
      add_test(NAME unit.${suite} COMMAND rig_tests -ts=${suite})
      set_tests_properties(unit.${suite} PROPERTIES LABELS unit)
      if(suite STREQUAL "core3" OR suite MATCHES "^runtime")
        # CORE3 / Lane F1: tick-gap bounds on the realtime control loop (core3, runtime_preload), `active` counts
        # (runtime); not next to the CPU benchmark suites. CI runs ctest serially anyway: there the tests' own
        # idle-relative bounds carry the load (test_core3.cpp, test_runtime_preload.cpp gapBound)
        set_tests_properties(unit.${suite} PROPERTIES RUN_SERIAL TRUE)
      endif()
    endif()
  endforeach()
  if(NODE_EXECUTABLE)
    add_test(NAME unit.params-drift
             COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen-params.mjs --check)
    set_tests_properties(unit.params-drift PROPERTIES LABELS unit)
    # golden fixtures expected to pass: one ctest per tests/golden_ids/<name>.ids (one id per line, # comments)
    file(GLOB RIG_GOLDEN_LISTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/golden_ids/*.ids)
    list(SORT RIG_GOLDEN_LISTS)
    foreach(list_file ${RIG_GOLDEN_LISTS})
      get_filename_component(_name ${list_file} NAME_WE)
      file(STRINGS ${list_file} _ids REGEX "^[a-z0-9][a-z0-9.-]*$")
      if(NOT _ids)
        continue()
      endif()
      string(REPLACE ";" "," _ids "${_ids}")
      add_test(NAME golden.${_name}
               COMMAND ${CMAKE_COMMAND} -DRENDER=$<TARGET_FILE:rig_render> -DREPO=${RIG_REPO_ROOT}
                       -DNODE=${NODE_EXECUTABLE} -DOUT=${CMAKE_BINARY_DIR}/golden-out/${_name} -DIDS=${_ids}
                       -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/run_golden.cmake)
      set_tests_properties(golden.${_name} PROPERTIES LABELS golden SKIP_REGULAR_EXPRESSION "GOLDEN-MISSING")
    endforeach()
  endif()
endif()
