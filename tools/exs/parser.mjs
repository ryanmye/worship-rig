// Defensive parser for EXS24 / Logic Sampler instrument files (.exs). Layout and its provenance: ./layout.mjs.
// parseExs(buffer) never throws on a damaged body: it stops at the first chunk that does not fit and records a
// warning. It throws only when the file is not recognisably an EXS file at all.
import { HEADER_SIZE, NAME_OFFSET, NAME_LEN, MAGIC_OFFSET, MAGIC_LE, MAGIC_BE, HEADER, CHUNK, CHUNK_NAMES, ZONE, ZONE_OPT, LOOP_OPT, GROUP, GROUP_OPT, GROUP_SELECT, SAMPLE } from './layout.mjs';

export class ExsFormatError extends Error {}

/** NUL-terminated string from a fixed-width field; bytes ≥ 0x80 decoded as UTF-8 if valid, else latin1. */
export function readCString(buf, off, len) {
  const end = Math.min(buf.length, off + len);
  if (off >= end) return '';
  let n = off;
  while (n < end && buf[n] !== 0) n++;
  const raw = buf.subarray(off, n);
  const utf = raw.toString('utf8');
  const s = utf.includes('�') ? raw.toString('latin1') : utf;
  return s.replace(/[\x00-\x1f]/g, '').trim();
}

/** Detect endianness from the first chunk's magic. Returns { bigEndian, magic } or throws ExsFormatError. */
export function detectEndian(buf) {
  if (!buf || buf.length < HEADER_SIZE) throw new ExsFormatError(`file too short for an EXS header (${buf?.length ?? 0} bytes < ${HEADER_SIZE})`);
  const magic = buf.toString('latin1', MAGIC_OFFSET, MAGIC_OFFSET + 4);
  if (MAGIC_LE.includes(magic)) return { bigEndian: false, magic };
  if (MAGIC_BE.includes(magic)) return { bigEndian: true, magic };
  throw new ExsFormatError(`not an EXS file: magic at offset 16 is ${JSON.stringify(magic)} (expected TBOS/SOBT/JBOS/SOBJ)`);
}

function reader(buf, bigEndian) {
  const u32 = (o) => (o + 4 <= buf.length ? (bigEndian ? buf.readUInt32BE(o) : buf.readUInt32LE(o)) : null);
  const i32 = (o) => (o + 4 <= buf.length ? (bigEndian ? buf.readInt32BE(o) : buf.readInt32LE(o)) : null);
  const u8 = (o) => (o < buf.length ? buf[o] : null);
  const i8 = (o) => (o < buf.length ? buf.readInt8(o) : null);
  return { u32, i32, u8, i8, bigEndian };
}

/**
 * Iterate chunks. Yields { type, typeName, offset, size, length, index, flags, magic, name } and stops (with a
 * warning pushed into `warnings`) at a truncated or implausible chunk.
 */
export function* walkChunks(buf, bigEndian, warnings = []) {
  const { u32 } = reader(buf, bigEndian);
  let off = 0;
  let n = 0;
  while (off < buf.length) {
    if (off + HEADER_SIZE > buf.length) {
      if (buf.length - off > 0 && buf.subarray(off).some((b) => b !== 0)) warnings.push(`trailing ${buf.length - off} bytes at offset ${off} ignored (shorter than a chunk header)`);
      return;
    }
    const sig = u32(off);
    const size = u32(off + 4);
    const magic = buf.toString('latin1', off + MAGIC_OFFSET, off + MAGIC_OFFSET + 4);
    const known = MAGIC_LE.includes(magic) || MAGIC_BE.includes(magic);
    if (!known) {
      warnings.push(`chunk #${n} at offset ${off}: unexpected magic ${JSON.stringify(magic)}; stopping`);
      return;
    }
    if (off + HEADER_SIZE + size > buf.length) {
      warnings.push(`chunk #${n} at offset ${off}: size ${size} runs past end of file (${buf.length}); stopping`);
      return;
    }
    const type = (sig >>> 24) & 0x0f;
    yield {
      type,
      typeName: CHUNK_NAMES[type] || `type${type}`,
      sig,
      offset: off,
      size,
      length: HEADER_SIZE + size,
      index: u32(off + 8),
      flags: u32(off + 12),
      magic,
      name: readCString(buf, off + NAME_OFFSET, NAME_LEN),
    };
    off += HEADER_SIZE + size;
    n++;
  }
}

