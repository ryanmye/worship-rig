# T01 stand-alone build of src/time + src/num and their tests (suites `num`, `time`), independent of the rest of the
# core while it is in flux. NOT used by native/core/CMakeLists.txt, which globs the same sources into rig_core and
# the same tests into rig_tests. A wrapper project includes RigWarnings, then this file:
#     list(APPEND CMAKE_MODULE_PATH <core>/cmake) include(RigWarnings) enable_testing()
#     include(<core>/tests/time_num_tests.cmake)
set(_rig_t01_core "${CMAKE_CURRENT_LIST_DIR}/..")
get_filename_component(_rig_t01_repo "${_rig_t01_core}/../.." ABSOLUTE)
add_library(rig_time_num STATIC
  ${_rig_t01_core}/src/time/param.cpp
  ${_rig_t01_core}/src/num/js_math_llvm.cpp
  ${_rig_t01_core}/src/num/js_pow.cpp
  ${_rig_t01_core}/src/num/js_tanh.cpp
  ${_rig_t01_core}/src/num/js_number.cpp
  ${_rig_t01_core}/src/num/fdlibm.cpp)
target_include_directories(rig_time_num PUBLIC ${_rig_t01_core}/src)
set_source_files_properties(${_rig_t01_core}/src/num/js_math_llvm.cpp PROPERTIES
  COMPILE_OPTIONS "-isystem;${_rig_t01_core}/src/num/llvm_libc")
rig_target_defaults(rig_time_num)

add_executable(rig_t01_tests
  ${_rig_t01_core}/tests/test_main.cpp
  ${_rig_t01_core}/tests/alloc_trap.cpp
  ${_rig_t01_core}/tests/num_math_test.cpp
  ${_rig_t01_core}/tests/num_prng_test.cpp
  ${_rig_t01_core}/tests/time_param_test.cpp
  ${_rig_t01_core}/tests/time_automation_test.cpp)
target_include_directories(rig_t01_tests PRIVATE ${_rig_t01_core}/third_party/doctest ${_rig_t01_core}/tests)
target_compile_definitions(rig_t01_tests PRIVATE
  RIG_SOURCE_DIR="${_rig_t01_core}" RIG_REPO_DIR="${_rig_t01_repo}")
target_link_libraries(rig_t01_tests PRIVATE rig_time_num)
rig_test_defaults(rig_t01_tests)
foreach(suite num time)
  add_test(NAME t01.${suite} COMMAND rig_t01_tests -ts=${suite})
  set_tests_properties(t01.${suite} PROPERTIES LABELS unit)
endforeach()
unset(_rig_t01_core)
unset(_rig_t01_repo)
