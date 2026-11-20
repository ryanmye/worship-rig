# Build hook of src/num (T01), included by native/core/CMakeLists.txt after rig_core exists (RigModules scheme).
# The vendored LLVM libc headers (src/num/llvm_libc, Apache-2.0 WITH LLVM-exception) are a SYSTEM include of the one
# TU that uses them, so our -Werror set does not apply to them. Everything else in src/num and src/time is plain
# globbed C++ that needs only rig_target_defaults (-ffp-contract=off is required: js_pow.cpp, js_tanh.cpp and
# time/param.cpp are written for unfused IEEE arithmetic).
set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/js_math_llvm.cpp PROPERTIES
  COMPILE_OPTIONS "-isystem;${CMAKE_CURRENT_LIST_DIR}/llvm_libc")
