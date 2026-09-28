// Public entry for the audio engine (SPEC §3).
export { AudioEngine, defaultPatch, normalizePatch, curveVelocity, DEFAULT_MANIFEST_URLS } from './audio.js';
export {
  buildIR, buildIRChannels, buildIRChannelsAsync, reverbBucket, IR_BUCKETS, irStats, measureCompMakeup,
  measureGlueRef, glueSettings, GLUE, BUTTER2_Q, BUTTER4_Q,
} from './fx.js';
export { followVoicing, staticVoicing } from './drone.js';
export { processSample, normalizeManifest, BufferCache, limitMonoLoss, USER_RELEASE_DEFAULT } from './sampler.js';
export { KEYS, keyName } from '../shared/music.js';
export { detectKeyFromName } from '../shared/keydetect.js';
export { chordName } from '../shared/chords.js';
