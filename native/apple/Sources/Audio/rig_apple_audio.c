/* See rig_apple_audio.h. UNBUILT on Linux. */
#include "rig_apple_audio.h"

#include <TargetConditionals.h>
#include <AudioToolbox/AudioToolbox.h>
#if TARGET_OS_OSX
#include <CoreAudio/CoreAudio.h> /* AudioHardware.h (AudioObject*) is macOS-only (SETUP_REVIEW S3) */
#endif
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct rig_apple_audio {
  rig_engine *engine;
  AudioUnit unit;
  uint64_t latency_ns;
  uint32_t channels;
  int started;
};

/* ---------------------------------------------------------------------------------------------- render callback */

static OSStatus rig_render_cb(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts, UInt32 bus,
                              UInt32 frames, AudioBufferList *io) {
  (void)bus;
  rig_apple_audio *a = (rig_apple_audio *)ref;
  float *outs[RIG_MAX_OUTPUT_CHANNELS];
  uint32_t n = io->mNumberBuffers;
  if (n > RIG_MAX_OUTPUT_CHANNELS) n = RIG_MAX_OUTPUT_CHANNELS;
  for (uint32_t i = 0; i < n; i++) outs[i] = (float *)io->mBuffers[i].mData;
  uint64_t host_ns = 0;
  if (ts && (ts->mFlags & kAudioTimeStampHostTimeValid)) {
    host_ns = rig_apple_host_to_ns(ts->mHostTime) + a->latency_ns;
  }
  if (rig_render(a->engine, outs, n, frames, host_ns) != RIG_OK) {
    for (uint32_t i = 0; i < io->mNumberBuffers; i++) memset(io->mBuffers[i].mData, 0, io->mBuffers[i].mDataByteSize);
    *flags |= kAudioUnitRenderAction_OutputIsSilence;
  }
  return noErr;
}

/* ---------------------------------------------------------------------------------------------- helpers */

static void cfstr_to_c(CFStringRef s, char *dst, size_t cap) {
  if (!cap) return;
  dst[0] = 0;
  if (s) CFStringGetCString(s, dst, (CFIndex)cap, kCFStringEncodingUTF8);
}

static OSStatus set_stream_format(AudioUnit unit, double sr, uint32_t channels) {
  AudioStreamBasicDescription f;
  memset(&f, 0, sizeof f);
  f.mSampleRate = sr;
  f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
  f.mBytesPerPacket = 4;
  f.mFramesPerPacket = 1;
  f.mBytesPerFrame = 4;
  f.mChannelsPerFrame = channels;
  f.mBitsPerChannel = 32;
  return AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f);
}

static OSStatus install_callback(rig_apple_audio *a) {
  AURenderCallbackStruct cb = {rig_render_cb, a};
  return AudioUnitSetProperty(a->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
}

#if TARGET_OS_OSX

static const AudioObjectPropertyAddress ADDR_DEVICES = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                                        kAudioObjectPropertyElementMain};
static const AudioObjectPropertyAddress ADDR_DEFAULT_OUT = {kAudioHardwarePropertyDefaultOutputDevice,
                                                            kAudioObjectPropertyScopeGlobal,
                                                            kAudioObjectPropertyElementMain};

static uint32_t device_out_channels(AudioDeviceID dev) {
  AudioObjectPropertyAddress pa = {kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput,
                                   kAudioObjectPropertyElementMain};
  UInt32 sz = 0;
  if (AudioObjectGetPropertyDataSize(dev, &pa, 0, NULL, &sz) != noErr || sz == 0) return 0;
  AudioBufferList *bl = (AudioBufferList *)malloc(sz);
  if (!bl) return 0;
  uint32_t ch = 0;
  if (AudioObjectGetPropertyData(dev, &pa, 0, NULL, &sz, bl) == noErr) {
    for (UInt32 i = 0; i < bl->mNumberBuffers; i++) ch += bl->mBuffers[i].mNumberChannels;
  }
  free(bl);
  return ch;
}

static int device_string(AudioDeviceID dev, AudioObjectPropertySelector sel, char *dst, size_t cap) {
  AudioObjectPropertyAddress pa = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  CFStringRef s = NULL;
  UInt32 sz = sizeof s;
  if (AudioObjectGetPropertyData(dev, &pa, 0, NULL, &sz, &s) != noErr || !s) return -1;
  cfstr_to_c(s, dst, cap);
  CFRelease(s);
  return 0;
}

