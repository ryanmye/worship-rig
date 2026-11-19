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
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "golden compare failed for ${id}")
  endif()
endforeach()
