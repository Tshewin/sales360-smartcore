/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2 (revised)
 *
 * Fixes:
 * 1. Opening line delayed 1s after stream start to ensure streamSid is ready
 * 2. Barge-in suppressed during opening line delivery
 * 3. _agentSpeaking only set true when first audio chunk actually sends
 */

'use strict';

const { EventEmitter } = require('events');
const DeepgramSTT          = require('./DeepgramSTT');
const ElevenLabsWS         = require('./ElevenLabsWS');
const SpeakableTextChunker = require('./SpeakableTextChunker');
const GenerationContext    = require('./GenerationContext');
const RealtimeMetrics      = require('./RealtimeMetrics');
const config               = require('./config');

class RealtimePipeline extends EventEmitter {
  constructor(opts) {
    super();
    this.callSid        = opts.callSid || 'unknown';
    this.systemPrompt   = opts.systemPrompt || '';
    this.openingLine    = opts.openingLine || '';
    this._audio         = opts.audioPipeline || null;

    this._stt             = null;
    this._currentCtx      = null;
    this._metrics         = new RealtimeMetrics(this.callSid);
    this._history         = [];
    this._turnCount       = 0;
    this._agentSpeaking   = false;
    this._openingDone     = false;  // suppress barge-in until opening is delivered
    this._ready           = false;
    this._apiKey          = process.env.ANTHROPIC_API_KEY || '';
  }

  // ─── Lifecycle ───────────────────────────────────────────

  async start() {
    console.log('[Pipeline] Starting CallSid=' + this.callSid);

    this._stt = new DeepgramSTT();
    this._stt.on('interim',      function(r) { this._onInterim(r); }.bind(this));
    this._stt.on('final',        function(r) { this._onFinal(r); }.bind(this));
    this._stt.on('utteranceEnd', function()  { this._onUtteranceEnd(); }.bind(this));
    this._stt.on('error',        function(e) { this.emit('error', Object.assign({}, e, { context: 'stt' })); }.bind(this));

    await this._stt.connect();
    this._ready = true;
    console.log('[Pipeline] STT connected CallSid=' + this.callSid);

    // Delay opening line by 1 second to ensure stream is fully ready
    if (this.openingLine) {
      var self = this;
      setTimeout(function() {
        self._speakText(self.openingLine);
      }, 1000);
    } else {
      this._openingDone = true;
    }
  }

  receiveAudio(audioChunk) {
    if (!this._ready || !this._stt) return;

    // Only allow barge-in after opening line is fully delivered
    if (this._agentSpeaking && this._openingDone && this._currentCtx && !this._currentCtx.aborted) {
      this._handleBargeIn();
    }

    this._stt.sendAudio(audioChunk);
  }

  async stop() {
    this._ready = false;
    if (this._currentCtx) this._currentCtx.abort('call-end');
    if (this._stt) {
      await this._stt.endAudio();
      await this._stt.close();
    }
    var summary = this._metrics.summary();
    if (summary) console.log('[Pipeline] Metrics:', JSON.stringify(summary));
  }

  // ─── STT handlers ────────────────────────────────────────

  _onInterim(data) {
    if (!this._metrics.currentTurn) {
      this._metrics.startTurn();
      this._metrics.mark('t1');
    }
    this.emit('turn:transcript', { callSid: this.callSid, text: data.text, isFinal: false });
  }

