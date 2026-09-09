/**
 * Sales360 Realtime Streaming — Configuration
 * ADR-002 Week 2 — v3
 *
 * Deepgram configured per ChatGPT recommendation:
 * - endpointing: 400ms (fast VAD for speech_final detection)
 * - utteranceEndMs: 1000ms (backstop only)
 * - vad_events: true (enables SpeechStarted for commit cancellation)
 *
 * TurnCompletionController handles the rest adaptively.
 */

'use strict';

const config = {
  twilio: {
    sampleRate: 8000,
    encoding: 'audio/x-mulaw',
    channels: 1,
    silenceTimeoutMs: 12_000,
  },

  stt: {
    provider: process.env.STT_PROVIDER || 'deepgram',
    deepgram: {
      apiKey:         process.env.DEEPGRAM_API_KEY || '',
      model:          'nova-2',
      language:       'en',
      encoding:       'mulaw',
      sampleRate:     8000,
      channels:       1,
      punctuate:      true,
      interimResults: true,
      utteranceEndMs: 1000,   // backstop only — TurnCompletionController is primary
      endpointing:    400,    // fast speech_final detection (ChatGPT recommended 400-500ms)
      smartFormat:    true,
    },
  },

  llm: {
    model:       process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens:   300,
    temperature: 0.7,
    apiKey:      process.env.ANTHROPIC_API_KEY || '',
    baseUrl:     'https://api.anthropic.com/v1/messages',
  },

  tts: {
    provider: 'elevenlabs',
    elevenlabs: {
      apiKey:                    process.env.ELEVENLABS_API_KEY || '',
      voiceId:                   process.env.ELEVENLABS_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a',
      modelId:                   'eleven_turbo_v2_5',
      outputFormat:              'ulaw_8000',
      wsUrl:                     'wss://api.elevenlabs.io/v1/text-to-speech',
      optimizeStreamingLatency:  4,
      stability:                 0.5,
      similarityBoost:           0.75,
      style:                     0,
      useSpeakerBoost:           true,
    },
  },

  chunker: {
    minChunkChars:    12,
    sentenceEnders:   /[.!?;:]\s/,
    softBreakMinChars: 30,
    softBreakers:     /[,\-–—]\s/,
  },

  metrics: {
    enabled: true,
    verbose: process.env.METRICS_VERBOSE === 'true',
  },
};

module.exports = config;
