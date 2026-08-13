/**
 * Sales360 Realtime Streaming — Configuration
 * ADR-002 Week 2 (updated — Deepgram tuned for continuous conversation)
 */

'use strict';

const config = {
  // ── Twilio Media Streams ──────────────────────────────────
  twilio: {
    sampleRate: 8000,
    encoding: 'audio/x-mulaw',
    channels: 1,
    silenceTimeoutMs: 12_000,
  },

  // ── Deepgram (provisional STT) ────────────────────────────
  stt: {
    provider: process.env.STT_PROVIDER || 'deepgram',
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || '',
      model: 'nova-2',
      language: 'en',
      encoding: 'mulaw',
      sampleRate: 8000,
      channels: 1,
      punctuate: true,
      interimResults: true,
      utteranceEndMs: 1000,   // reduced from 1200 — faster turn detection
      endpointing: 500,       // increased from 300 — less aggressive, fewer false finals
      smartFormat: true,
    },
  },

  // ── Claude (SSE streaming) ────────────────────────────────
  llm: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: 300,
    temperature: 0.7,
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: 'https://api.anthropic.com/v1/messages',
  },

  // ── ElevenLabs (WebSocket TTS) ────────────────────────────
  tts: {
    provider: 'elevenlabs',
    elevenlabs: {
      apiKey: process.env.ELEVENLABS_API_KEY || '',
      voiceId: process.env.ELEVENLABS_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a',
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'ulaw_8000',
      wsUrl: 'wss://api.elevenlabs.io/v1/text-to-speech',
      optimizeStreamingLatency: 4,
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: true,
    },
  },

  // ── SpeakableTextChunker ──────────────────────────────────
  chunker: {
    minChunkChars: 12,
    sentenceEnders: /[.!?;:]\s/,
    softBreakMinChars: 30,
    softBreakers: /[,\-–—]\s/,
  },

  // ── Metrics ───────────────────────────────────────────────
  metrics: {
    enabled: true,
    verbose: process.env.METRICS_VERBOSE === 'true',
  },
};

module.exports = config;