static double device_rate(AudioDeviceID dev) {
  AudioObjectPropertyAddress pa = {kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain};
  Float64 r = 48000;
  UInt32 sz = sizeof r;
  if (AudioObjectGetPropertyData(dev, &pa, 0, NULL, &sz, &r) != noErr) r = 48000;
  return r;
}

static AudioDeviceID default_output(void) {
  AudioDeviceID d = kAudioObjectUnknown;
  UInt32 sz = sizeof d;
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &ADDR_DEFAULT_OUT, 0, NULL, &sz, &d);
  return d;
}

static AudioDeviceID find_device(const char *uid) {
  if (uid && uid[0]) {
    CFStringRef cf = CFStringCreateWithCString(NULL, uid, kCFStringEncodingUTF8);
    AudioDeviceID dev = kAudioObjectUnknown;
    AudioValueTranslation tr = {&cf, sizeof cf, &dev, sizeof dev};
    UInt32 sz = sizeof tr;
    AudioObjectPropertyAddress pa = {kAudioHardwarePropertyDeviceForUID, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
    OSStatus st = AudioObjectGetPropertyData(kAudioObjectSystemObject, &pa, 0, NULL, &sz, &tr);
    CFRelease(cf);
    if (st == noErr && dev != kAudioObjectUnknown) return dev;
  }
  return default_output();
}

/** Frames of device + safety offset + first output stream latency, in seconds, plus the buffer. */
static double device_latency_sec(AudioDeviceID dev, double sr, UInt32 buffer_frames) {
  UInt32 lat = 0, safety = 0, stream_lat = 0, sz = sizeof(UInt32);
  AudioObjectPropertyAddress pa = {kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput,
                                   kAudioObjectPropertyElementMain};
  AudioObjectGetPropertyData(dev, &pa, 0, NULL, &sz, &lat);
  pa.mSelector = kAudioDevicePropertySafetyOffset;
  sz = sizeof(UInt32);
  AudioObjectGetPropertyData(dev, &pa, 0, NULL, &sz, &safety);
  pa.mSelector = kAudioDevicePropertyStreams;
  UInt32 ssz = 0;
  if (AudioObjectGetPropertyDataSize(dev, &pa, 0, NULL, &ssz) == noErr && ssz >= sizeof(AudioStreamID)) {
    AudioStreamID first = 0;
    UInt32 one = sizeof first;
    AudioObjectPropertyAddress sa = {kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
    AudioStreamID *ids = (AudioStreamID *)malloc(ssz);
    if (ids && AudioObjectGetPropertyData(dev, &pa, 0, NULL, &ssz, ids) == noErr) {
      first = ids[0];
      sz = sizeof(UInt32);
      AudioObjectGetPropertyData(first, &sa, 0, NULL, &sz, &stream_lat);
    }
    free(ids);
    (void)one;
  }
  return ((double)lat + (double)safety + (double)stream_lat + (double)buffer_frames) / sr;
}

static UInt32 choose_buffer_frames(AudioDeviceID dev, double sr, double latency_sec, uint32_t frames) {
  UInt32 want = 128;
  if (frames > 0) {  // T00c D2 (UNBUILT here): the user's buffer size as asked, 64 included (two calls/quantum)
    want = frames;
  } else if (latency_sec > 0) {
    UInt32 f = (UInt32)(latency_sec * sr + 0.5);
    want = ((f + 127) / 128) * 128;
    if (want < 128) want = 128;
  }
  AudioObjectPropertyAddress ra = {kAudioDevicePropertyBufferFrameSizeRange, kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain};
  AudioValueRange range = {0, 0};
  UInt32 sz = sizeof range;
  if (AudioObjectGetPropertyData(dev, &ra, 0, NULL, &sz, &range) == noErr && range.mMaximum > 0) {
    if (want < (UInt32)range.mMinimum) want = (UInt32)range.mMinimum;
    if (want > (UInt32)range.mMaximum) want = (UInt32)range.mMaximum;
  }
  AudioObjectPropertyAddress ba = {kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal,
                                   kAudioObjectPropertyElementMain};
  AudioObjectSetPropertyData(dev, &ba, 0, NULL, sizeof want, &want);
  UInt32 got = want;
  sz = sizeof got;
  AudioObjectGetPropertyData(dev, &ba, 0, NULL, &sz, &got);
  return got;
}

rig_apple_audio *rig_apple_audio_open(rig_engine *engine, const rig_apple_audio_request *req,
                                      rig_apple_audio_info *info, int32_t *os_status) {
  int32_t dummy;
  if (!os_status) os_status = &dummy;
  *os_status = 0;
  AudioDeviceID dev = find_device(req->device_uid);
  if (dev == kAudioObjectUnknown) {
    *os_status = kAudioHardwareBadDeviceError;
    return NULL;
  }
  uint32_t dev_ch = device_out_channels(dev);
  uint32_t ch = req->channels >= 4 && dev_ch >= 4 ? 4 : 2;
  if (dev_ch == 1) ch = 2; /* AUHAL up-mixes a mono device; the core always renders stereo */
  double sr = device_rate(dev);

  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_HALOutput,
                                 kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent comp = AudioComponentFindNext(NULL, &d);
  if (!comp) return NULL;
  rig_apple_audio *a = (rig_apple_audio *)calloc(1, sizeof *a);
  if (!a) return NULL;
  a->engine = engine;
  a->channels = ch;
  OSStatus st = AudioComponentInstanceNew(comp, &a->unit);
  if (st != noErr) goto fail;
  /* the HAL output unit starts with input enabled and output disabled on bus 0; we want output only */
  UInt32 on = 1, off = 0;
  AudioUnitSetProperty(a->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &off, sizeof off);
  if ((st = AudioUnitSetProperty(a->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on,
                                 sizeof on)) != noErr) goto fail;
  if ((st = AudioUnitSetProperty(a->unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev,
                                 sizeof dev)) != noErr) goto fail;
  UInt32 frames = choose_buffer_frames(dev, sr, req->latency_sec, req->buffer_frames);
  if ((st = set_stream_format(a->unit, sr, ch)) != noErr) goto fail;
  if ((st = install_callback(a)) != noErr) goto fail;
  if ((st = AudioUnitInitialize(a->unit)) != noErr) goto fail;
  double lat = device_latency_sec(dev, sr, frames);
  a->latency_ns = (uint64_t)(lat * 1e9);
  if ((st = AudioOutputUnitStart(a->unit)) != noErr) goto fail_init;
  a->started = 1;
  memset(info, 0, sizeof *info);
  device_string(dev, kAudioDevicePropertyDeviceUID, info->device_uid, sizeof info->device_uid);
  device_string(dev, kAudioObjectPropertyName, info->device_name, sizeof info->device_name);
  info->sample_rate = sr;
  info->channels = ch;
  info->buffer_frames = frames;
  info->output_latency_sec = lat;
  return a;
fail_init:
  AudioUnitUninitialize(a->unit);
fail:
  if (a->unit) AudioComponentInstanceDispose(a->unit);
  free(a);
  *os_status = (int32_t)st;
  return NULL;
}

size_t rig_apple_audio_list_devices(char *buf, size_t cap) {
  size_t need = 0;
  char *out = buf;
  size_t room = cap;
#define APPEND(...)                                                              \
  do {                                                                           \
    int n_ = snprintf(out && room ? out : NULL, room, __VA_ARGS__);              \
    if (n_ > 0) {                                                                \
      need += (size_t)n_;                                                        \
      if (out && room) {                                                         \
        size_t w_ = (size_t)n_ < room ? (size_t)n_ : room - 1;                   \
        out += w_;                                                               \
        room -= w_;                                                              \
      }                                                                          \
    }                                                                            \
  } while (0)
  UInt32 sz = 0;
  AudioDeviceID def = default_output();
  APPEND("[");
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &ADDR_DEVICES, 0, NULL, &sz) == noErr && sz) {
    AudioDeviceID *devs = (AudioDeviceID *)malloc(sz);
    if (devs && AudioObjectGetPropertyData(kAudioObjectSystemObject, &ADDR_DEVICES, 0, NULL, &sz, devs) == noErr) {
      int first = 1;
      for (UInt32 i = 0; i < sz / sizeof(AudioDeviceID); i++) {
        uint32_t ch = device_out_channels(devs[i]);
        if (!ch) continue;
        char uid[256] = "", name[256] = "", esc_uid[520], esc_name[520];
        device_string(devs[i], kAudioDevicePropertyDeviceUID, uid, sizeof uid);
        device_string(devs[i], kAudioObjectPropertyName, name, sizeof name);
        const char *src[2] = {uid, name};
        char *dst[2] = {esc_uid, esc_name};
        for (int k = 0; k < 2; k++) { /* JSON string escape */
          char *w = dst[k];
          for (const char *p = src[k]; *p && w < dst[k] + 510; p++) {
            if (*p == '"' || *p == '\\') *w++ = '\\';
            if ((unsigned char)*p >= 0x20) *w++ = *p;
          }
          *w = 0;
        }
        APPEND("%s{\"id\":\"%s\",\"name\":\"%s\",\"channels\":%u,\"default\":%s,"
               "\"sampleRates\":[%.0f]}", first ? "" : ",",
               esc_uid, esc_name, ch, devs[i] == def ? "true" : "false", device_rate(devs[i]));
        first = 0;
      }
    }
    free(devs);
  }
  APPEND("]");
#undef APPEND
  return need;
}

