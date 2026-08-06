/**
 * Sales360 Realtime Streaming — SpeakableTextChunker
 * ADR-002 Week 1
 *
 * Takes a stream of Claude SSE tokens and groups them into
 * speakable chunks for ElevenLabs. Not naive sentence-splitting:
 *
 *   • Flushes on sentence-ending punctuation (.!?;:) followed by space
 *   • Flushes on soft breaks (commas, dashes) if buffer is long enough
 *   • Flushes on minimum-char threshold to prevent runaway buffering
 *   • Never flushes a fragment shorter than minChunkChars
 *   • Strips trailing whitespace from chunks
 *
 * This is the "Level 2" chunker from ADR-002 — designed for
 * natural-sounding speech, not just low latency.
 */

'use strict';

const { EventEmitter } = require('events');
const config = require('./config');

class SpeakableTextChunker extends EventEmitter {
  /**
   * @param {import('./GenerationContext')} ctx — Current turn's context
   */
  constructor(ctx) {
    super();
    this._buffer = '';
    this._ctx = ctx;
    this._chunkCount = 0;
    this._cfg = config.chunker;

    // If the turn is aborted, stop processing
    if (ctx) {
      ctx.signal.addEventListener('abort', () => {
        this._buffer = '';
      }, { once: true });
    }
  }

  /**
   * Feed a token (or partial token) from Claude SSE.
   * May emit zero or one 'chunk' events.
   * @param {string} token
   */
  write(token) {
    if (this._ctx?.aborted) return;
    this._buffer += token;
    this._tryFlush();
  }

  /**
   * Signal that Claude is done sending tokens.
   * Flushes any remaining buffer as a final chunk.
   */
  end() {
    if (this._ctx?.aborted) return;
    const remaining = this._buffer.trim();
    if (remaining.length > 0) {
      this._emit(remaining, true);
    }
    this._buffer = '';
    this.emit('done', { totalChunks: this._chunkCount });
  }

  /**
   * Internal: check if the buffer should be flushed.
   */
  _tryFlush() {
    const buf = this._buffer;

    // 1. Sentence-ending punctuation followed by whitespace
    const sentenceMatch = buf.match(this._cfg.sentenceEnders);
    if (sentenceMatch) {
      const splitIdx = sentenceMatch.index + sentenceMatch[0].length;
      const chunk = buf.substring(0, splitIdx).trim();
      this._buffer = buf.substring(splitIdx);
      if (chunk.length >= this._cfg.minChunkChars) {
        this._emit(chunk, false);
      }
      // Recurse in case there are multiple sentences buffered
      if (this._buffer.length > this._cfg.minChunkChars) {
        this._tryFlush();
      }
      return;
    }

    // 2. Soft break (comma, dash) if buffer is long enough
    if (buf.length >= this._cfg.softBreakMinChars) {
      const softMatch = buf.match(this._cfg.softBreakers);
      if (softMatch) {
        const splitIdx = softMatch.index + softMatch[0].length;
        const chunk = buf.substring(0, splitIdx).trim();
        this._buffer = buf.substring(splitIdx);
        if (chunk.length >= this._cfg.minChunkChars) {
          this._emit(chunk, false);
        }
      }
    }
  }

  /**
   * Internal: emit a chunk event.
   */
  _emit(text, isFinal) {
    this._chunkCount++;
    this.emit('chunk', {
      text,
      index: this._chunkCount - 1,
      isFinal,
    });
  }
}

module.exports = SpeakableTextChunker;
