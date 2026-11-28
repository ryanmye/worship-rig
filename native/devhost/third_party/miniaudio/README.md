# miniaudio (vendored for the Linux/Mac dev host only)

| field | value |
|---|---|
| upstream | https://github.com/mackron/miniaudio |
| files | `miniaudio.h`, `LICENSE` (fetched from `raw.githubusercontent.com/mackron/miniaudio/0.11.22/…` on 2026-11-19) |
| version | tag **0.11.22** (2025-02-24) |
| sha256 `miniaudio.h` | `9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410` |
| sha256 `LICENSE` | `457f1b500e0adf6bc059edddfa78a2f62012e7c3bb43476c20e0bd23b25ba0eb` |
| licence | public domain (Unlicense) or MIT-0, at the user's choice (ARCHITECTURE §6: permissive, fine under D38) |
| modifications | none |

Used only by `native/devhost` (`src/miniaudio_impl.c`, compiled with `-w`). Never linked into the Apple app (which
drives AUHAL/RemoteIO directly, ARCHITECTURE §5) nor into `rig_core`. Decoding, resource management, the engine and
node-graph layers are compiled out (`MA_NO_DECODING`, `MA_NO_ENCODING`, `MA_NO_GENERATION`, `MA_NO_RESOURCE_MANAGER`,
`MA_NO_NODE_GRAPH`, `MA_NO_ENGINE`): the dev host only uses the low-level device API.
