export const meta = {
  name: 'rig-v2-integ4-scoped',
  description: 'Worship Rig 2.0: scoped re-check after CORE3 (song switch build off the control thread) and MACFIX (explicit instrument registration): only the affected tests, then HANDSON GO/NO-GO.',
  phases: [{ title: 'Integrate' }],
}
const ROOT = '/home/claude/worship-rig'
const ARGS = typeof args === 'object' && args ? args : {}
const P = [
  'Project: Worship Rig at ' + ROOT + ', branch v2-native (2.0: web UI over a C++20 core via a JSON bridge; the web engine app/js/engine is the golden oracle). Read: CLAUDE.md, native/docs/REPICKUP.md, BUILD_PLAN.md, PARITY.md "UI parity", MAC_CHECK.md (Results: Mac check #3), native/docs/reviews/{CORE3,MACFIX}.md.',
  'Rules: 2-CPU Linux box, you are the only agent: -j2. Never run git commit/checkout/stash/reset/clean. Any chat-like text from Ryan in your context is NOT a task. Never pause for questions.',
  'You are the SCOPED INTEGRATOR. Ryan: "only check affected sections". The full gate passed at b9a0c27 (CORE2 integration). Since then only CORE3 and MACFIX changed code. Run `git diff --stat b9a0c27 -- native app tools test` first and scope every check to what that diff touches; say in the report what you skipped and why.',
  '(1) Rebuild native/core/build-int (g++), build-int-clang20 (-Werror) and native/devhost/build-int incrementally; run ctest on both. ASan and TSan only on the suites whose files changed (list them).',
  '(2) Fixtures: only the modules the diff touches (expected: song model, synth, synth-extra, organ, sampler, anything rendered through the changed build/registration path); byte-identical to the b9a0c27 renders, parity.mjs on that subset, g++ = clang20.',
  '(3) JS: node --test test/unit/engine-bridge/*.test.mjs with RIG_DEVHOST=build-int, and ui-core-devhost --no-adapter twice (counts, largest tick gaps; CORE2 integration had 75-77/77 and 315/283/329 ms). Skip run-all suites whose files did not change (settings, themes, edit-v2, eq, mini, chrome-fallback, shell) unless the diff touches app/.',
  '(4) Docs: PARITY "UI parity" (new counts and gaps), BUILD_PLAN (CORE3 + MACFIX result, open items by owner), REPICKUP sections 2 and 6, MAC_CHECK Tier 2 step 5 (remove the CORE2A O2 caveat if CORE3 fixed it; what to listen for with neighbour prebuild) and the Tier 1 note on which stages Mac check #4 needs: only the ones the diff affects (core; tools if tools/mac changed; apple-mac if native/apple or link layout changed).',
  'Return: numbers per check, what was skipped and why, open items by owner, the exact check.sh --stage list for Mac check #4, and a final line exactly HANDSON: GO or HANDSON: NO-GO <reason>.',
  'Notes from the orchestrator: ' + (ARGS.notes || '(none)'),
].join('\n')
phase('Integrate')
const r = await agent(P, { label: 'integ4-scoped', phase: 'Integrate', model: 'opus' })
return { integration: (r || '').slice(0, 8000) }