void rig_apple_audio_default_uid(char *buf, size_t cap) {
  if (!cap) return;
  buf[0] = 0;
  AudioDeviceID d = default_output();
  if (d != kAudioObjectUnknown) device_string(d, kAudioDevicePropertyDeviceUID, buf, cap);
}

#else /* iPadOS (RemoteIO). The AVAudioSession is configured in Swift before this is called. */

rig_apple_audio *rig_apple_audio_open(rig_engine *engine, const rig_apple_audio_request *req,
                                      rig_apple_audio_info *info, int32_t *os_status) {
  int32_t dummy;
  if (!os_status) os_status = &dummy;
  *os_status = 0;
  double sr = req->session_sample_rate > 0 ? req->session_sample_rate : 48000;
  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent comp = AudioComponentFindNext(NULL, &d);
  if (!comp) return NULL;
  rig_apple_audio *a = (rig_apple_audio *)calloc(1, sizeof *a);
  if (!a) return NULL;
  a->engine = engine;
  a->channels = 2; /* aux click needs a multichannel USB interface: later (ARCHITECTURE 5.1) */
  OSStatus st = AudioComponentInstanceNew(comp, &a->unit);
  if (st != noErr) goto fail;
  if ((st = set_stream_format(a->unit, sr, 2)) != noErr) goto fail;
  if ((st = install_callback(a)) != noErr) goto fail;
  if ((st = AudioUnitInitialize(a->unit)) != noErr) goto fail;
  a->latency_ns = (uint64_t)(req->session_latency_sec * 1e9);
  if ((st = AudioOutputUnitStart(a->unit)) != noErr) {
    AudioUnitUninitialize(a->unit);
    goto fail;
  }
  a->started = 1;
  memset(info, 0, sizeof *info);
  snprintf(info->device_uid, sizeof info->device_uid, "default");
  snprintf(info->device_name, sizeof info->device_name, "iPad output");
  info->sample_rate = sr;
  info->channels = 2;
  info->buffer_frames = req->session_buffer_frames;
  info->output_latency_sec = req->session_latency_sec;
  return a;
fail:
  if (a->unit) AudioComponentInstanceDispose(a->unit);
  free(a);
  *os_status = (int32_t)st;
  return NULL;
}

