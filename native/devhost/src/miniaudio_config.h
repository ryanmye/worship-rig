// miniaudio feature switches for the dev host: identical in every translation unit that includes miniaudio.h
// (miniaudio_impl.c and audio_host.cpp). Only the low-level device API is used.
#pragma once
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
