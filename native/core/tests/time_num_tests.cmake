# T01 unit tests (suites `num` and `time`): a self-contained doctest binary over rig_time_num only, so it builds while
# the rest of the core is in flux. Include after src/num/num.cmake:
#     include(tests/time_num_tests.cmake)
# Registers ctest `unit.num` and `unit.time` (label unit). Data: tools/golden/vectors/data/*.txt.
set(_rig_t01_core "${CMAKE_CURRENT_LIST_DIR}/..")
get_filename_component(_rig_t01_repo "${_rig_t01_core}/../.." ABSOLUTE)
add_executable(rig_t01_tests
  ${_rig_t01_core}/tests/test_main.cpp
  ${_rig_t01_core}/tests/num_math_test.cpp
  ${_rig_t01_core}/tests/num_prng_test.cpp
  ${_rig_t01_core}/tests/time_param_test.cpp
  ${_rig_t01_core}/tests/time_automation_test.cpp)
target_include_directories(rig_t01_tests PRIVATE ${_rig_t01_core}/third_party/doctest ${_rig_t01_core}/tests)
target_compile_definitions(rig_t01_tests PRIVATE
  RIG_SOURCE_DIR="${_rig_t01_core}" RIG_REPO_DIR="${_rig_t01_repo}")
target_link_libraries(rig_t01_tests PRIVATE rig_time_num)
if(COMMAND rig_test_defaults)
  rig_test_defaults(rig_t01_tests)
endif()
foreach(suite num time)
  add_test(NAME unit.${suite} COMMAND rig_t01_tests -ts=${suite})
  set_tests_properties(unit.${suite} PROPERTIES LABELS unit)
endforeach()
unset(_rig_t01_core)
unset(_rig_t01_repo)
