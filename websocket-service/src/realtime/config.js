/**
 * Sales360 Realtime Streaming — Configuration
 * ADR-002 Week 1
 *
 * Centralises every tuneable for the realtime pipeline.
 * Nothing here touches the legacy polling system.
 */

'use strict';

const config = {
  // ── Twilio Media Streams ──────────────────────────────────
  twilio: {
    // μ-law 8 kHz mono — Twilio's native format
    sampleRate: 8000,
    encoding: 'audio/x-mulaw',
    channels: 1,
    // Max silence before we treat the caller as gone (ms)
    silenceTimeoutMs: 12_000,
  },

  // ── Deepgram (provisional STT — pluggable via STTAdapter) ─
  stt: {
    provider: process.env.STT_PROVIDER || 'deepgram',
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || '',
      model: 'nova-2',
      language: 'en',
      // Stream config
      encoding: 'mulaw',
      sampleRate: 8000,
      channels: 1,
      punctuate: true,
      interimResults: true,
      utteranceEndMs: 1200,      // silence gap to finalise utterance
      endpointing: 300,          // VAD endpointing (ms)
      smartFormat: true,
    },
  },

  // ── Claude (SSE streaming) ────────────────────────────────
  llm: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: 300,
    // Temperature kept low for sales consistency
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
      modelId: 'eleven_turbo_v2_5',
      // ADR-002: ulaw_8000 — no FFmpeg on hot path
      outputFormat: 'ulaw_8000',
      wsUrl: 'wss://api.elevenlabs.io/v1/text-to-speech',
      // Optimise for low latency
      optimizeStreamingLatency: 4,  // max optimisation
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: true,
    },
  },

  // ── SpeakableTextChunker ──────────────────────────────────
  chunker: {
    // Minimum chars before we flush a chunk to TTS
    minChunkChars: 12,
    // Sentence-ending punctuation triggers a flush
    sentenceEnders: /[.!?;:]\s/,
    // Comma/dash triggers flush only if buffer > this
    softBreakMinChars: 30,
    softBreakers: /[,\-–—]\s/,
  },

  // ── Metrics ───────────────────────────────────────────────
  metrics: {
    enabled: true,
    // Log full metric snapshots to console
    verbose: process.env.METRICS_VERBOSE === 'true',
  },
};

module.exports = config;
