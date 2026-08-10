/**
 * Sales360 Realtime Streaming — MediaStreamHandler
 * ADR-002 Week 2 (updated)
 *
 * Orchestrates a single Twilio Media Stream session.
 * Week 1: echo mode only
 * Week 2: full pipeline (STT → Claude → TTS) when echoMode=false
 */

'use strict';

const { EventEmitter } = require('events');
const AudioPipeline    = require('./AudioPipeline');
const RealtimeMetrics  = require('./RealtimeMetrics');
const GenerationContext = require('./GenerationContext');
const RealtimePipeline  = require('./RealtimePipeline');

class MediaStreamHandler extends EventEmitter {
  /**
   * @param {WebSocket} ws
   * @param {object} opts
   * @param {string} opts.callSid
   * @param {boolean} opts.echoMode      — true = echo test, false = full pipeline
   * @param {string} opts.systemPrompt   — Claude system prompt
   * @param {string} opts.openingLine    — Agent's first words
   */
  constructor(ws, opts = {}) {
    super();
    this._ws           = ws;
    this._callSid      = opts.callSid || 'unknown';
    this._echoMode     = opts.echoMode !== undefined ? opts.echoMode : false;
    this._systemPrompt = opts.systemPrompt || '';
    this._openingLine  = opts.openingLine || '';

    this._streamSid  = null;
    this._pipeline   = null;       // AudioPipeline (μ-law plumbing)
    this._rtPipeline = null;       // RealtimePipeline (STT→LLM→TTS)
    this._metrics    = new RealtimeMetrics(this._callSid);
    this._turnCount  = 0;

    this._setupWebSocket();
  }

  _setupWebSocket() {
    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleTwilioEvent(msg);
      } catch (err) {
        console.error(`[MediaStream] Parse error CallSid=${this._callSid}:`, err.message);
      }
    });

    this._ws.on('close', (code) => {
      console.log(`[MediaStream] Closed CallSid=${this._callSid} code=${code}`);
      this._cleanup();
      this.emit('close', { callSid: this._callSid, code });
    });

    this._ws.on('error', (err) => {
      console.error(`[MediaStream] Error CallSid=${this._callSid}:`, err.message);
      this.emit('error', { callSid: this._callSid, error: err });
    });
  }

  _handleTwilioEvent(msg) {
    switch (msg.event) {
      case 'connected':
        console.log(`[MediaStream] Connected CallSid=${this._callSid}`);
        this.emit('connected', { callSid: this._callSid });
        break;

      case 'start':
        this._streamSid = msg.start?.streamSid;
        this._pipeline  = new AudioPipeline(this._ws, this._streamSid);
        console.log(`[MediaStream] Stream started sid=${this._streamSid}`);

        this.emit('streamStart', {
          callSid:     this._callSid,
          streamSid:   this._streamSid,
          tracks:      msg.start?.tracks,
          mediaFormat: msg.start?.mediaFormat,
        });

        // Start the full pipeline (or echo) now that we have streamSid
        if (!this._echoMode) {
          this._startRealtimePipeline();
        }
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
    }
  }

  _handleMedia(msg) {
    if (!this._pipeline) return;
    const audioBuffer = this._pipeline.decodeInbound(msg.media);

    if (this._echoMode) {
      // Echo straight back — no processing
      this._pipeline.sendOutbound(audioBuffer);
      return;
    }

    // Production: feed into realtime pipeline
    if (this._rtPipeline) {
      this._rtPipeline.receiveAudio(audioBuffer);
    }
  }

  async _startRealtimePipeline() {
    try {
      this._rtPipeline = new RealtimePipeline({
        callSid:       this._callSid,
        systemPrompt:  this._systemPrompt,
        openingLine:   this._openingLine,
        audioPipeline: this._pipeline,
      });

      // Bubble up events
      this._rtPipeline.on('turn:transcript', (e) => this.emit('transcript', e));
      this._rtPipeline.on('turn:response',   (e) => this.emit('response', e));
      this._rtPipeline.on('turn:start',      (e) => { this._turnCount++; this.emit('turnStart', e); });
      this._rtPipeline.on('turn:end',        (e) => this.emit('turnEnd', e));
      this._rtPipeline.on('barge-in',        (e) => this.emit('bargeIn', e));
      this._rtPipeline.on('error',           (e) => this.emit('error', e));

      await this._rtPipeline.start();
      console.log(`[MediaStream] Realtime pipeline started CallSid=${this._callSid}`);
    } catch (err) {
      console.error(`[MediaStream] Pipeline start failed CallSid=${this._callSid}:`, err.message);
      this.emit('error', { error: err, context: 'pipeline-start' });
    }
  }

  async _cleanup() {
    if (this._rtPipeline) {
      await this._rtPipeline.stop();
      this._rtPipeline = null;
    }
    const summary = this._metrics.summary();
    if (summary) {
      console.log(`[MediaStream] Metrics CallSid=${this._callSid}:`, JSON.stringify(summary));
    }
  }

  // Accessors
  get callSid()    { return this._callSid; }
  get streamSid()  { return this._streamSid; }
  get metrics()    { return this._metrics; }
  get turnCount()  { return this._turnCount; }
}

module.exports = MediaStreamHandler;
