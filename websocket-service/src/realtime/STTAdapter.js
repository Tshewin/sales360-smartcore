/**
 * Sales360 Realtime Streaming — STTAdapter (Abstract)
 * ADR-002 Week 1
 *
 * Defines the interface that any STT provider must implement.
 * Deepgram is the provisional provider, but this adapter pattern
 * lets us swap in Whisper, Google, AssemblyAI, etc. without
 * touching the pipeline.
 *
 * Events emitted:
 *   'interim'    — { text, confidence, isFinal: false }
 *   'final'      — { text, confidence, isFinal: true }
 *   'error'      — { error }
 *   'connected'  — provider WebSocket open
 *   'closed'     — provider WebSocket closed
 */

'use strict';

const { EventEmitter } = require('events');

class STTAdapter extends EventEmitter {
  /**
   * @param {object} options — Provider-specific config
   */
  constructor(options = {}) {
    super();
    this.options = options;
    this.connected = false;
    this.provider = 'abstract';
  }

  /**
   * Open the STT connection. Must be overridden.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('STTAdapter.connect() must be implemented by subclass');
  }

  /**
   * Send raw audio bytes to the STT provider.
   * @param {Buffer} audioChunk — μ-law 8kHz mono audio
   */
  sendAudio(audioChunk) {
    throw new Error('STTAdapter.sendAudio() must be implemented by subclass');
  }

  /**
   * Signal end of audio stream (caller hung up / turn boundary).
   */
  async endAudio() {
    throw new Error('STTAdapter.endAudio() must be implemented by subclass');
  }

  /**
   * Close the STT connection and clean up.
   */
  async close() {
    throw new Error('STTAdapter.close() must be implemented by subclass');
  }

  /**
   * Whether the provider is ready to receive audio.
   */
  isReady() {
    return this.connected;
  }
}

module.exports = STTAdapter;
