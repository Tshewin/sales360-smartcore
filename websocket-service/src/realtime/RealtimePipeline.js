/**
 * Sales360 Realtime Streaming — RealtimePipeline
 * ADR-002 Week 2
 *
 * Full pipeline: Twilio μ-law → Deepgram STT → Claude SSE
 *                → SpeakableTextChunker → ElevenLabs WS (ulaw_8000)
 *                → Twilio μ-law
 *
 * Uses raw fetch + SSE (consistent with twilio-service.js — no new deps).
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
  /**
   * @param {object} opts
   * @param {string} opts.callSid
   * @param {string} opts.systemPrompt
   * @param {string} opts.openingLine
   * @param {import('./AudioPipeline')} opts.audioPipeline
   */
  constructor(opts = {}) {
    super();
    this.callSid        = opts.callSid || 'unknown';
    this.systemPrompt   = opts.systemPrompt || '';
    this.openingLine    = opts.openingLine || '';
    this._audio         = opts.audioPipeline || null;

    this._stt           = null;
    this._currentCtx    = null;
    this._metrics       = new RealtimeMetrics(this.callSid);
    this._history       = [];
    this._turnCount     = 0;
    this._agentSpeaking = false;
    this._ready         = false;
    this._apiKey        = process.env.ANTHROPIC_API_KEY || '';
  }

  // ─── Lifecycle ───────────────────────────────────────────

  async start() {
    console.log(`[Pipeline] Starting CallSid=${this.callSid}`);

    this._stt = new DeepgramSTT();
    this._stt.on('interim',      (r) => this._onInterim(r));
    this._stt.on('final',        (r) => this._onFinal(r));
    this._stt.on('utteranceEnd', ()  => this._onUtteranceEnd());
    this._stt.on('error',        (e) => this.emit('error', { ...e, context: 'stt' }));

    await this._stt.connect();
    this._ready = true;
    console.log(`[Pipeline] STT connected CallSid=${this.callSid}`);

    if (this.openingLine) {
      await this._speakText(this.openingLine);
    }
  }

  receiveAudio(audioChunk) {
    if (!this._ready || !this._stt) return;

    // Barge-in: caller speaks while agent is talking
    if (this._agentSpeaking && this._currentCtx && !this._currentCtx.aborted) {
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
    const summary = this._metrics.summary();
    if (summary) console.log(`[Pipeline] Metrics summary:`, JSON.stringify(summary));
  }

  // ─── STT handlers ────────────────────────────────────────

  _onInterim({ text }) {
    if (!this._metrics.currentTurn) {
      this._metrics.startTurn();
      this._metrics.mark('t1');
    }
    this.emit('turn:transcript', { callSid: this.callSid, text, isFinal: false });
  }

  _onFinal({ text }) {
    if (!text.trim()) return;
    this._metrics.mark('t2');
    this._metrics.annotate({ transcript: text });
    this.emit('turn:transcript', { callSid: this.callSid, text, isFinal: true });
    this._respond(text);
  }

  _onUtteranceEnd() {
    // Nudge Deepgram to flush any pending interim
    if (this._stt) this._stt.sendAudio(Buffer.alloc(0));
  }

  // ─── LLM → TTS pipeline ──────────────────────────────────

  async _respond(userText) {
    // Abort any in-flight turn
    if (this._currentCtx) this._currentCtx.abort('new-turn');

    this._turnCount++;
    const turnId = `${this.callSid}-t${this._turnCount}`;
    this._currentCtx = new GenerationContext(turnId);
    this.emit('turn:start', { turnId, callSid: this.callSid });

    // History management
    this._history.push({ role: 'user', content: userText });
    if (this._history.length > 20) this._history = this._history.slice(-20);

    // Set up TTS and chunker for this turn
    const tts     = new ElevenLabsWS(this._currentCtx);
    const chunker  = new SpeakableTextChunker(this._currentCtx);
    let fullResponse = '';
    let firstChunk   = true;

    chunker.on('chunk', ({ text, index }) => {
      if (this._currentCtx.aborted) return;
      if (index === 0) this._metrics.mark('t5');
      tts.send(text);
    });

    chunker.on('done', () => tts.flush());

    tts.on('audio', ({ chunk, index }) => {
      if (this._currentCtx.aborted) return;
      if (index === 0) {
        this._metrics.mark('t7');
        this._metrics.mark('t8');
        this._agentSpeaking = true;
      }
      if (this._audio) this._audio.sendOutbound(chunk);
    });

    tts.on('done', () => {
      this._agentSpeaking = false;
      this._metrics.mark('t9');
      const turnMetrics = this._metrics.endTurn();
      this._currentCtx.complete();
      this.emit('turn:end', { turnId, callSid: this.callSid, metrics: turnMetrics });
    });

    tts.on('error', (e) => {
      console.error(`[Pipeline] TTS error:`, e.error?.message);
      this.emit('error', { ...e, context: 'tts', turnId });
    });

    // Connect TTS
    try {
      await tts.connect();
      this._metrics.mark('t3');
    } catch (err) {
      console.error(`[Pipeline] TTS connect failed:`, err.message);
      this.emit('error', { error: err, context: 'tts-connect', turnId });
      return;
    }

    // Stream Claude SSE
    try {
      const signal = this._currentCtx.signal;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       this._apiKey,
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
        const err = await response.text();
        throw new Error(`Claude API ${response.status}: ${err}`);
      }

      // Parse SSE stream
      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';
      let firstToken = true;

      while (true) {
        if (this._currentCtx.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const token = evt.delta.text;
              if (firstToken) {
                firstToken = false;
                this._metrics.mark('t4');
              }
              fullResponse += token;
              chunker.write(token);
            }
          } catch (_) {}
        }
      }

      if (!this._currentCtx.aborted) {
        chunker.end();
        this._history.push({ role: 'assistant', content: fullResponse });
        this.emit('turn:response', { turnId, callSid: this.callSid, text: fullResponse });
      }

    } catch (err) {
      if (err.name === 'AbortError' || this._currentCtx?.aborted) {
        console.log(`[Pipeline] Claude aborted (barge-in) turn=${turnId}`);
      } else {
        console.error(`[Pipeline] Claude error:`, err.message);
        this.emit('error', { error: err, context: 'llm', turnId });
      }
    }
  }

  // ─── Opening line ─────────────────────────────────────────

  async _speakText(text) {
    const ctx = new GenerationContext(`${this.callSid}-opening`);
    const tts = new ElevenLabsWS(ctx);

    tts.on('audio', ({ chunk }) => {
      if (this._audio) this._audio.sendOutbound(chunk);
      this._agentSpeaking = true;
    });

    tts.on('done', () => {
      this._agentSpeaking = false;
      ctx.complete();
      console.log(`[Pipeline] Opening line delivered CallSid=${this.callSid}`);
    });

    tts.on('error', (e) => console.error(`[Pipeline] Opening TTS error:`, e.error?.message));

    try {
      await tts.connect();
      tts.send(text);
      tts.flush();
      this._history.push({ role: 'assistant', content: text });
    } catch (err) {
      console.error(`[Pipeline] Opening line failed:`, err.message);
    }
  }

  // ─── Barge-in ─────────────────────────────────────────────

  _handleBargeIn() {
    console.log(`[Pipeline] Barge-in CallSid=${this.callSid}`);
    this._agentSpeaking = false;
    if (this._audio) this._audio.clearOutbound();
    this._currentCtx.abort('barge-in');
    this.emit('barge-in', { callSid: this.callSid });
  }

  // ─── Accessors ────────────────────────────────────────────

  get metrics()    { return this._metrics; }
  get history()    { return this._history; }
  get turnCount()  { return this._turnCount; }
  get isReady()    { return this._ready; }
}

module.exports = RealtimePipeline;