size_t rig_apple_audio_list_devices(char *buf, size_t cap) {
  const char *j = "[{\"id\":\"default\",\"name\":\"iPad output\",\"channels\":2,\"default\":true,"
                  "\"sampleRates\":[48000]}]";
  size_t n = strlen(j);
  if (buf && cap) snprintf(buf, cap, "%s", j);
  return n;
}

void rig_apple_audio_default_uid(char *buf, size_t cap) {
  if (cap) buf[0] = 0;
}

#endif /* TARGET_OS_OSX */

void rig_apple_audio_close(rig_apple_audio *a) {
  if (!a) return;
  if (a->started) AudioOutputUnitStop(a->unit);
  AudioUnitUninitialize(a->unit);
  AudioComponentInstanceDispose(a->unit);
  free(a);
}

/* ---------------------------------------------------------------------------------------------- decode, clock */

int rig_apple_decode_file(void *user, const char *path, rig_decoded_audio *out) {
  (void)user;
  CFStringRef p = CFStringCreateWithCString(NULL, path, kCFStringEncodingUTF8);
  CFURLRef url = CFURLCreateWithFileSystemPath(NULL, p, kCFURLPOSIXPathStyle, false);
  CFRelease(p);
  ExtAudioFileRef f = NULL;
  OSStatus st = ExtAudioFileOpenURL(url, &f);
  CFRelease(url);
  if (st != noErr) return -1;
  AudioStreamBasicDescription src;
  UInt32 sz = sizeof src;
  if (ExtAudioFileGetProperty(f, kExtAudioFileProperty_FileDataFormat, &sz, &src) != noErr) goto bad;
  SInt64 frames = 0;
  sz = sizeof frames;
  if (ExtAudioFileGetProperty(f, kExtAudioFileProperty_FileLengthFrames, &sz, &frames) != noErr || frames <= 0) {
    goto bad;
  }
  uint32_t ch = src.mChannelsPerFrame >= 2 ? 2 : 1;
  AudioStreamBasicDescription cf;
  memset(&cf, 0, sizeof cf);
  cf.mSampleRate = src.mSampleRate;
  cf.mFormatID = kAudioFormatLinearPCM;
  cf.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
  cf.mBytesPerPacket = cf.mBytesPerFrame = 4;
  cf.mFramesPerPacket = 1;
  cf.mChannelsPerFrame = ch;
  cf.mBitsPerChannel = 32;
  if (ExtAudioFileSetProperty(f, kExtAudioFileProperty_ClientDataFormat, sizeof cf, &cf) != noErr) goto bad;
  float **planes = (float **)calloc(ch, sizeof(float *));
  if (!planes) goto bad;
  for (uint32_t c = 0; c < ch; c++) {
    planes[c] = (float *)malloc((size_t)frames * sizeof(float));
    if (!planes[c]) {
      for (uint32_t k = 0; k < c; k++) free(planes[k]);
      free(planes);
      goto bad;
    }
  }
  const UInt32 CHUNK = 16384;
  SInt64 done = 0;
  AudioBufferList *bl = (AudioBufferList *)malloc(offsetof(AudioBufferList, mBuffers) + ch * sizeof(AudioBuffer));
  while (done < frames) {
    UInt32 n = (UInt32)((frames - done) < CHUNK ? (frames - done) : CHUNK);
    bl->mNumberBuffers = ch;
    for (uint32_t c = 0; c < ch; c++) {
      bl->mBuffers[c].mNumberChannels = 1;
      bl->mBuffers[c].mDataByteSize = n * sizeof(float);
      bl->mBuffers[c].mData = planes[c] + done;
    }
    if (ExtAudioFileRead(f, &n, bl) != noErr || n == 0) break;
    done += n;
  }
  free(bl);
  ExtAudioFileDispose(f);
  out->struct_size = sizeof *out;
  out->sample_rate = src.mSampleRate;
  out->channels = ch;
  out->frames = (uint64_t)done;
  out->data = planes;
  out->host_cookie = NULL;
  return done > 0 ? 0 : -1;
bad:
  ExtAudioFileDispose(f);
  return -1;
}

void rig_apple_free_decoded(void *user, rig_decoded_audio *audio) {
  (void)user;
  if (!audio || !audio->data) return;
  for (uint32_t c = 0; c < audio->channels; c++) free(audio->data[c]);
  free(audio->data);
  audio->data = NULL;
}

uint64_t rig_apple_host_time_ns(void *user) {
  (void)user;
  return rig_apple_host_to_ns(mach_absolute_time());
}

/* ---------------------------------------------------------------------------------------------- host time */

static mach_timebase_info_data_t rig_timebase(void) {
  static mach_timebase_info_data_t tb; /* benign race: every writer stores the same value */
  if (tb.denom == 0) mach_timebase_info(&tb);
  return tb;
}

uint64_t rig_apple_host_to_ns(uint64_t t) {
  mach_timebase_info_data_t tb = rig_timebase();
  if (tb.numer == tb.denom) return t;
  return (uint64_t)((__uint128_t)t * tb.numer / tb.denom);
}

uint64_t rig_apple_ns_to_host(uint64_t ns) {
  mach_timebase_info_data_t tb = rig_timebase();
  if (tb.numer == tb.denom) return ns;
  return (uint64_t)((__uint128_t)ns * tb.denom / tb.numer);
}
