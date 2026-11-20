#!/usr/bin/env node
// Records the bridge log that native-recorder.test.mjs replays: runs rig-devhost (null audio backend), drives
// BridgeEngine + NativeRecorder over the WebSocket transport through rec-scenario.mjs, and writes
//   data/rec-session.jsonl         every message both ways (rig-devhost --log), paths normalised
//   data/rec-session.expect.json   what the facade showed live (the replay must show the same)
//   node test/unit/engine-bridge/record-devhost-log.mjs [--bin native/core/build-t09/rig-devhost]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { websocketTransport } from '../../../app/js/engine-bridge/ws-transport.js';
import { runRecScenario } from './rec-scenario.mjs';
import { startDevhost } from './devhost-proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-devhost-rec-'));
const log = path.join(work, 'log.jsonl');
const host = await startDevhost({ bin: opt('--bin'), extra: ['--log', log, '--recordings', work, '--seed', '5'] });
const engine = new BridgeEngine({ transport: websocketTransport({ url: host.wsUrl }), app: 'rec-log-recorder' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = await runRecScenario(engine, { wait });
engine._dispose();
await wait(200);
await host.stop();
const wavs = fs.readdirSync(work).filter((f) => f.endsWith('.wav'));
out.wavFiles = wavs.length;
// normalise the machine-specific folder so the fixture says nothing about this box
const norm = (s) => s.split(work).join('/recordings');
const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(norm);
const dataDir = path.join(here, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'rec-session.jsonl'), `${lines.join('\n')}\n`);
fs.writeFileSync(path.join(dataDir, 'rec-session.expect.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ messages: lines.length, wavs: wavs.length, ...out }, null, 2));
