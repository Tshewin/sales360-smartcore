/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2 — v9 FINAL
 *
 * Implements ChatGPT's recommended TurnCompletionController architecture:
 *
 * is_final      → append to utterance buffer ONLY (never triggers Claude)
 * speech_final  → candidate turn-end → adaptive grace period
 * SpeechStarted → cancel pending commit immediately
 * UtteranceEnd  → safety-net backstop only
 *
 * Adaptive grace periods (ChatGPT recommended):
 * - Short answer (yes/no/okay): 175ms
 * - Clearly complete thought:   250ms
 * - Normal/uncertain:           450ms
 * - Likely incomplete:          800ms
 *
 * Expected latency: 600-950ms for normal turns (vs 800ms+ debounce before)
 * Zero mid-sentence interruptions.
 */

'use strict';

const { EventEmitter } = require('events');
const DeepgramSTT      = require('./DeepgramSTT');
const ElevenLabsWS     = require('./ElevenLabsWS');
const GenerationContext = require('./GenerationContext');
const RealtimeMetrics  = require('./RealtimeMetrics');
const config           = require('./config');

var SILENCE_FRAME = Buffer.alloc(160, 0xFF);

// Strip emojis and non-ASCII from Claude responses before TTS
function cleanForTTS(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── TurnCompletionController ────────────────────────────────────────────────
// Implements ChatGPT's recommended architecture for turn detection.
// Separates transcript assembly (is_final) from turn completion (speech_final).

class TurnCompletionController {
  constructor(onTurnComplete) {
    this.onTurnComplete  = onTurnComplete;
    this.finalSegments   = [];
    this.latestInterim   = '';
    this.commitTimer     = null;
    this.committed       = false;
  }

  // Called on every Deepgram transcript event
  onTranscript(event) {
    const text = event.text && event.text.trim();
    if (!text) return;

    if (!event.isFinal) {
      this.latestInterim = text;
      return;
    }

    // is_final = segment stability only — append to buffer
    this.finalSegments.push(text);
    this.latestInterim = '';

    // speech_final = candidate turn-end (endpointing detected silence gap)
    if (event.speechFinal) {
      this._scheduleCandidateCommit();
    }
  }

  // Called when VAD detects prospect resumed speaking
  // Cancels any pending commit — prospect wasn't done
  onSpeechStarted() {
    this._cancelPendingCommit();
  }

  // Called on UtteranceEnd — backstop only
  onUtteranceEnd() {
    if (!this.committed && this._getUtterance()) {
      this._commit();
    }
  }

  // Reset for next turn
  reset() {
    this._cancelPendingCommit();
    this.finalSegments = [];
    this.latestInterim = '';
    this.committed     = false;
  }

  _getUtterance() {
    return this.finalSegments.join(' ').trim();
  }

  _scheduleCandidateCommit() {
    this._cancelPendingCommit();
    const utterance = this._getUtterance();
    const delay     = this._chooseGracePeriod(utterance);
    this.commitTimer = setTimeout(() => this._commit(), delay);
  }

  _chooseGracePeriod(text) {
    if (!text) return 450;
    if (this._isImmediateAnswer(text)) return 175;
    if (this._looksIncomplete(text))   return 800;
    if (this._looksComplete(text))     return 250;
    return 450;
  }

  _commit() {
    const utterance = this._getUtterance();
    if (!utterance || this.committed) return;
    this.committed = true;
    this._cancelPendingCommit();
    this.onTurnComplete(utterance);
  }

  _cancelPendingCommit() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  _isImmediateAnswer(text) {
    return /^(yes|yeah|yep|yup|no|nope|okay|ok|sure|correct|exactly|absolutely|right|go ahead|alright|fine|great|perfect)[.!?]?$/i.test(text.trim());
  }

  _looksIncomplete(text) {
    const t = text.trim().toLowerCase();
    return (
      /\b(and|but|because|so|if|when|although|though|unless|while|which|that|then|like)\s*[,.]?\s*$/.test(t) ||
      /\b(the|a|an|my|your|our|their|to|for|with|from)\s*$/.test(t) ||
      /(?:what happened was|the thing is|my problem is|what i mean is|i was thinking|i wanted to|i'm trying to)\s*$/i.test(t)
    );
  }

  _looksComplete(text) {
    return /[.!?]$/.test(text.trim());
  }
}

// ─── RealtimePipeline ────────────────────────────────────────────────────────

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
    this._isProcessing    = false;
    this._ready           = false;
    this._apiKey          = process.env.ANTHROPIC_API_KEY || '';
    this._keepAliveTimer  = null;
    this._turnController  = null;
  }

  async start() {
    console.log('[Pipeline] Starting CallSid=' + this.callSid);

    var self = this;

    // Initialise TurnCompletionController
    this._turnController = new TurnCompletionController(function(utterance) {
      self._onTurnComplete(utterance);
    });

    this._stt = new DeepgramSTT();

    // is_final + speech_final → TurnCompletionController
    this._stt.on('interim', function(r) {
      self._turnController.onTranscript({ text: r.text, isFinal: false, speechFinal: false });
      if (!self._agentResponding && !self._metrics.currentTurn) {
        self._metrics.startTurn();
        self._metrics.mark('t1');
      }
      self.emit('turn:transcript', { callSid: self.callSid, text: r.text, isFinal: false });
    });

    this._stt.on('final', function(r) {
      if (!self._openingDone || self._agentResponding) {
        if (!self._openingDone) console.log('[Pipeline] Ignoring transcript during opening: "' + r.text + '"');
        if (self._agentResponding) console.log('[Pipeline] Ignoring transcript during response: "' + r.text + '"');
        return;
      }
      console.log('[Pipeline] Transcript segment: "' + r.text + '" speechFinal=' + r.speechFinal);
      self._turnController.onTranscript({ text: r.text, isFinal: true, speechFinal: r.speechFinal });
    });

    // SpeechStarted → cancel pending commit (prospect still speaking)
    this._stt.on('speechStarted', function() {
      if (!self._openingDone || self._agentResponding) return;
      console.log('[Pipeline] SpeechStarted — cancelling pending commit');
      self._turnController.onSpeechStarted();
    });

    // speech_final already handled inside 'final' event above
    // UtteranceEnd → backstop
    this._stt.on('utteranceEnd', function() {
      if (!self._openingDone || self._agentResponding) return;
      console.log('[Pipeline] UtteranceEnd — backstop check');
      self._turnController.onUtteranceEnd();
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

  // Called by TurnCompletionController when utterance is complete
  _onTurnComplete(utterance) {
    if (this._isProcessing) {
      console.log('[Pipeline] Already processing — skipping: "' + utterance + '"');
      return;
    }

    // Clear Twilio outbound buffer — discard queued audio backlog
    if (this._audio) {
      this._audio.clearOutbound();
      console.log('[Pipeline] Outbound buffer cleared — turn complete');
    }

    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: utterance });
    this.emit('turn:transcript', { callSid: this.callSid, text: utterance, isFinal: true });
    console.log('[Pipeline] Sending to Claude: "' + utterance + '"');
    this._respond(utterance);
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
    if (this._turnController) this._turnController._cancelPendingCommit();
    if (this._currentCtx) this._currentCtx.abort('call-end');
    if (this._stt) {
      await this._stt.endAudio();
      await this._stt.close();
    }
    var summary = this._metrics.summary();
    if (summary) console.log('[Pipeline] Metrics:', JSON.stringify(summary));
  }

  async _respond(userText) {
    this._isProcessing = true;
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    var self   = this;
    this._currentCtx      = new GenerationContext(turnId);
    this._agentResponding = false;

    this.emit('turn:start', { turnId: turnId, callSid: this.callSid });

    var lastEntry = this._history[this._history.length - 1];
    var userMsgAdded = false;
    if (!lastEntry || lastEntry.role !== 'user' || lastEntry.content !== userText) {
      this._history.push({ role: 'user', content: userText });
      userMsgAdded = true;
    }
    if (this._history.length > 10) this._history = this._history.slice(-10);

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
        if (userMsgAdded && this._history.length > 0 &&
            this._history[this._history.length - 1].role === 'user' &&
            this._history[this._history.length - 1].content === userText) {
          this._history.pop();
          console.log('[Pipeline] Removed failed user message from history');
        }
      }
      this._isProcessing = false;
      return;
    }

    if (!fullResponse.trim() || this._currentCtx.aborted) {
      this._isProcessing = false;
      return;
    }

    var cleanResponse = cleanForTTS(fullResponse);
    console.log('[Pipeline] Claude response: "' + cleanResponse + '"');

    if (!this._currentCtx.aborted) {
      this._history.push({ role: 'assistant', content: cleanResponse });
    }

    this.emit('turn:response', { turnId: turnId, callSid: this.callSid, text: cleanResponse });
    this._isProcessing = false;

    // Reset turn controller for next turn
    this._turnController.reset();

    this._speakText(cleanResponse, false);
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
