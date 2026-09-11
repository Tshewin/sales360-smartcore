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
const ElevenLabsWS     = require('./ElevenLabsWS');
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

  // Patch B/F: reopen a committed turn for continuation
  // Called when SpeechStarted arrives during GENERATING — prospect wasn't done
  reopenForContinuation() {
    this.committed    = false;
    this.speechActive = true;
    this._cancelPendingCommit();
    console.log('[TurnController] Reopened for continuation, buffered: "' + this._getUtterance() + '"');
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
    this._ready           = false;
    this._apiKey          = process.env.ANTHROPIC_API_KEY || '';
    this._keepAliveTimer  = null;
    this._turnController  = null;

    // Patch B: explicit state machine
    // OPENING -> LISTENING -> COMMIT_PENDING -> GENERATING -> PLAYING -> LISTENING
    // STOPPED is terminal
    this._phase           = 'OPENING';
    this._pendingUtterance = null;   // Patch F: preserve caller continuations
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
      // Patch B: only process speech in LISTENING or COMMIT_PENDING
      if (self._phase === 'OPENING' || self._phase === 'STOPPED') return;
      if (self._phase === 'LISTENING' || self._phase === 'COMMIT_PENDING') {
        self._turnController.onTranscript({ text: r.text, isFinal: false, speechFinal: false });
        if (!self._metrics.currentTurn) {
          self._metrics.startTurn();
          self._metrics.mark('t1');
        }
        self.emit('turn:transcript', { callSid: self.callSid, text: r.text, isFinal: false });
      }
    });

    this._stt.on('final', function(r) {
      // Patch B: only accumulate finals in LISTENING or COMMIT_PENDING
      if (self._phase === 'OPENING' || self._phase === 'STOPPED') {
        console.log('[Pipeline] Ignoring transcript in phase ' + self._phase + ': "' + r.text + '"');
        return;
      }
      if (self._phase === 'LISTENING' || self._phase === 'COMMIT_PENDING') {
        console.log('[Pipeline] Transcript segment: "' + r.text + '" speechFinal=' + r.speechFinal);
        self._turnController.onTranscript({ text: r.text, isFinal: true, speechFinal: r.speechFinal });
      }
      // GENERATING/PLAYING: handled by speechStarted below
    });

    this._stt.on('speechStarted', function() {
      // Patch B: phase-aware SpeechStarted handling
      switch (self._phase) {
        case 'LISTENING':
        case 'COMMIT_PENDING':
          // Normal: prospect speaking, cancel any pending commit
          console.log('[Pipeline] SpeechStarted phase=' + self._phase + ' — cancelling pending commit');
          self._turnController.onSpeechStarted();
          break;
        case 'GENERATING':
          // Prospect resumed during Claude generation = continuation after premature endpoint
          // Abort generation, reopen the committed utterance, return to LISTENING
          console.log('[Pipeline] SpeechStarted during GENERATING — caller continuation, aborting response');
          self._abortGeneration('caller-continuation');
          self._turnController.reopenForContinuation();
          self._phase = 'LISTENING';
          break;
        case 'PLAYING':
          // Prospect speaking while agent audio plays = genuine barge-in
          console.log('[Pipeline] SpeechStarted during PLAYING — barge-in, clearing audio');
          if (self._audio) self._audio.clearOutbound();
          self._abortGeneration('barge-in');
          self._metrics.annotate({ bargedIn: true });
          self._phase = 'LISTENING';
          break;
        default:
          break;
      }
    });

    this._stt.on('utteranceEnd', function() {
      if (self._phase !== 'LISTENING' && self._phase !== 'COMMIT_PENDING') return;
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
      // Phase stays OPENING until opening TTS done fires -> LISTENING
    } else {
      this._phase = 'LISTENING';  // Patch B: no opening line, go straight to listening
    }
  }

  _onTurnComplete(utterance) {
    // Patch B: only process committed turns from LISTENING/COMMIT_PENDING
    if (this._phase !== 'LISTENING' && this._phase !== 'COMMIT_PENDING') {
      console.log('[Pipeline] Turn committed but phase=' + this._phase + ' — storing as pending: "' + utterance + '"');
      this._pendingUtterance = utterance;
      return;
    }
    if (this._audio) {
      this._audio.clearOutbound();
      console.log('[Pipeline] Outbound buffer cleared — turn complete');
    }
    this._phase = 'COMMIT_PENDING';
    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: utterance });
    this.emit('turn:transcript', { callSid: this.callSid, text: utterance, isFinal: true });
    console.log('[Pipeline] Sending to Claude: "' + utterance + '"');
    this._respond(utterance);
  }

  _startKeepalive() {
    var self = this;
    this._keepAliveTimer = setInterval(function() {
      // Patch B: only send keepalive when LISTENING (not GENERATING/PLAYING)
      if (self._audio && self._phase === 'LISTENING') {
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
    this._phase = 'STOPPED';  // Patch B
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

  // Patch B: abort current generation cleanly
  _abortGeneration(reason) {
    if (this._currentCtx && !this._currentCtx.aborted) {
      this._currentCtx.abort(reason);
    }
    this._currentCtx = null;
    console.log('[Pipeline] Generation aborted: ' + reason);
  }

  async _respond(userText) {
    // Patch B: transition to GENERATING
    this._phase = 'GENERATING';
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    var turnId = this.callSid + '-t' + this._turnCount;
    var self   = this;
    this._currentCtx = new GenerationContext(turnId);

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
        }
      }
      this._phase = 'LISTENING';  // Patch B: restore phase on error
      return;
    }

    if (!fullResponse.trim() || this._currentCtx.aborted) {
      this._phase = 'LISTENING';  // Patch B: restore phase if aborted/empty
      return;
    }

    var cleanResponse = cleanForTTS(fullResponse);
    console.log('[Pipeline] Claude response: "' + cleanResponse + '"');

    if (!this._currentCtx.aborted) {
      this._history.push({ role: 'assistant', content: cleanResponse });
    }

    // Classify what kind of response to expect next
    var expectedShape = classifyExpectedResponse(cleanResponse);
    this._turnController.setExpectedResponseShape(expectedShape);
    this._turnController.reset();

    this.emit('turn:response', { turnId: turnId, callSid: this.callSid, text: cleanResponse });
    // Patch B: transition GENERATING -> PLAYING happens in _speakText
    this._speakText(cleanResponse, false);
  }

  async _speakText(text, isOpening) {
    var self    = this;
    var turnNum = this._turnCount;
    // Patch B: opening uses OPENING phase, responses transition GENERATING->PLAYING
    if (!isOpening) {
      this._phase = 'GENERATING';  // ensure phase is set before TTS starts
    }
    var ctx = new GenerationContext(this.callSid + (isOpening ? '-opening' : '-turn-' + turnNum));
    var tts = new ElevenLabsWS(ctx);

    tts.on('audio', function(data) {
      if (data.index === 0) {
        // Patch B: transition to PLAYING when first audio flows
        self._phase = 'PLAYING';
        console.log('[Pipeline] Audio flowing — ' + (isOpening ? 'opening' : 'turn ' + turnNum));
      }
      if (self._audio) self._audio.sendOutbound(data.chunk);
    });

    tts.on('done', function() {
      ctx.complete();
      // Patch B: transition PLAYING -> LISTENING when TTS done
      self._phase = 'LISTENING';
      if (isOpening) {
        self._phase = 'LISTENING';  // Patch B: opening complete, now listen
        self._history.push({ role: 'assistant', content: text });
        console.log('[Pipeline] Opening delivered — phase=LISTENING');
      } else {
        var m = self._metrics.endTurn();
        console.log('[Pipeline] Turn complete — phase=LISTENING turn=' + turnNum);
        self.emit('turn:end', { callSid: self.callSid, metrics: m });
        // Patch F: if caller continued during GENERATING, process now
        if (self._pendingUtterance) {
          var pending = self._pendingUtterance;
          self._pendingUtterance = null;
          console.log('[Pipeline] Processing pending utterance: "' + pending + '"');
          self._onTurnComplete(pending);
        }
      }
    });

    tts.on('error', function(e) {
      // Patch B: restore LISTENING on TTS error
      self._phase = 'LISTENING';
      if (isOpening) self._history.push({ role: 'assistant', content: '' });
      console.error('[Pipeline] TTS error:', e.error && e.error.message);
    });

    try {
      await tts.connect();
      tts.send(text);
      tts.flush();
      console.log('[Pipeline] Sent to TTS: "' + text + '"');
    } catch (err) {
      self._phase = 'LISTENING';  // Patch B: restore on connect failure
      if (isOpening) self._history.push({ role: 'assistant', content: '' });
      console.error('[Pipeline] TTS connect failed:', err.message);
    }
  }

  get metrics()   { return this._metrics; }
  get history()   { return this._history; }
  get turnCount() { return this._turnCount; }
  get isReady()   { return this._ready; }
}

module.exports = RealtimePipeline;
