/**
 * Sales360 Realtime Streaming — MediaStreamHandler
 * ADR-002 Week 1
 *
 * The main orchestrator for a single Twilio Media Stream session.
 * Handles the WebSocket lifecycle and delegates to:
 *   - AudioPipeline    (μ-law encode/decode)
 *   - DeepgramSTT      (speech → text)
 *   - RealtimeMetrics   (t0–t10 timestamps)
 *   - GenerationContext (barge-in abort)
 *
 * Week 1 scope: echo test mode.
 * The LLM + TTS pipeline will be wired in Week 2.
 *
 * Twilio Media Stream protocol:
 *   Inbound events: connected, start, media, stop, mark
 *   Outbound events: media, clear, mark
 */

'use strict';

const { EventEmitter } = require('events');
const AudioPipeline = require('./AudioPipeline');
const RealtimeMetrics = require('./RealtimeMetrics');
const GenerationContext = require('./GenerationContext');
const config = require('./config');

class MediaStreamHandler extends EventEmitter {
  /**
   * @param {WebSocket} ws — The upgraded Twilio WebSocket
   * @param {object} opts
   * @param {string} opts.callSid — Twilio CallSid
   * @param {boolean} opts.echoMode — If true, echo inbound audio back (test mode)
   */
  constructor(ws, opts = {}) {
    super();
    this._ws = ws;
    this._callSid = opts.callSid || 'unknown';
    this._echoMode = opts.echoMode || false;

    this._streamSid = null;
    this._pipeline = null;
    this._metrics = new RealtimeMetrics(this._callSid);
    this._currentCtx = null;
    this._turnCount = 0;

    // Inbound audio buffer for echo mode
    this._echoBuffer = [];

    this._setupWebSocket();
  }

  /**
   * Wire up Twilio WebSocket event handlers.
   */
  _setupWebSocket() {
    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleTwilioEvent(msg);
      } catch (err) {
        console.error(`[MediaStream] Parse error CallSid=${this._callSid}:`, err.message);
      }
    });

    this._ws.on('close', (code, reason) => {
      console.log(`[MediaStream] Closed CallSid=${this._callSid} code=${code}`);
      this._cleanup();
      this.emit('close', { callSid: this._callSid, code });
    });

    this._ws.on('error', (err) => {
      console.error(`[MediaStream] Error CallSid=${this._callSid}:`, err.message);
      this.emit('error', { callSid: this._callSid, error: err });
    });
  }

  /**
   * Route Twilio Media Stream events.
   */
  _handleTwilioEvent(msg) {
    switch (msg.event) {
      case 'connected':
        console.log(`[MediaStream] Connected CallSid=${this._callSid}`);
        this.emit('connected', { callSid: this._callSid });
        break;

      case 'start':
        this._streamSid = msg.start.streamSid;
        this._pipeline = new AudioPipeline(this._ws, this._streamSid);
        console.log(`[MediaStream] Stream started sid=${this._streamSid} CallSid=${this._callSid}`);
        this.emit('streamStart', {
          callSid: this._callSid,
          streamSid: this._streamSid,
          tracks: msg.start.tracks,
          mediaFormat: msg.start.mediaFormat,
        });
        break;

      case 'media':
        this._handleMedia(msg);
        break;

      case 'mark':
        this.emit('mark', { name: msg.mark?.name, callSid: this._callSid });
        break;

      case 'stop':
        console.log(`[MediaStream] Stream stopped CallSid=${this._callSid}`);
        this._cleanup();
        this.emit('streamStop', { callSid: this._callSid });
        break;

      default:
        // Unknown event — ignore
        break;
    }
  }

  /**
   * Handle inbound audio from the caller.
   */
  _handleMedia(msg) {
    if (!this._pipeline) return;

    const audioBuffer = this._pipeline.decodeInbound(msg.media);

    // ── Echo mode: buffer and return audio ──
    if (this._echoMode) {
      // Immediately send the audio back to the caller
      this._pipeline.sendOutbound(audioBuffer);
      return;
    }

    // ── Production mode (Week 2+): forward to STT ──
    // TODO: Forward audioBuffer to STT adapter
    // this._stt.sendAudio(audioBuffer);
    this.emit('audio', { callSid: this._callSid, chunk: audioBuffer });
  }

  /**
   * Create a new GenerationContext for the next turn.
   * Aborts any in-flight context (barge-in).
   */
  newTurn() {
    // Abort previous turn if still active
    if (this._currentCtx) {
      this._currentCtx.abort('new-turn');
    }

    this._turnCount++;
    const turnId = `${this._callSid}-turn-${this._turnCount}`;
    this._currentCtx = new GenerationContext(turnId);
    this._metrics.startTurn();

    // On barge-in, clear Twilio's outbound audio buffer
    this._currentCtx.on('abort', () => {
      if (this._pipeline) {
        this._pipeline.clearOutbound();
      }
    });

    return this._currentCtx;
  }

  /**
   * Send audio to the caller (from TTS).
   * @param {Buffer} audioChunk — μ-law audio
   */
  sendAudio(audioChunk) {
    if (this._pipeline) {
      this._pipeline.sendOutbound(audioChunk);
    }
  }

  /**
   * Clear outbound audio (barge-in).
   */
  clearAudio() {
    if (this._pipeline) {
      this._pipeline.clearOutbound();
    }
  }

  /**
   * Clean up on connection close.
   */
  _cleanup() {
    if (this._currentCtx) {
      this._currentCtx.abort('session-end');
      this._currentCtx = null;
    }

    // Log final metrics
    const summary = this._metrics.summary();
    if (summary) {
      console.log(`[MediaStream] Metrics summary CallSid=${this._callSid}:`, JSON.stringify(summary));
    }
  }

  // ── Accessors ──

  get callSid() { return this._callSid; }
  get streamSid() { return this._streamSid; }
  get metrics() { return this._metrics; }
  get currentContext() { return this._currentCtx; }
  get turnCount() { return this._turnCount; }
}

module.exports = MediaStreamHandler;
