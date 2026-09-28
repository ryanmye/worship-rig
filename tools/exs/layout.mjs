// EXS24 / Logic Sampler (.exs) binary layout, shared by the parser (parser.mjs) and the fixture writer (writer.mjs).
//
// PROVENANCE: there is no public spec. The starting table came from the open-source reverse-engineering projects
// (exs2sfz.py, ConvertWithMoss's EXS24 reader, exs24-parser). Fields marked VERIFIED were checked byte-for-byte
// against six real Apple files (tools/exs/fixtures/real/*.exs: Yamaha Grand Piano, Grand Piano, Steinway Grand
// Piano 2, Steinway Piano 2, Flea Market Wurli, Lullaby Vibes — all little-endian 'TBOS') and, for the consolidated
// CAF layout, against the audio in 'Steinway Piano_consolidated.caf'. The evidence for each is in
// docs/garageband-import.md ("Format notes") and test/unit/exs/real-files.test.mjs. Fields marked UNVERIFIED are
// read but never relied on. `--dump <file.exs> --hex` prints the raw bytes for further checking.
//
// A file is a flat sequence of chunks. Every chunk starts with an 84-byte header:
//   0  u32  signature  — chunk type in bits 24..27 ((sig >>> 24) & 0x0F); low bytes are usually 0x0101
//   4  u32  size       — bytes of chunk data AFTER the 84-byte header (chunk length = 84 + size)
//   8  u32  index      — ordinal of this chunk among its type (not relied upon; zones reference by position)
//  12  u32  flags
//  16  4B   magic      — 'TBOS' / 'JBOS' = little-endian file, 'SOBT' / 'SOBJ' = big-endian file
//  20  64B  name       — NUL-terminated (MacRoman/UTF-8; decoded as latin1 then cleaned)
// All multi-byte integers follow the file's endianness. Offsets below are from the START of the chunk (header incl.).

export const HEADER_SIZE = 84;
export const NAME_OFFSET = 20;
export const NAME_LEN = 64;
export const MAGIC_OFFSET = 16;

export const MAGIC_LE = ['TBOS', 'JBOS'];
export const MAGIC_BE = ['SOBT', 'SOBJ'];

// Instrument header chunk (type 0). VERIFIED on all six real files: the counts equal the chunks that follow.
export const HEADER = Object.freeze({
  ZONE_COUNT: 88, //   u32
  GROUP_COUNT: 92, //  u32
  SAMPLE_COUNT: 96, // u32
  PARAM_COUNT: 100, // u32
  MIN_LENGTH: 104,
});

export const CHUNK = Object.freeze({
  HEADER: 0x00, // instrument header
  ZONE: 0x01,
  GROUP: 0x02,
  SAMPLE: 0x03,
  PARAMS: 0x04, // instrument parameter block (ignored)
  UNKNOWN8: 0x08, // Keyboard Collection files have 16 of these (ignored)
  UNKNOWN10: 0x0a, // Keyboard Collection files, 1 per file (ignored)
  UNKNOWN11: 0x0b, // Grand Piano has one per sample, Steinway Piano 2 has one (ignored)
});
export const CHUNK_NAMES = { 0: 'header', 1: 'zone', 2: 'group', 3: 'sample', 4: 'params', 8: 'unknown8', 10: 'unknown10', 11: 'unknown11' };

// Zone chunk. Real files have 132 (Yamaha), 128 (Steinway Grand Piano 2) or 148 (Grand Piano, Steinway Piano 2,
// Keyboard Collection) data bytes; the parser needs >= 180 bytes in total and reads SEGMENT2_* only when present.
export const ZONE = Object.freeze({
  OPTIONS: 84, //   u8  bit0 one-shot, bit1 pitch OFF (i.e. no key-tracking), bit2 reverse,
  //                    bit3 velocity range ON (VERIFIED: 0x08 on Grand Piano / Wurli / Vibes zones, whose zone ranges
  //                    are authoritative; 0x00 on Yamaha / Steinway zones, whose velocity comes from the GROUP range),
  //                    bit6 output assigned.
  ROOT: 85, //      u8  root key, MIDI (VERIFIED: equals the NNN prefix of every Yamaha file name, e.g. 084_C5… → 84)
  FINE_TUNE: 86, // i8  cents
  PAN: 87, //       i8  -64..63 (or -100..100)
  VOLUME: 88, //    i8  dB
  VOL_SCALE: 89, // u8
  KEY_LOW: 90, //   u8  (VERIFIED)
  KEY_HIGH: 91, //  u8  (VERIFIED)
  VEL_LOW: 93, //   u8  (VERIFIED)
  VEL_HIGH: 94, //  u8  (VERIFIED)
  SAMPLE_START: 96, //  u32 frames into the sample FILE (VERIFIED; for a consolidated CAF, the zone's offset in it)
  SAMPLE_END: 100, //   u32 frames, exclusive (VERIFIED; = file length for one-file-per-sample instruments)
  LOOP_START: 104, //   u32 (virtual position, see SEGMENT2_*)
  LOOP_END: 108, //     u32
  LOOP_XFADE: 112, //   u32
  LOOP_TUNE: 116, //    i8
  LOOP_OPTIONS: 117, // u8  bit0 loop ON, bit1 equal-power xfade
  LOOP_DIR: 118, //     u8
  COARSE_TUNE: 164, //  i8  semitones  (UNVERIFIED)
  OUTPUT: 166, //       u8             (UNVERIFIED)
  GROUP_INDEX: 172, //  i32 (-1 = none) (VERIFIED)
  SAMPLE_INDEX: 176, // u32 index into the file's sample chunks, in file order (VERIFIED)
  // Two-segment zones in consolidated CAFs (VERIFIED on Steinway Piano_consolidated.caf): when both are non-zero, the
  // zone's audio is file[SAMPLE_START, SAMPLE_END) followed seamlessly by file[SEGMENT2_START, SEGMENT2_END); the frames
  // in between are digital silence padding. SAMPLE_END is SAMPLE_START + 4 s there, loop points are in the joined
  // ("virtual") timeline, and SEGMENT2_END = LOOP_END + (SEGMENT2_START − SAMPLE_END). In the Steinway instruments
  // only the softest layer's zones own their tail; the louder layers' zones ("Zone #14 copy …") have their own
  // attack segment (peak-normalised, distinct audio) and SEGMENT2_* pointing at the softest layer's tail, which starts
  // at the same level their attack ends (−42 dBFS for C4) — a shared decay, joined seamlessly.
  // Zone VOLUME (88) is non-zero there too (Steinway Piano 2: −5, −6 dB) and group VOLUME differs per layer.
  SEGMENT2_START: 200, // u32
  SEGMENT2_END: 204, //   u32
  MIN_LENGTH: 180,
  WRITE_DATA_SIZE: 104,
});
export const ZONE_OPT = Object.freeze({ ONESHOT: 1 << 0, PITCH_OFF: 1 << 1, REVERSE: 1 << 2, VEL_RANGE_ON: 1 << 3, OUTPUT_ON: 1 << 6 });
export const LOOP_OPT = Object.freeze({ ON: 1 << 0, EQUAL_POWER: 1 << 1 });

