/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2 — v6
 *
 * Fixes from v5:
 * 1. Debounce transcript processing — wait 800ms before sending to Claude
 *    Prevents split sentences from triggering multiple responses
 * 2. Concatenate multiple finals into one complete utterance
 * 3. Fix history corruption on aborted turns
 */

'use strict';

const { EventEmitter } = require('events');
const DeepgramSTT      = require('./DeepgramSTT');
const ElevenLabsWS     = require('./ElevenLabsWS');
const GenerationContext = require('./GenerationContext');
const RealtimeMetrics  = require('./RealtimeMetrics');
const config           = require('./config');

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

    // Debounce state
    this._transcriptBuffer = '';
    this._debounceTimer    = null;
    this._DEBOUNCE_MS      = 800;  // wait 800ms for sentence to complete
  }

  async start() {
    console.log('[Pipeline] Starting CallSid=' + this.callSid);

    var self = this;
    this._stt = new DeepgramSTT();
    this._stt.on('interim',      function(r) { self._onInterim(r); });
    this._stt.on('final',        function(r) { self._onFinal(r); });
    this._stt.on('utteranceEnd', function()  {
      // Flush debounce buffer immediately on utterance end
      self._flushTranscript();
    });
    this._stt.on('error', function(e) {
      self.emit('error', Object.assign({}, e, { context: 'stt' }));
    });

    await this._stt.connect();
    this._ready = true;
    console.log('[Pipeline] STT connected CallSid=' + this.callSid);

    this._startKeepalive();

    if (this.openingLine) {
      this._speakText(this.openingLine, true);
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
    this._stt.sendAudio(audioChunk);
  }

  async stop() {
    this._ready = false;
    this._stopKeepalive();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
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
      console.log('[Pipeline] Ignoring transcript during response: "' + data.text + '"');
      return;
    }

    // Add to buffer — debounce before sending to Claude
    this._transcriptBuffer = (this._transcriptBuffer + ' ' + data.text).trim();
    console.log('[Pipeline] Transcript buffered: "' + this._transcriptBuffer + '"');

    // Reset debounce timer
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    var self = this;
    this._debounceTimer = setTimeout(function() {
      self._flushTranscript();
    }, this._DEBOUNCE_MS);
  }

  _flushTranscript() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    var text = this._transcriptBuffer.trim();
    this._transcriptBuffer = '';

    if (!text || this._agentResponding) return;

    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: text });
    this.emit('turn:transcript', { callSid: this.callSid, text: text, isFinal: true });
    // Clear Twilio outbound buffer ONLY after confirmed real speech
    // Placed here after debounce confirms genuine utterance
    if (this._audio) {
      this._audio.clearOutbound();
      console.log('[Pipeline] Outbound buffer cleared — confirmed speech');
    }

    console.log('[Pipeline] Sending to Claude: "' + text + '"');
    this._respond(text);
  }

  async _respond(userText) {
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    var self   = this;
    this._currentCtx      = new GenerationContext(turnId);
    this._agentResponding = false;

    this.emit('turn:start', { turnId: turnId, callSid: this.callSid });

    // Only add to history if not already there (prevent duplicates on abort)
    var lastEntry = this._history[this._history.length - 1];
    if (!lastEntry || lastEntry.role !== 'user' || lastEntry.content !== userText) {
      this._history.push({ role: 'user', content: userText });
    }
    if (this._history.length > 20) this._history = this._history.slice(-20);

    var fullResponse = '';
    try {
      this._metrics.mark('t3');
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
            }
          } catch(e) {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || (this._currentCtx && this._currentCtx.aborted)) {
        console.log('[Pipeline] Claude aborted turn=' + turnId);
      } else {
        console.error('[Pipeline] Claude error turn=' + turnId + ':', err.message);
      }
      return;
    }

    if (!fullResponse.trim() || this._currentCtx.aborted) return;

    console.log('[Pipeline] Claude response: "' + fullResponse + '"');

    // Only add assistant response if turn wasn't aborted
    if (!this._currentCtx.aborted) {
      this._history.push({ role: 'assistant', content: fullResponse });
    }

    this.emit('turn:response', { turnId: turnId, callSid: this.callSid, text: fullResponse });
    this._speakText(fullResponse, false);
  }

  async _speakText(text, isOpening) {
    var self    = this;
    var turnNum = this._turnCount;
    var ctx     = new GenerationContext(this.callSid + (isOpening ? '-opening' : '-turn-' + turnNum));
    var tts     = new ElevenLabsWS(ctx);

    tts.on('audio', function(data) {
      if (data.index === 0) {
        self._agentResponding = true;
        console.log('[Pipeline] Audio flowing — ' + (isOpening ? 'opening' : 'turn ' + turnNum));
      }
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      self._agentResponding = false;
      ctx.complete();
      if (isOpening) {
        self._openingDone = true;
        self._history.push({ role: 'assistant', content: text });
        console.log('[Pipeline] Opening delivered — listening');
      } else {
        var m = self._metrics.endTurn();
        console.log('[Pipeline] Turn complete — listening turn=' + turnNum);
        self.emit('turn:end', { callSid: self.callSid, metrics: m });
      }
    });

    tts.on('error', function(e) {
      self._agentResponding = false;
      if (isOpening) self._openingDone = true;
      console.error('[Pipeline] TTS error:', e.error && e.error.message);
    });

    try {
      await tts.connect();
      tts.send(text);
      tts.flush();
      console.log('[Pipeline] Sent to TTS: "' + text + '"');
    } catch (err) {
      self._agentResponding = false;
      if (isOpening) self._openingDone = true;
      console.error('[Pipeline] TTS connect failed:', err.message);
    }
  }

  get metrics()   { return this._metrics; }
  get history()   { return this._history; }
  get turnCount() { return this._turnCount; }
  get isReady()   { return this._ready; }
}

module.exports = RealtimePipeline;
