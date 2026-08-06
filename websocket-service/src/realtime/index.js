/**
 * Sales360 Realtime Streaming Module
 * ADR-002 — Week 1
 *
 * Entry point. Exports all realtime components.
 * The live polling system (twilio-service.js, call-routes.js) is
 * completely untouched — this is an additive parallel module.
 */

'use strict';

const MediaStreamHandler = require('./MediaStreamHandler');
const AudioPipeline = require('./AudioPipeline');
const SpeakableTextChunker = require('./SpeakableTextChunker');
const GenerationContext = require('./GenerationContext');
const STTAdapter = require('./STTAdapter');
const DeepgramSTT = require('./DeepgramSTT');
const ElevenLabsWS = require('./ElevenLabsWS');
const RealtimeMetrics = require('./RealtimeMetrics');
const config = require('./config');

module.exports = {
  MediaStreamHandler,
  AudioPipeline,
  SpeakableTextChunker,
  GenerationContext,
  STTAdapter,
  DeepgramSTT,
  ElevenLabsWS,
  RealtimeMetrics,
  config,
};
