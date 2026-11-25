# Build hook of src/inst (T11): embeds the instrument catalogue of native/contract/engine-api.json
# (`instruments.list`, built from app/js/engine/instruments.js by native/contract/tools/build-engine-api.mjs) as the
# raw string literal ${RIG_GEN_DIR}/inst_catalogue.inc, which src/inst/instrument_service.cpp includes: `get
# instruments` answers exactly that list. Re-runs cmake when engine-api.json changes; rewrites the .inc only when its
# content changes (file(CONFIGURE)).
set(_rig_api_json ${RIG_REPO_ROOT}/native/contract/engine-api.json)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_rig_api_json})
# CORE3 review O3: an empty catalogue is not a usable build. findCatalogue() then finds no instrument, so every
# `set slots.<i>.params.*` is stored and never reaches the instrument (fixture auto-filter-cutoff renders the cutoff
# moves as no-ops; with RIG_BUILD_TESTS=OFF, as build-core.sh builds the Apple core, no test would say so). It was a
# warning, and a `git archive native/core` export (no native/contract next to it) built such a core silently: that
# is the "auto-filter-cutoff depends on binary layout" of the CORE3 builder report. Now configure stops.
if(EXISTS ${_rig_api_json})
  file(READ ${_rig_api_json} _rig_api)
  string(JSON _rig_cat ERROR_VARIABLE _rig_cat_err GET "${_rig_api}" instruments list)
  if(_rig_cat_err)
    message(FATAL_ERROR "inst/catalogue.cmake: engine-api.json has no instruments.list (${_rig_cat_err})")
  endif()
else()
  message(FATAL_ERROR "inst/catalogue.cmake: ${_rig_api_json} not found (native/core needs native/contract next to "
                      "it: the instrument catalogue routes every instrument param)")
endif()
file(CONFIGURE OUTPUT ${RIG_GEN_DIR}/inst_catalogue.inc CONTENT "R\"rigcat(@_rig_cat@)rigcat\"\n" @ONLY)