function parseZone(buf, c, r, warnings) {
  const o = c.offset;
  if (c.length < ZONE.MIN_LENGTH) {
    warnings.push(`zone "${c.name}" at ${o}: chunk only ${c.length} bytes (< ${ZONE.MIN_LENGTH}); skipped`);
    return null;
  }
  const opts = r.u8(o + ZONE.OPTIONS);
  const loopOpts = r.u8(o + ZONE.LOOP_OPTIONS);
  let keyLow = r.u8(o + ZONE.KEY_LOW);
  let keyHigh = r.u8(o + ZONE.KEY_HIGH);
  if (keyLow > keyHigh) [keyLow, keyHigh] = [keyHigh, keyLow];
  const z = {
    name: c.name,
    offset: o,
    options: opts,
    oneShot: !!(opts & ZONE_OPT.ONESHOT),
    pitch: !(opts & ZONE_OPT.PITCH_OFF),
    reverse: !!(opts & ZONE_OPT.REVERSE),
    velRangeOn: !!(opts & ZONE_OPT.VEL_RANGE_ON),
    rootNote: r.u8(o + ZONE.ROOT),
    fineTune: r.i8(o + ZONE.FINE_TUNE),
    coarseTune: r.i8(o + ZONE.COARSE_TUNE),
    pan: r.i8(o + ZONE.PAN),
    volume: r.i8(o + ZONE.VOLUME),
    keyLow,
    keyHigh,
    velLow: r.u8(o + ZONE.VEL_LOW),
    velHigh: r.u8(o + ZONE.VEL_HIGH),
    sampleStart: r.u32(o + ZONE.SAMPLE_START),
    sampleEnd: r.u32(o + ZONE.SAMPLE_END),
    loopStart: r.u32(o + ZONE.LOOP_START),
    loopEnd: r.u32(o + ZONE.LOOP_END),
    loopCrossfade: r.u32(o + ZONE.LOOP_XFADE),
    loopOn: !!(loopOpts & LOOP_OPT.ON),
    groupIndex: r.i32(o + ZONE.GROUP_INDEX),
    sampleIndex: r.u32(o + ZONE.SAMPLE_INDEX),
    segment2: null,
  };
  if (c.length >= ZONE.SEGMENT2_END + 4) {
    const s2 = r.u32(o + ZONE.SEGMENT2_START);
    const e2 = r.u32(o + ZONE.SEGMENT2_END);
    // Only a well-formed second segment counts: non-empty and not overlapping the first. It usually follows the
    // first segment after some silence padding, but Steinway's louder velocity layers point it back at the softest
    // layer's tail (a shared, level-matched decay) — see layout.mjs.
    if (s2 && e2 > s2 && z.sampleEnd > z.sampleStart && (s2 >= z.sampleEnd || e2 <= z.sampleStart)) z.segment2 = { start: s2, end: e2 };
  }
  if (z.rootNote > 127) {
    warnings.push(`zone "${z.name}": root note ${z.rootNote} > 127; clamped`);
    z.rootNote = 127;
  }
  if (keyHigh > 127) z.keyHigh = 127;
  if (z.velLow > 127) z.velLow = 127;
  if (z.velHigh > 127) z.velHigh = 127;
  if (z.velLow > z.velHigh) [z.velLow, z.velHigh] = [z.velHigh, z.velLow];
  return z;
}

function parseGroup(buf, c, r) {
  const o = c.offset;
  const has = (off) => off < o + c.length;
  const opts = has(o + GROUP.OPTIONS) ? r.u8(o + GROUP.OPTIONS) : 0;
  const trig = has(o + GROUP.TRIGGER) ? r.u8(o + GROUP.TRIGGER) : null;
  let select = null;
  if (has(o + GROUP.KEY_HIGH)) {
    const type = r.u8(o + GROUP.SELECT_TYPE);
    if (type === GROUP_SELECT.CONTROLLER) {
      let lo = r.u8(o + GROUP.SELECT_LOW);
      let hi = r.u8(o + GROUP.SELECT_HIGH);
      if (lo > hi) [lo, hi] = [hi, lo];
      select = { type: 'cc', number: r.u8(o + GROUP.SELECT_NUMBER), low: lo, high: hi };
    } else if (type !== GROUP_SELECT.NONE) select = { type: `type${type}`, raw: type };
  }
  let keyLow = has(o + GROUP.KEY_HIGH) ? r.u8(o + GROUP.KEY_LOW) : 0;
  let keyHigh = has(o + GROUP.KEY_HIGH) ? r.u8(o + GROUP.KEY_HIGH) : 127;
  if (keyLow > keyHigh) [keyLow, keyHigh] = [keyHigh, keyLow];
  let minVel = has(o + GROUP.MIN_VEL) ? r.u8(o + GROUP.MIN_VEL) : null;
  let maxVel = has(o + GROUP.MAX_VEL) ? r.u8(o + GROUP.MAX_VEL) : null;
  if (minVel != null && maxVel != null && minVel > maxVel) [minVel, maxVel] = [maxVel, minVel];
  return {
    name: c.name,
    offset: o,
    select,
    keyLow,
    keyHigh: Math.min(127, keyHigh),
    volume: has(o + GROUP.VOLUME) ? r.i8(o + GROUP.VOLUME) : 0,
    pan: has(o + GROUP.PAN) ? r.i8(o + GROUP.PAN) : 0,
    polyphony: has(o + GROUP.POLYPHONY) ? r.u8(o + GROUP.POLYPHONY) : 0,
    options: opts,
    mute: !!(opts & GROUP_OPT.MUTE),
    minVel: minVel == null ? null : Math.min(127, minVel),
    maxVel: maxVel == null ? null : Math.min(127, maxVel),
    // Only 0/1 are meaningful; anything else means the offset is wrong for this file → treat as unknown.
    trigger: trig === 0 || trig === 1 ? trig : null,
    triggerRaw: trig,
  };
}

