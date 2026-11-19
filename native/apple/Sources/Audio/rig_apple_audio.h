/*
 * rig_apple_audio: the audio output layer of the Apple shell (macOS AUHAL, iPadOS RemoteIO), plain C so that the
 * render callback contains no Swift/ObjC (ARCHITECTURE 5.1). UNBUILT on Linux: written against the CoreAudio headers
 * from memory, to be compiled on a Mac (native/apple/README.md, first-build checklist).
 *
 * Threading: open/close/list are called from the core's control thread (rig_host.audio_start / audio_stop). The render
 * callback runs on the device's IO thread and only calls rig_render(); it never allocates or locks.
 */
#ifndef RIG_APPLE_AUDIO_H
#define RIG_APPLE_AUDIO_H

#include <stddef.h>
#include <stdint.h>
#include <rig/rig_engine.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct rig_apple_audio rig_apple_audio;

/** What the shell asks for. On iPad the AVAudioSession fields are filled in Swift (the session is Objective-C only). */
typedef struct rig_apple_audio_request {
  const char *device_uid;        /**< macOS: CoreAudio device UID; NULL or "" = system default output. iPad: ignored */
  double latency_sec;            /**< 0 = "interactive" (128 frames); else requested buffer duration */
  uint32_t channels;             /**< 2, or 4 for the aux click */
  double session_sample_rate;    /**< iPad: AVAudioSession.sampleRate after setActive */
  double session_latency_sec;    /**< iPad: outputLatency + ioBufferDuration */
  uint32_t session_buffer_frames;/**< iPad: ioBufferDuration * sampleRate */
} rig_apple_audio_request;

/** What was actually opened (maps to rig_device_info). Strings are NUL-terminated copies. */
typedef struct rig_apple_audio_info {
  char device_uid[256];
  char device_name[256];
  double sample_rate;
  uint32_t channels;
  uint32_t buffer_frames;
  double output_latency_sec;
} rig_apple_audio_info;

/**
 * Open the output unit, install the render callback, start it. Returns NULL on failure with `*os_status` = the
 * OSStatus (0 = a non-CoreAudio reason such as no component). `info` is filled on success.
 */
rig_apple_audio *rig_apple_audio_open(rig_engine *engine, const rig_apple_audio_request *req,
                                      rig_apple_audio_info *info, int32_t *os_status);

/** Stop and dispose. NULL is a no-op. After it returns no further rig_render() call happens. */
void rig_apple_audio_close(rig_apple_audio *a);

/**
 * macOS: JSON array of output devices `[{id, name, channels, default, sampleRates}]` (contract 6.4 `get devices`) into
 * buf (NUL-terminated); returns the length needed. iPadOS: returns a one-entry list.
 */
size_t rig_apple_audio_list_devices(char *buf, size_t cap);

/** Current default output device UID (macOS), "" elsewhere. Used to notice default-device changes. */
void rig_apple_audio_default_uid(char *buf, size_t cap);

/**
 * Decode any CoreAudio-readable file (AAC/M4A/ALAC/MP3/WAV) to float32 planes. Matches rig_host.decode_file;
 * returns 0 on success. Free with rig_apple_free_decoded().
 */
int rig_apple_decode_file(void *user, const char *path, rig_decoded_audio *out);
void rig_apple_free_decoded(void *user, rig_decoded_audio *audio);

/** Host clock in ns (mach host time, the timebase of AudioTimeStamp.mHostTime and MIDI packet timestamps). */
uint64_t rig_apple_host_time_ns(void *user);

/**
 * mach host ticks <-> ns via mach_timebase_info (24 MHz ticks on Apple silicon). Replaces AudioConvertHostTimeToNanos
 * / AudioConvertNanosToHostTime, which live in <CoreAudio/HostTime.h> and do not exist on iOS (SETUP_REVIEW S3).
 */
uint64_t rig_apple_host_to_ns(uint64_t host_ticks);
uint64_t rig_apple_ns_to_host(uint64_t ns);

#ifdef __cplusplus
}
#endif
#endif
