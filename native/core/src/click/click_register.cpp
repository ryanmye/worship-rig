// rig_register_click_click: kind "click" (click/click.h, click_unit.cpp) and the "click" service
// (click/click_service.h). No set rows: the click is engine state, not PARAMS (contract 2.3 "Metronome").
#include "api/registry.h"
#include "click/click.h"
#include "click/click_service.h"

namespace {

rig::Service *makeService(rig::Model &m) {
  return new rig::ClickServiceImpl(m);
}

}  // namespace

void rig_register_click_click(rig::Registry &r) {
  r.addUnit(rig::kKindClick, &rig::makeClick);
  r.addService(rig::ClickService::kName, &makeService);
}