function parseSample(buf, c, r, warnings) {
  const o = c.offset;
  if (c.length < SAMPLE.MIN_LENGTH) {
    warnings.push(`sample "${c.name}" at ${o}: chunk only ${c.length} bytes; using name only`);
    return { name: c.name, fileName: c.name, path: '', length: 0, sampleRate: 0, bitDepth: 0, channels: 0, offset: o };
  }
  const end = o + c.length;
  const path = o + SAMPLE.PATH < end ? readCString(buf, o + SAMPLE.PATH, Math.min(SAMPLE.PATH_LEN, end - (o + SAMPLE.PATH))) : '';
  const fileField = o + SAMPLE.FILE_NAME < end ? readCString(buf, o + SAMPLE.FILE_NAME, Math.min(SAMPLE.FILE_NAME_LEN, end - (o + SAMPLE.FILE_NAME))) : '';
  // Bit depth: u32 per layout; some readers take a single byte at 96. Accept whichever is plausible.
  let bitDepth = r.u32(o + SAMPLE.BIT_DEPTH);
  if (!(bitDepth >= 8 && bitDepth <= 64)) {
    const alt = [r.u8(o + SAMPLE.BIT_DEPTH), r.u8(o + SAMPLE.BIT_DEPTH + 3)].find((b) => b >= 8 && b <= 64);
    bitDepth = alt ?? 0;
  }
  let channels = r.u32(o + SAMPLE.CHANNELS);
  if (!(channels >= 1 && channels <= 8)) channels = 0;
  const sampleRate = r.u32(o + SAMPLE.SAMPLE_RATE);
  // The 4CC is stored as a u32 in the file's byte order, so little-endian files hold it reversed ('EVAW' = 'WAVE').
  let typeRaw = o + SAMPLE.TYPE + 4 <= end ? buf.toString('latin1', o + SAMPLE.TYPE, o + SAMPLE.TYPE + 4) : '';
  if (!r.bigEndian) typeRaw = typeRaw.split('').reverse().join('');
  return {
    name: c.name,
    fileName: fileField || c.name,
    path,
    length: r.u32(o + SAMPLE.LENGTH) ?? 0,
    sampleRate: sampleRate >= 4000 && sampleRate <= 768000 ? sampleRate : 0,
    bitDepth,
    channels,
    type: /^[\x20-\x7e]{4}$/.test(typeRaw) ? typeRaw : '',
    dataOffset: r.u32(o + SAMPLE.WAVE_DATA_START) ?? 0,
    fileSize: o + SAMPLE.SIZE + 4 <= end ? r.u32(o + SAMPLE.SIZE) : 0,
    offset: o,
  };
}

/**
 * Parse an .exs buffer.
 * @param {Buffer|Uint8Array} input
 * @returns {{ bigEndian:boolean, magic:string, name:string, zones:object[], groups:object[], samples:object[],
 *             chunks:{type:number,typeName:string,offset:number,length:number,name:string}[], warnings:string[] }}
 */
export function parseExs(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const { bigEndian, magic } = detectEndian(buf);
  const r = reader(buf, bigEndian);
  const warnings = [];
  const out = { bigEndian, magic, name: '', counts: null, zones: [], groups: [], samples: [], chunks: [], warnings };
  for (const c of walkChunks(buf, bigEndian, warnings)) {
    out.chunks.push({ type: c.type, typeName: c.typeName, offset: c.offset, length: c.length, name: c.name });
    switch (c.type) {
      case CHUNK.HEADER:
        if (!out.name) out.name = c.name;
        if (!out.counts && c.length >= HEADER.MIN_LENGTH) {
          out.counts = { zones: r.u32(c.offset + HEADER.ZONE_COUNT), groups: r.u32(c.offset + HEADER.GROUP_COUNT), samples: r.u32(c.offset + HEADER.SAMPLE_COUNT), params: r.u32(c.offset + HEADER.PARAM_COUNT) };
        }
        break;
      case CHUNK.ZONE: {
        const z = parseZone(buf, c, r, warnings);
        if (z) out.zones.push(z);
        break;
      }
      case CHUNK.GROUP:
        out.groups.push(parseGroup(buf, c, r));
        break;
      case CHUNK.SAMPLE:
        out.samples.push(parseSample(buf, c, r, warnings));
        break;
      default:
        break; // params / unknown: ignored
    }
  }
  for (const z of out.zones) {
    if (z.sampleIndex == null || z.sampleIndex >= out.samples.length) {
      warnings.push(`zone "${z.name}": sample index ${z.sampleIndex} out of range (${out.samples.length} samples)`);
      z.invalid = true;
    }
    if (z.groupIndex != null && z.groupIndex >= out.groups.length) z.groupIndex = -1;
  }
  if (out.counts) {
    for (const k of ['zones', 'groups', 'samples']) {
      if (out.counts[k] !== out[k].length) warnings.push(`header says ${out.counts[k]} ${k}, file has ${out[k].length}`);
    }
  }
  if (!out.zones.length) warnings.push('no zones found');
  return out;
}
