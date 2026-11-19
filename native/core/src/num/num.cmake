# T01 time & numerics (src/time, src/num): one static library that rig_core links.
#
# Use from native/core/CMakeLists.txt, right after `add_library(rig_core ...)`:
#     include(src/num/num.cmake)
# and drop `src/time/param.cpp` from rig_core's source list (it is compiled here now).
# Also usable stand-alone (tests/time_num_tests.cmake), which is how T01 builds and tests it.
set(_rig_tn_dir "${CMAKE_CURRENT_LIST_DIR}/..")
add_library(rig_time_num STATIC
  ${_rig_tn_dir}/time/param.cpp
  ${_rig_tn_dir}/num/js_math_llvm.cpp
  ${_rig_tn_dir}/num/js_pow.cpp
  ${_rig_tn_dir}/num/js_tanh.cpp
  ${_rig_tn_dir}/num/js_number.cpp
  ${_rig_tn_dir}/num/fdlibm.cpp)
target_include_directories(rig_time_num PUBLIC ${_rig_tn_dir})
target_compile_features(rig_time_num PUBLIC cxx_std_20)
set_target_properties(rig_time_num PROPERTIES POSITION_INDEPENDENT_CODE ON)
# The vendored LLVM libc headers (Apache-2.0 WITH LLVM-exception, src/num/llvm_libc) are a SYSTEM include of the one
# TU that uses them, so our -Werror set does not apply to them.
set_source_files_properties(${_rig_tn_dir}/num/js_math_llvm.cpp PROPERTIES
  COMPILE_OPTIONS "-isystem;${_rig_tn_dir}/num/llvm_libc")
if(COMMAND rig_target_defaults)
  rig_target_defaults(rig_time_num)  # -Werror, -ffp-contract=off (required: js_pow/js_tanh/param are FMA-exact)
else()
  target_compile_options(rig_time_num PRIVATE -ffp-contract=off -fno-math-errno)
endif()
if(TARGET rig_core)
  target_link_libraries(rig_core PUBLIC rig_time_num)
endif()
unset(_rig_tn_dir)