// Group chunk. Real files have 120–144 data bytes.
export const GROUP = Object.freeze({
  VOLUME: 84, //     i8  dB (plausible: Yamaha ff +2, mf −1, piano −2)
  PAN: 85, //        i8
  POLYPHONY: 86, //  u8
  OPTIONS: 87, //    u8  bit4 mute (UNVERIFIED; 0x01 in every real group)
  EXCLUSIVE: 88, //  u8
  MIN_VEL: 89, //    u8  (VERIFIED: Yamaha 0-64/65-99/100-117/118-127, Steinway 0-39/40-59/60-89/90-127 tile 0..127)
  MAX_VEL: 90, //    u8  (VERIFIED)
  TRIGGER: 157, //   u8  0 = key down, 1 = key release (UNVERIFIED; 0 in every real group)
  OUTPUT: 158, //    u8
  // "Select group by" (VERIFIED): type 3 = MIDI controller; the group plays only while CC[SELECT_NUMBER] is within
  // SELECT_LOW..SELECT_HIGH. Pedal-up groups are 03 40 00 3F (CC64 0–63), pedal-down groups 03 40 40 7F (CC64 64–127):
  // Yamaha "ff"/"ff sus", Grand Piano "Sustain pedal #1"/"#2", Steinway "V2…"/"p… pedal …". Type 0 = always on.
  SELECT_TYPE: 168, //   u8
  SELECT_NUMBER: 169, // u8
  SELECT_LOW: 170, //    u8
  SELECT_HIGH: 171, //   u8
  KEY_LOW: 172, //       u8 group key range (VERIFIED: Steinway "Single Wound" 0-28, "Double Wound" 29-40, …)
  KEY_HIGH: 173, //      u8
  MIN_LENGTH: 88,
  WRITE_DATA_SIZE: 104,
});
export const GROUP_SELECT = Object.freeze({ NONE: 0, CONTROLLER: 3 });
export const GROUP_OPT = Object.freeze({ MUTE: 1 << 4 });

// Sample chunk. Old files stop after PATH (data size 336); newer ones add FILE_NAME (data size 592, all real files).
export const SAMPLE = Object.freeze({
  WAVE_DATA_START: 84, // u32 byte offset of the audio data in the file (VERIFIED: 512 for the Yamaha WAVs, 4096 for
  //                        Steinway Piano_consolidated.caf = its 'data' chunk + 4-byte edit count; 0 in Keyboard
  //                        Collection files)
  LENGTH: 88, //          u32 frames (VERIFIED: 45988864 for Steinway Piano_consolidated.caf = ffprobe duration_ts)
  SAMPLE_RATE: 92, //     u32 Hz (VERIFIED)
  BIT_DEPTH: 96, //       u32 (VERIFIED: 16 for the pianos, 24 for Keyboard Collection)
  CHANNELS: 100, //       u32 (VERIFIED: 2)
  TYPE: 112, //           4CC stored in file byte order: 'EVAW' / 'ffac' in little-endian files = 'WAVE' / 'caff' (VERIFIED)
  SIZE: 116, //           u32 file size in bytes (VERIFIED: 1576252 = 061_C#3KM56_H.wav on disk; 183959552 = the Steinway
  //                        CAF on disk; Keyboard Collection files store only the audio bytes, frames × 6)
  PATH: 164, //           256B folder path as stored on the authoring machine (VERIFIED)
  PATH_LEN: 256,
  FILE_NAME: 420, //      256B file name (if absent, the chunk name is the file name)
  FILE_NAME_LEN: 256,
  MIN_LENGTH: 100,
  WRITE_DATA_SIZE: 592,
});
