# CORE2A (asynchronous sample preload, PARITY "UI parity" row 1): skeptic review, 2026-11-22

Verdict: **VERIFIED_PLACEHOLDER**

Tree: `v2-native` working tree (CORE2A builder + CORE2B builder in the same tree, uncommitted) plus this review's
edits. Own build dirs (fresh, real directories, one at a time, `-j2` at most in total): `native/core/build-c2sk`
(g++ 13 Release), `build-c2sk-clang20` (clang++-20 Release, `-Werror`), `build-c2sk-asan` (g++ RelWithDebInfo,
`RIG_SANITIZE=address;undefined`), `build-c2sk-tsan` (g++ RelWithDebInfo, `RIG_SANITIZE=thread`),
`native/devhost/build-c2sk` (g++ Release). Playwright through the existing 1194 -> 1243 mapping (`scratchpad/uisk/pw`).

GATE_PLACEHOLDER
