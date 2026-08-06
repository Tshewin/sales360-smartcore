/**
 * Sales360 Realtime Streaming — Metrics
 * ADR-002 Week 1
 *
 * Tracks every timestamp in the realtime pipeline so we can
 * pinpoint exactly where latency lives.
 *
 * Timeline per turn:
 *   t0  — Twilio delivers first audio packet (caller starts speaking)
 *   t1  — STT emits first interim transcript
 *   t2  — STT emits final transcript (utterance complete)
 *   t3  — Claude request sent
 *   t4  — Claude SSE first token received
 *   t5  — First chunk flushed by SpeakableTextChunker
 *   t6  — ElevenLabs WS receives first chunk
 *   t7  — ElevenLabs WS returns first audio bytes
 *   t8  — First μ-law frame sent to Twilio Media Stream
 *   t9  — Last audio frame sent (turn complete)
 *   t10 — Caller starts speaking again (next turn's t0)
 *
 * Key deltas:
 *   t2–t0  = STT latency (speech → transcript)
 *   t4–t3  = Claude TTFT (time to first token)
 *   t5–t4  = Chunker latency
 *   t7–t6  = ElevenLabs TTFB (text → first audio)
 *   t8–t2  = Pipeline latency (transcript → first audio to caller)
 *   t8–t0  = Total perceived latency (caller stops → hears response)
 */

'use strict';

const config = require('./config');

class RealtimeMetrics {
  constructor(callSid) {
    this.callSid = callSid;
    this.turns = [];
    this._current = null;
  }

  /**
   * Start a new turn. Call this when t0 fires.
   */
  startTurn() {
    if (this._current && !this._current.t9) {
      // Previous turn never completed — mark it
      this._current.incomplete = true;
      this._current.bargedIn = true;
      this.turns.push(this._current);
    }
    this._current = {
      turnIndex: this.turns.length,
      t0: null, t1: null, t2: null, t3: null, t4: null,
      t5: null, t6: null, t7: null, t8: null, t9: null, t10: null,
      sttProvider: null,
      claudeModel: null,
      claudeTokens: 0,
      ttsChunks: 0,
      ttsProvider: null,
      transcript: '',
      responseText: '',
      bargedIn: false,
      incomplete: false,
    };
    this.mark('t0');
    return this._current;
  }

  /**
   * Record a timestamp.
   * @param {string} label — t0 through t10
   */
  mark(label) {
    if (!this._current) return;
    this._current[label] = Date.now();
  }

  /**
   * Attach metadata to the current turn.
   */
  annotate(data) {
    if (!this._current) return;
    Object.assign(this._current, data);
  }

  /**
   * Finalise the current turn and compute deltas.
   */
  endTurn() {
    if (!this._current) return null;
    const t = this._current;
    t.deltas = {
      sttLatency:      _delta(t.t0, t.t2),
      claudeTTFT:      _delta(t.t3, t.t4),
      chunkerLatency:  _delta(t.t4, t.t5),
      ttsTTFB:         _delta(t.t6, t.t7),
      pipelineLatency: _delta(t.t2, t.t8),
      totalPerceived:  _delta(t.t0, t.t8),
      turnDuration:    _delta(t.t0, t.t9),
    };
    this.turns.push(t);
    const result = t;

    if (config.metrics.verbose) {
      console.log(`[METRICS] CallSid=${this.callSid} Turn=${t.turnIndex}`, JSON.stringify(t.deltas));
    }

    this._current = null;
    return result;
  }

  /**
   * Get summary stats across all completed turns.
   */
  summary() {
    const completed = this.turns.filter(t => !t.incomplete);
    if (completed.length === 0) return null;

    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const p95 = (arr) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    const extract = (key) => completed.map(t => t.deltas?.[key]).filter(v => v !== null);

    return {
      callSid: this.callSid,
      totalTurns: this.turns.length,
      completedTurns: completed.length,
      bargeIns: this.turns.filter(t => t.bargedIn).length,
      avgTotalPerceived: avg(extract('totalPerceived')),
      p95TotalPerceived: p95(extract('totalPerceived')),
      avgSttLatency: avg(extract('sttLatency')),
      avgClaudeTTFT: avg(extract('claudeTTFT')),
      avgTtsTTFB: avg(extract('ttsTTFB')),
      avgPipelineLatency: avg(extract('pipelineLatency')),
    };
  }

  /**
   * Get the current (in-progress) turn, if any.
   */
  get currentTurn() {
    return this._current;
  }
}

function _delta(start, end) {
  if (start == null || end == null) return null;
  return end - start;
}

module.exports = RealtimeMetrics;
