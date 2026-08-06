/**
 * Sales360 Realtime Streaming — GenerationContext
 * ADR-002 Week 1
 *
 * Wraps an AbortController so that when the caller barges in
 * (starts speaking while the agent is still talking), we can
 * cancel every in-flight operation in the pipeline:
 *   1. Claude SSE stream → abort fetch
 *   2. SpeakableTextChunker → stop flushing
 *   3. ElevenLabs WebSocket → close / discard
 *   4. Twilio outbound audio → clear buffer
 *
 * Each turn gets its own GenerationContext. When barge-in fires,
 * we abort the current context and create a fresh one for the
 * new turn.
 */

'use strict';

const { EventEmitter } = require('events');

class GenerationContext extends EventEmitter {
  /**
   * @param {string} turnId — Unique identifier for this turn
   */
  constructor(turnId) {
    super();
    this.turnId = turnId;
    this.controller = new AbortController();
    this.state = 'active';   // active | aborted | completed
    this._created = Date.now();
  }

  /**
   * The AbortSignal to pass to fetch(), WebSocket handlers, etc.
   */
  get signal() {
    return this.controller.signal;
  }

  /**
   * Whether this context has been cancelled.
   */
  get aborted() {
    return this.controller.signal.aborted;
  }

  /**
   * Cancel all in-flight work for this turn.
   * Called on barge-in or call end.
   * @param {string} reason — Why we're aborting
   */
  abort(reason = 'barge-in') {
    if (this.state !== 'active') return;
    this.state = 'aborted';
    this.controller.abort(reason);
    this.emit('abort', { turnId: this.turnId, reason, age: Date.now() - this._created });
  }

  /**
   * Mark this turn as successfully completed.
   */
  complete() {
    if (this.state !== 'active') return;
    this.state = 'completed';
    this.emit('complete', { turnId: this.turnId, duration: Date.now() - this._created });
  }

  /**
   * Guard: run a callback only if this context is still active.
   * Silently returns undefined if aborted.
   */
  ifActive(fn) {
    if (this.state === 'active') return fn();
  }
}

module.exports = GenerationContext;
