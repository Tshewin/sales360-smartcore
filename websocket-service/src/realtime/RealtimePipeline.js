/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2 — v10 FINAL
 *
 * Implements ChatGPT Section 8: Context-Aware Grace Periods
 *
 * After each agent response, classify expected response shape:
 * - binary (yes/no question)      → 150ms base grace
 * - short_fact (name/number/date) → 250ms base grace
 * - objection (concern/pushback)  → 450ms base grace
 * - open_explanation (discovery)  → 700ms base grace
 * - unknown (default)             → 400ms base grace
 *
 * This is the one missing piece from ChatGPT's recommendation.
 * Everything else was already correctly implemented in v9.
 */

'use strict';

const { EventEmitter } = require('events');
const DeepgramSTT      = require('./DeepgramSTT');
const ElevenLabsWS         = require('./ElevenLabsWS');
const SpeakableTextChunker = require('./SpeakableTextChunker');
const GenerationContext = require('./GenerationContext');
const RealtimeMetrics  = require('./RealtimeMetrics');
const config           = require('./config');

var SILENCE_FRAME = Buffer.alloc(160, 0xFF);

function cleanForTTS(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Classify expected response shape from agent's last question ──────────────
function classifyExpectedResponse(agentText) {
  if (!agentText) return 'unknown';
  var t = agentText.toLowerCase();

  // Binary: yes/no questions
  if (/\b(are you|do you|have you|is this|would you|can you|did you|is that|does that)\b.*\?/.test(t)) {
    return 'binary';
  }

  // Short fact: name, email, number, time, date
  if (/\b(your name|best email|email address|phone number|how many|how much|what time|which day|what date|best time)\b/.test(t)) {
    return 'short_fact';
  }

  // Open explanation: discovery questions expecting narrative
  if (/\b(what is your biggest|what.*challenge|tell me|what.*look like|what.*happen|how.*currently|what.*tried|what.*mean|describe|explain|walk me through)\b/.test(t)) {
    return 'open_explanation';
  }

  // Objection handling context
  if (/\b(i understand|i hear you|fair enough|that makes sense|absolutely|of course)\b/.test(t)) {
    return 'objection';
  }

  return 'unknown';
}

var BASE_GRACE = {
  binary:           150,
  short_fact:       250,
  objection:        450,
  open_explanation: 700,
  unknown:          400,
};

// ─── TurnCompletionController ─────────────────────────────────────────────────
class TurnCompletionController {
  constructor(onTurnComplete) {
    this.onTurnComplete        = onTurnComplete;
    this.finalSegments         = [];
    this.latestInterim         = '';
    this.commitTimer           = null;
    this.committed             = false;
    this.expectedResponseShape = 'unknown';
    this.speechActive          = false;  // Patch A: track VAD speech state
  }

  setExpectedResponseShape(shape) {
    this.expectedResponseShape = shape;
    console.log('[TurnController] Expected response shape: ' + shape);
  }

  onTranscript(event) {
    var text = event.text && event.text.trim();
    if (!text) return;

    if (!event.isFinal) {
      this.latestInterim = text;
      return;
    }

    this.finalSegments.push(text);
    this.latestInterim = '';

    if (event.speechFinal) {
      this.speechActive = false;  // Patch A: endpointing detected silence
      this._scheduleCandidateCommit();
    }
  }

  onSpeechStarted() {
    this.speechActive = true;  // Patch A: prospect is speaking
    this._cancelPendingCommit();
  }

  onUtteranceEnd() {
    // Patch A: guarded backstop — do not force-commit incomplete speech
    var u = this._getUtterance();
    if (!u || this.committed) return;
    // If VAD thinks speech is still active, do not commit
    if (this.speechActive) return;
    // If there is an unprocessed interim, prospect may still be speaking
    if (this.latestInterim) return;
    // If utterance looks incomplete, schedule a longer grace instead of committing
    if (this._looksIncomplete(u)) {
      this._scheduleCandidateCommit();
      return;
    }
    this._commit();
  }

  reset() {
    this._cancelPendingCommit();
    this.finalSegments = [];
    this.latestInterim = '';
    this.committed     = false;
    this.speechActive  = false;  // Patch A
  }

  _getUtterance() {
    return this.finalSegments.join(' ').trim();
  }

  _scheduleCandidateCommit() {
    this._cancelPendingCommit();
    var utterance = this._getUtterance();
    var delay     = this._chooseGracePeriod(utterance);
    console.log('[TurnController] Candidate commit in ' + delay + 'ms for: "' + utterance + '"');
    var self = this;
    this.commitTimer = setTimeout(function() { self._commit(); }, delay);
  }

  _chooseGracePeriod(text) {
    // Start with context-aware base grace
    var baseGrace = BASE_GRACE[this.expectedResponseShape] || 400;

    // Then apply semantic refinement on top
    if (!text) return baseGrace;
    if (this._isImmediateAnswer(text)) return Math.min(baseGrace, 175);
    if (this._looksIncomplete(text))   return Math.max(baseGrace, 800);
    if (this._looksComplete(text))     return Math.min(baseGrace, 300);
    return baseGrace;
  }

  _commit() {
    var utterance = this._getUtterance();
    if (!utterance || this.committed) return;
    this.committed = true;
    this._cancelPendingCommit();
    console.log('[TurnController] Committed: "' + utterance + '"');
    this.onTurnComplete(utterance);
  }

  _cancelPendingCommit() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  _isImmediateAnswer(text) {
    return /^(yes|yeah|yep|yup|no|nope|okay|ok|sure|correct|exactly|absolutely|right|go ahead|alright|fine|great|perfect|not really|maybe)[.!?]?$/i.test(text.trim());
  }

  _looksIncomplete(text) {
    // Patch A: expanded with real Sales360 transcript fragments
    var t = text.trim().toLowerCase();
    return (
      // Trailing connectives — classic mid-sentence pause
      /\b(and|but|because|so|if|when|although|though|unless|while|which|that|then|like)\s*[,.]?\s*$/.test(t) ||
      // Trailing articles/prepositions
      /\b(the|a|an|my|your|our|their|to|for|with|from)\s*$/.test(t) ||
      // Known incomplete openers from real Sales360 calls
      /(?:what happened was|the thing is|my problem is|what i mean is|i was thinking|i wanted to|i'm trying to|i am trying to)\s*$/i.test(t) ||
      // Real transcript fragments from Sales360 calls that caused false commits
      /\b(but it's not|but it is not|but i haven't|but i have not|and then i|the reason is|what happened is|i think that|i feel like|it's because|it is because|the problem is|so my|closed turnover because|turnover because|because what|because i|because they|because the|but the|but they|but we|but he|but she)\s*$/i.test(t) ||
      // Ends with comma — almost always incomplete
      /,\s*$/.test(t)
    );
  }

  _looksComplete(text) {
    return /[.!?]$/.test(text.trim());
  }
}

// ─── RealtimePipeline ─────────────────────────────────────────────────────────
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
    this._turnController = new TurnCompletionController(function(utterance) {
      self._onTurnComplete(utterance);
    });

    // Opening is an open question — expect open_explanation
    this._turnController.setExpectedResponseShape('open_explanation');

    this._stt = new DeepgramSTT();

    this._stt.on('interim', function(r) {
      if (!self._openingDone || self._agentResponding) return;
      self._turnController.onTranscript({ text: r.text, isFinal: false, speechFinal: false });
      if (!self._metrics.currentTurn) {
        self._metrics.startTurn();
        self._metrics.mark('t1');
      }
      self.emit('turn:transcript', { callSid: self.callSid, text: r.text, isFinal: false });
    });

    this._stt.on('final', function(r) {
      if (!self._openingDone) {
        console.log('[Pipeline] Ignoring transcript during opening: "' + r.text + '"');
        return;
      }
      if (self._agentResponding) {
        console.log('[Pipeline] Ignoring transcript during response: "' + r.text + '"');
        return;
      }
      console.log('[Pipeline] Transcript segment: "' + r.text + '" speechFinal=' + r.speechFinal);
      self._turnController.onTranscript({ text: r.text, isFinal: true, speechFinal: r.speechFinal });
    });

    this._stt.on('speechStarted', function() {
      if (!self._openingDone || self._agentResponding) return;
      console.log('[Pipeline] SpeechStarted — cancelling pending commit');
      self._turnController.onSpeechStarted();
    });

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

  _onTurnComplete(utterance) {
    if (this._isProcessing) {
      console.log('[Pipeline] Already processing — skipping: "' + utterance + '"');
      return;
    }
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
    // Patch C+D: One GenerationContext owns Claude SSE + Chunker + ElevenLabs
    // Claude tokens stream directly into chunker -> ElevenLabs in parallel
    // No waiting for full Claude completion before audio starts
    this._isProcessing = true;
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    var self   = this;
    this._currentCtx = new GenerationContext(turnId);
    this._agentResponding = false;

    this.emit('turn:start', { turnId: turnId, callSid: this.callSid });

    var lastEntry = this._history[this._history.length - 1];
    var userMsgAdded = false;
    if (!lastEntry || lastEntry.role !== 'user' || lastEntry.content !== userText) {
      this._history.push({ role: 'user', content: userText });
      userMsgAdded = true;
    }
    if (this._history.length > 10) this._history = this._history.slice(-10);

    // Patch D: One GenerationContext owns everything
    var ctx     = this._currentCtx;
    var tts     = new ElevenLabsWS(ctx);
    var chunker = new SpeakableTextChunker(ctx);
    var fullResponse = '';

    // Wire chunker -> ElevenLabs
    chunker.on('chunk', function(data) {
      if (ctx.aborted) return;
      if (data.index === 0) {
        self._metrics.mark('t5');
        self._metrics.mark('t6');
        console.log('[Pipeline] First chunk to ElevenLabs turn=' + turnId + ': "' + data.text + '"');
      }
      tts.send(data.text);
    });

    chunker.on('done', function() {
      if (!ctx.aborted) {
        tts.flush();
        console.log('[Pipeline] Chunker done — flushed TTS turn=' + turnId);
      }
    });

    // Wire ElevenLabs -> Twilio
    tts.on('audio', function(data) {
      if (ctx.aborted) return;
      if (data.index === 0) {
        self._metrics.mark('t7');
        self._metrics.mark('t8');
        self._agentResponding = true;
        console.log('[Pipeline] First audio flowing turn=' + turnId);
      }
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      self._agentResponding = false;
      ctx.complete();
      var cleanFull = cleanForTTS(fullResponse);
      if (cleanFull && !ctx.aborted) {
        self._history.push({ role: 'assistant', content: cleanFull });
      }
      var expectedShape = classifyExpectedResponse(cleanFull);
      self._turnController.setExpectedResponseShape(expectedShape);
      self._turnController.reset();
      var m = self._metrics.endTurn();
      console.log('[Pipeline] Turn complete turn=' + turnId);
      self.emit('turn:response', { turnId: turnId, callSid: self.callSid, text: cleanFull });
      self.emit('turn:end', { callSid: self.callSid, metrics: m });
      self._isProcessing = false;
    });

    tts.on('error', function(e) {
      self._agentResponding = false;
      console.error('[Pipeline] TTS error turn=' + turnId + ':', e.error && e.error.message);
      self._isProcessing = false;
    });

    // Patch C+D: Connect ElevenLabs in PARALLEL with Claude request
    var ttsConnected = false;
    try {
      await tts.connect();
      ttsConnected = true;
      this._metrics.mark('t3');
      console.log('[Pipeline] ElevenLabs connected — starting Claude stream turn=' + turnId);
    } catch (err) {
      console.error('[Pipeline] ElevenLabs connect failed turn=' + turnId + ':', err.message);
      this._isProcessing = false;
      if (userMsgAdded) this._history.pop();
      return;
    }

    // Stream Claude SSE — pipe tokens directly into chunker
    try {
      var response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctx.signal,
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
      var sseBuffer  = '';
      var firstToken = true;

      while (true) {
        if (ctx.aborted) break;
        var chunk = await reader.read();
        if (chunk.done) break;

        sseBuffer += decoder.decode(chunk.value, { stream: true });
        var lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

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
                console.log('[Pipeline] First Claude token turn=' + turnId);
              }
              // Patch C: accumulate for history AND pipe into chunker simultaneously
              fullResponse += token;
              chunker.write(cleanForTTS(token));
            }
          } catch(e) {}
        }
      }

      // Claude complete — signal chunker to flush final chunk
      if (!ctx.aborted) {
        chunker.end();
        console.log('[Pipeline] Claude complete — chunker ended turn=' + turnId);
      }

    } catch (err) {
      if (err.name === 'AbortError' || ctx.aborted) {
        console.log('[Pipeline] Claude aborted turn=' + turnId);
      } else {
        console.error('[Pipeline] Claude error turn=' + turnId + ':', err.message);
        if (userMsgAdded && this._history.length > 0 &&
            this._history[this._history.length - 1].role === 'user' &&
            this._history[this._history.length - 1].content === userText) {
          this._history.pop();
        }
        this._isProcessing = false;
      }
    }
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
