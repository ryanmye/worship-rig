# Build hook of src/inst (T11): embeds the instrument catalogue of native/contract/engine-api.json
# (`instruments.list`, built from app/js/engine/instruments.js by native/contract/tools/build-engine-api.mjs) as the
# raw string literal ${RIG_GEN_DIR}/inst_catalogue.inc, which src/inst/instrument_service.cpp includes: `get
# instruments` answers exactly that list. Re-runs cmake when engine-api.json changes; rewrites the .inc only when its
# content changes (file(CONFIGURE)).
set(_rig_api_json ${RIG_REPO_ROOT}/native/contract/engine-api.json)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_rig_api_json})
if(EXISTS ${_rig_api_json})
  file(READ ${_rig_api_json} _rig_api)
  string(JSON _rig_cat ERROR_VARIABLE _rig_cat_err GET "${_rig_api}" instruments list)
  if(_rig_cat_err)
    message(WARNING "inst/catalogue.cmake: engine-api.json has no instruments.list (${_rig_cat_err})")
    set(_rig_cat "[]")
  endif()
else()
  message(WARNING "inst/catalogue.cmake: ${_rig_api_json} not found; `get instruments` answers []")
  set(_rig_cat "[]")
endif()
file(CONFIGURE OUTPUT ${RIG_GEN_DIR}/inst_catalogue.inc CONTENT "R\"rigcat(@_rig_cat@)rigcat\"\n" @ONLY)
