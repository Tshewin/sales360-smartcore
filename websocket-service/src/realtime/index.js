/**
 * Sales360 Realtime Streaming Module
 * ADR-002 — Week 2
 */

'use strict';

const RealtimePipeline     = require('./RealtimePipeline');
const MediaStreamHandler   = require('./MediaStreamHandler');
const AudioPipeline        = require('./AudioPipeline');
const SpeakableTextChunker = require('./SpeakableTextChunker');
const GenerationContext    = require('./GenerationContext');
const STTAdapter           = require('./STTAdapter');
const DeepgramSTT          = require('./DeepgramSTT');
const ElevenLabsWS         = require('./ElevenLabsWS');
const RealtimeMetrics      = require('./RealtimeMetrics');
const config               = require('./config');
const { attachMediaStreamRoutes, activeSessions } = require('./media-stream-routes');

module.exports = {
  RealtimePipeline,
  MediaStreamHandler,
  AudioPipeline,
  SpeakableTextChunker,
  GenerationContext,
  STTAdapter,
  DeepgramSTT,
  ElevenLabsWS,
  RealtimeMetrics,
  config,
  attachMediaStreamRoutes,
  activeSessions,
};
