/**
 * Sales360 Realtime Streaming — MediaStreamHandler
 * ADR-002 Week 2 (revised — opening line fires after stream start confirmed)
 */

'use strict';

const { EventEmitter } = require('events');
const AudioPipeline    = require('./AudioPipeline');
const RealtimeMetrics  = require('./RealtimeMetrics');
const RealtimePipeline = require('./RealtimePipeline');

class MediaStreamHandler extends EventEmitter {
  constructor(ws, opts) {
    super();
    opts = opts || {};
    this._ws           = ws;
    this._callSid      = opts.callSid || 'unknown';
    this._echoMode     = opts.echoMode !== undefined ? opts.echoMode : false;
    this._systemPrompt = opts.systemPrompt || '';
    this._openingLine  = opts.openingLine || '';

    this._streamSid  = null;
    this._pipeline   = null;
    this._rtPipeline = null;
    this._metrics    = new RealtimeMetrics(this._callSid);
    this._turnCount  = 0;

    this._setupWebSocket();
  }

  _setupWebSocket() {
    var self = this;

    this._ws.on('message', function(raw) {
      try {
        var msg = JSON.parse(raw.toString());
        self._handleTwilioEvent(msg);
      } catch (err) {
        console.error('[MediaStream] Parse error CallSid=' + self._callSid + ':', err.message);
      }
    });

    this._ws.on('close', function(code) {
      console.log('[MediaStream] Closed CallSid=' + self._callSid + ' code=' + code);
      self._cleanup();
      self.emit('close', { callSid: self._callSid, code: code });
    });

    this._ws.on('error', function(err) {
      console.error('[MediaStream] Error CallSid=' + self._callSid + ':', err.message);
      self.emit('error', { callSid: self._callSid, error: err });
    });
  }

  _handleTwilioEvent(msg) {
    var self = this;

    switch (msg.event) {
      case 'connected':
        console.log('[MediaStream] Connected CallSid=' + this._callSid);
        this.emit('connected', { callSid: this._callSid });
        break;

      case 'start':
        this._streamSid = msg.start && msg.start.streamSid;
        this._pipeline  = new AudioPipeline(this._ws, this._streamSid);

        console.log('[MediaStream] Stream started sid=' + this._streamSid);
        this.emit('streamStart', {
          callSid:     this._callSid,
          streamSid:   this._streamSid,
          tracks:      msg.start && msg.start.tracks,
          mediaFormat: msg.start && msg.start.mediaFormat,
        });

        // ── Start pipeline ONLY after stream is confirmed ready ──
        if (!this._echoMode) {
          this._startRealtimePipeline();
        }
        break;

      case 'media':
        this._handleMedia(msg);
        break;

      case 'mark':
        this.emit('mark', { name: msg.mark && msg.mark.name, callSid: this._callSid });
        break;

      case 'stop':
        console.log('[MediaStream] Stream stopped CallSid=' + this._callSid);
        this._cleanup();
        this.emit('streamStop', { callSid: this._callSid });
        break;
    }
  }

  _handleMedia(msg) {
    if (!this._pipeline) return;
    var audioBuffer = this._pipeline.decodeInbound(msg.media);

    if (this._echoMode) {
      this._pipeline.sendOutbound(audioBuffer);
      return;
    }

    if (this._rtPipeline) {
      this._rtPipeline.receiveAudio(audioBuffer);
    }
  }

  async _startRealtimePipeline() {
    var self = this;
    try {
      this._rtPipeline = new RealtimePipeline({
        callSid:       this._callSid,
        systemPrompt:  this._systemPrompt,
        openingLine:   this._openingLine,
        audioPipeline: this._pipeline,   // pipeline has streamSid set — guaranteed
      });

      this._rtPipeline.on('turn:transcript', function(e) { self.emit('transcript', e); });
      this._rtPipeline.on('turn:response',   function(e) { self.emit('response', e); });
      this._rtPipeline.on('turn:start',      function(e) { self._turnCount++; self.emit('turnStart', e); });
      this._rtPipeline.on('turn:end',        function(e) { self.emit('turnEnd', e); });
      this._rtPipeline.on('barge-in',        function(e) { self.emit('bargeIn', e); });
      this._rtPipeline.on('error',           function(e) { self.emit('error', e); });

      await this._rtPipeline.start();
      console.log('[MediaStream] Realtime pipeline started CallSid=' + this._callSid);

    } catch (err) {
      console.error('[MediaStream] Pipeline start failed CallSid=' + this._callSid + ':', err.message);
      this.emit('error', { error: err, context: 'pipeline-start' });
    }
  }

  async _cleanup() {
    if (this._rtPipeline) {
      await this._rtPipeline.stop();
      this._rtPipeline = null;
    }
    var summary = this._metrics.summary();
    if (summary) {
      console.log('[MediaStream] Metrics CallSid=' + this._callSid + ':', JSON.stringify(summary));
    }
  }

  get callSid()   { return this._callSid; }
  get streamSid() { return this._streamSid; }
  get metrics()   { return this._metrics; }
  get turnCount() { return this._turnCount; }
}

module.exports = MediaStreamHandler;
