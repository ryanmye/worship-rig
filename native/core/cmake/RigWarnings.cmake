# Warning and numerics flags for first-party targets. Third-party code is built with -w (see third_party target).
function(rig_target_defaults tgt)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${tgt} PRIVATE
      -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Werror
      -ffp-contract=off -fno-finite-math-only -fno-math-errno)
  elseif(MSVC)
    target_compile_options(${tgt} PRIVATE /W4 /WX /fp:precise)
  endif()
endfunction()
