# Build hook of the master chain (T03), included by native/core/CMakeLists.txt after rig_core exists.
# T02 owns mix/master_eq.cpp (the MasterEq of the frozen mix/master_eq.h). Until that file exists, T03's stand-in
# mix/master_chain_eq_fallback.cpp provides MasterEq; the glob is CONFIGURE_DEPENDS, so adding master_eq.cpp re-runs
# this hook and switches the stand-in off (no duplicate symbols, no edit needed).
if(NOT EXISTS ${CMAKE_CURRENT_LIST_DIR}/master_eq.cpp)
  set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/master_chain_eq_fallback.cpp PROPERTIES
    COMPILE_DEFINITIONS RIG_T03_MASTER_EQ_FALLBACK=1)
endif()