  _onFinal(data) {
    if (!data.text.trim()) return;
    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: data.text });
    this.emit('turn:transcript', { callSid: this.callSid, text: data.text, isFinal: true });
    this._respond(data.text);
  }

  _onUtteranceEnd() {
    if (this._stt) this._stt.sendAudio(Buffer.alloc(0));
  }

  // ─── LLM → TTS pipeline ──────────────────────────────────

  async _respond(userText) {
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    this._currentCtx = new GenerationContext(turnId);
    this.emit('turn:start', { turnId: turnId, callSid: this.callSid });

    this._history.push({ role: 'user', content: userText });
    if (this._history.length > 20) this._history = this._history.slice(-20);

    var tts      = new ElevenLabsWS(this._currentCtx);
    var chunker  = new SpeakableTextChunker(this._currentCtx);
    var fullResponse = '';
    var self = this;

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
        self._agentSpeaking = true;
      }
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      self._agentSpeaking = false;
      self._metrics.mark('t9');
      var turnMetrics = self._metrics.endTurn();
      self._currentCtx.complete();
      self.emit('turn:end', { turnId: turnId, callSid: self.callSid, metrics: turnMetrics });
    });

    tts.on('error', function(e) {
      console.error('[Pipeline] TTS error:', e.error && e.error.message);
      self.emit('error', Object.assign({}, e, { context: 'tts', turnId: turnId }));
    });

    try {
      await tts.connect();
      this._metrics.mark('t3');
    } catch (err) {
      console.error('[Pipeline] TTS connect failed:', err.message);
      this.emit('error', { error: err, context: 'tts-connect', turnId: turnId });
      return;
    }

    try {
      var signal = this._currentCtx.signal;

      var response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: signal,
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

      var reader    = response.body.getReader();
      var decoder   = new TextDecoder();
      var buffer    = '';
      var firstToken = true;

      while (true) {
        if (this._currentCtx.aborted) break;
        var result = await reader.read();
        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });
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
              var token = evt.delta.text;
              if (firstToken) {
                firstToken = false;
                this._metrics.mark('t4');
              }
              fullResponse += token;
              chunker.write(token);
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
        console.log('[Pipeline] Claude aborted (barge-in) turn=' + turnId);
      } else {
        console.error('[Pipeline] Claude error:', err.message);
        this.emit('error', { error: err, context: 'llm', turnId: turnId });
      }
    }
  }

  // ─── Opening line ─────────────────────────────────────────

  async _speakText(text) {
    var self = this;
    var ctx  = new GenerationContext(this.callSid + '-opening');
    var tts  = new ElevenLabsWS(ctx);
    var audioSent = false;

    tts.on('audio', function(data) {
      if (self._audio) {
        self._audio.sendOutbound(data.chunk);
        if (!audioSent) {
          audioSent = true;
          self._agentSpeaking = true;
          console.log('[Pipeline] Opening line audio flowing CallSid=' + self.callSid);
        }
      }
    });

    tts.on('done', function() {
      self._agentSpeaking = false;
      self._openingDone   = true;   // NOW allow barge-in
      ctx.complete();
      console.log('[Pipeline] Opening line delivered CallSid=' + self.callSid);
      // Add to history so Claude has context
      self._history.push({ role: 'assistant', content: text });
    });

    tts.on('error', function(e) {
      self._openingDone = true;  // unblock even on error
      console.error('[Pipeline] Opening TTS error:', e.error && e.error.message);
    });

    try {
      await tts.connect();
      tts.send(text);
      tts.flush();
      console.log('[Pipeline] Opening line sent to TTS CallSid=' + this.callSid);
    } catch (err) {
      this._openingDone = true;  // unblock on connect failure
      console.error('[Pipeline] Opening line connect failed:', err.message);
    }
  }

  // ─── Barge-in ─────────────────────────────────────────────

  _handleBargeIn() {
    console.log('[Pipeline] Barge-in CallSid=' + this.callSid);
    this._agentSpeaking = false;
    if (this._audio) this._audio.clearOutbound();
    this._currentCtx.abort('barge-in');
    this.emit('barge-in', { callSid: this.callSid });
  }

  // ─── Accessors ────────────────────────────────────────────

  get metrics()   { return this._metrics; }
  get history()   { return this._history; }
  get turnCount() { return this._turnCount; }
  get isReady()   { return this._ready; }
}

module.exports = RealtimePipeline;
