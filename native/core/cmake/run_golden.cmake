# ctest driver for a golden fixture: render with rig_render, then compare with tools/golden/compare.mjs.
#   cmake -DRENDER=<rig_render> -DREPO=<repo root> -DOUT=<dir> -DIDS=a,b -P run_golden.cmake
file(MAKE_DIRECTORY "${OUT}")
string(REPLACE "," ";" id_list "${IDS}")
foreach(id ${id_list})
  execute_process(COMMAND "${RENDER}" --manifest "${REPO}/native/golden/manifest.json" --out "${OUT}" --only "${id}"
                  RESULT_VARIABLE rc OUTPUT_VARIABLE o ERROR_VARIABLE o)
  message(STATUS "${o}")
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "rig_render failed for ${id}")
  endif()
  execute_process(COMMAND "${NODE}" "${REPO}/tools/golden/compare.mjs" "${id}" "${OUT}/${id}.wav"
                  RESULT_VARIABLE rc OUTPUT_VARIABLE o ERROR_VARIABLE o)
  message(STATUS "${o}")
  # compare.mjs exits 0 for a fixture whose golden WAV is absent (native/golden/out/ is git-ignored): report it so
  # ctest marks the test SKIPPED (SKIP_REGULAR_EXPRESSION in CMakeLists.txt) instead of a vacuous pass (WAVE0B V5)
  if(o MATCHES "[ \t]missing[\r\n]")
    message(STATUS "GOLDEN-MISSING ${id}: regenerate with `node tools/golden/render.mjs`")
  endif()
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "golden compare failed for ${id}")
  endif()
endforeach()
