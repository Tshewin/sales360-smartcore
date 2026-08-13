/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2 — v4 DEFINITIVE FIX
 *
 * Root cause of Turn 2+ failure:
 * _onUtteranceEnd() was sending Buffer.alloc(0) to Deepgram.
 * An empty buffer signals CloseStream to Deepgram — killing STT after Turn 1.
 * Fix: Remove the empty buffer send. Deepgram manages its own utterance boundaries.
 */

'use strict';

const { EventEmitter } = require('events');
const DeepgramSTT          = require('./DeepgramSTT');
const ElevenLabsWS         = require('./ElevenLabsWS');
const SpeakableTextChunker = require('./SpeakableTextChunker');
const GenerationContext    = require('./GenerationContext');
const RealtimeMetrics      = require('./RealtimeMetrics');
const config               = require('./config');

var SILENCE_FRAME = Buffer.alloc(160, 0xFF);

class RealtimePipeline extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.callSid        = opts.callSid || 'unknown';
    this.systemPrompt   = opts.systemPrompt || '';
    this.openingLine    = opts.openingLine || '';
    this._audio         = opts.audioPipeline || null;

    this._stt             = null;
    this._currentCtx      = null;
    this._metrics         = new RealtimeMetrics(this.callSid);
    this._history         = [];
    this._turnCount       = 0;
    this._openingDone     = false;
    this._agentResponding = false;
    this._ready           = false;
    this._apiKey          = process.env.ANTHROPIC_API_KEY || '';
    this._keepAliveTimer  = null;
  }

  async start() {
    console.log('[Pipeline] Starting CallSid=' + this.callSid);

    var self = this;
    this._stt = new DeepgramSTT();
    this._stt.on('interim',      function(r) { self._onInterim(r); });
    this._stt.on('final',        function(r) { self._onFinal(r); });
    this._stt.on('utteranceEnd', function()  { self._onUtteranceEnd(); });
    this._stt.on('error',        function(e) { self.emit('error', Object.assign({}, e, { context: 'stt' })); });

    await this._stt.connect();
    this._ready = true;
    console.log('[Pipeline] STT connected CallSid=' + this.callSid);

    this._startKeepalive();

    if (this.openingLine) {
      this._speakOpening(this.openingLine);
    } else {
      this._openingDone = true;
    }
  }

  _startKeepalive() {
    var self = this;
    this._keepAliveTimer = setInterval(function() {
      if (self._audio && !self._agentResponding) {
        self._audio.sendOutbound(SILENCE_FRAME);
      }
    }, 20);
    console.log('[Pipeline] Keepalive started CallSid=' + this.callSid);
  }

  _stopKeepalive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  receiveAudio(audioChunk) {
    if (!this._ready || !this._stt) return;
    // ALWAYS forward audio to Deepgram — never stop the STT stream
    this._stt.sendAudio(audioChunk);
  }

  async stop() {
    this._ready = false;
    this._stopKeepalive();
    if (this._currentCtx) this._currentCtx.abort('call-end');
    if (this._stt) {
      await this._stt.endAudio();
      await this._stt.close();
    }
    var summary = this._metrics.summary();
    if (summary) console.log('[Pipeline] Metrics:', JSON.stringify(summary));
  }

  _onInterim(data) {
    if (this._agentResponding) return;
    if (!this._metrics.currentTurn) {
      this._metrics.startTurn();
      this._metrics.mark('t1');
    }
    this.emit('turn:transcript', { callSid: this.callSid, text: data.text, isFinal: false });
  }

  _onFinal(data) {
    if (!data.text.trim()) return;

    if (!this._openingDone) {
      console.log('[Pipeline] Ignoring transcript during opening: "' + data.text + '"');
      return;
    }

    if (this._agentResponding) {
      console.log('[Pipeline] Ignoring transcript during agent response: "' + data.text + '"');
      return;
    }

    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: data.text });
    this.emit('turn:transcript', { callSid: this.callSid, text: data.text, isFinal: true });
    console.log('[Pipeline] Responding to: "' + data.text + '"');
    this._respond(data.text);
  }

  _onUtteranceEnd() {
    // DO NOTHING — do not send empty buffer to Deepgram.
    // Empty buffer signals CloseStream and kills STT after Turn 1.
    // Deepgram manages utterance boundaries internally via endpointing config.
    console.log('[Pipeline] UtteranceEnd received — Deepgram continues listening');
  }

  async _respond(userText) {
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    var self   = this;
    this._currentCtx      = new GenerationContext(turnId);
    this._agentResponding = false;

    this.emit('turn:start', { turnId: turnId, callSid: this.callSid });

    this._history.push({ role: 'user', content: userText });
    if (this._history.length > 20) this._history = this._history.slice(-20);

    var tts     = new ElevenLabsWS(this._currentCtx);
    var chunker = new SpeakableTextChunker(this._currentCtx);
    var fullResponse = '';

    chunker.on('chunk', function(data) {
      if (self._currentCtx.aborted) return;
      if (data.index === 0) self._metrics.mark('t5');
      tts.send(data.text);
    });

    chunker.on('done', function() { tts.flush(); });

    tts.on('audio', function(data) {
      if (self._currentCtx.aborted) return;
      if (data.index === 0) {
        self._metrics.mark('t7');
        self._metrics.mark('t8');
        self._agentResponding = true;
        console.log('[Pipeline] Agent speaking turn=' + turnId);
      }
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      self._agentResponding = false;
      self._metrics.mark('t9');
      var m = self._metrics.endTurn();
      self._currentCtx.complete();
      console.log('[Pipeline] Turn complete — listening turn=' + turnId);
      self.emit('turn:end', { turnId: turnId, callSid: self.callSid, metrics: m });
    });

    tts.on('error', function(e) {
      self._agentResponding = false;
      console.error('[Pipeline] TTS error:', e.error && e.error.message);
    });

    try {
      await tts.connect();
      this._metrics.mark('t3');
    } catch (err) {
      console.error('[Pipeline] TTS connect failed:', err.message);
      return;
    }

    try {
      var response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: this._currentCtx.signal,
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         this._apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      config.llm.model,
          max_tokens: config.llm.maxTokens,
          stream:     true,
          system:     this.systemPrompt,
          messages:   this._history,
        }),
      });

      if (!response.ok) {
        var errText = await response.text();
        throw new Error('Claude API ' + response.status + ': ' + errText);
      }

      var reader     = response.body.getReader();
      var decoder    = new TextDecoder();
      var buffer     = '';
      var firstToken = true;

      while (true) {
        if (this._currentCtx.aborted) break;
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith('data: ')) continue;
          var data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            var evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
              if (firstToken) { firstToken = false; this._metrics.mark('t4'); }
              fullResponse += evt.delta.text;
              chunker.write(evt.delta.text);
            }
          } catch(e) {}
        }
      }

      if (!this._currentCtx.aborted) {
        chunker.end();
        this._history.push({ role: 'assistant', content: fullResponse });
        this.emit('turn:response', { turnId: turnId, callSid: this.callSid, text: fullResponse });
      }

    } catch (err) {
      if (err.name === 'AbortError' || (this._currentCtx && this._currentCtx.aborted)) {
        console.log('[Pipeline] Claude aborted turn=' + turnId);
      } else {
        console.error('[Pipeline] Claude error:', err.message);
        this.emit('error', { error: err, context: 'llm', turnId: turnId });
      }
    }
  }

  async _speakOpening(text) {
    var self = this;
    var ctx  = new GenerationContext(this.callSid + '-opening');
    var tts  = new ElevenLabsWS(ctx);

    tts.on('audio', function(data) {
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      ctx.complete();
      self._openingDone = true;
      self._history.push({ role: 'assistant', content: text });
      console.log('[Pipeline] Opening line delivered — listening for prospect');
    });

    tts.on('error', function(e) {
      self._openingDone = true;
      console.error('[Pipeline] Opening TTS error:', e.error && e.error.message);
    });

    try {
      await tts.connect();
      tts.send(text);
      tts.flush();
      console.log('[Pipeline] Opening sent to TTS CallSid=' + this.callSid);
    } catch (err) {
      this._openingDone = true;
      console.error('[Pipeline] Opening connect failed:', err.message);
    }
  }

  get metrics()   { return this._metrics; }
  get history()   { return this._history; }
  get turnCount() { return this._turnCount; }
  get isReady()   { return this._ready; }
}

module.exports = RealtimePipeline;
