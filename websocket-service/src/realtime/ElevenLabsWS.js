/**
 * Sales360 Realtime Streaming — ElevenLabsWS
 * ADR-002 Week 1
 *
 * ElevenLabs WebSocket TTS client.
 * Key ADR-002 decision: output_format = ulaw_8000
 * This gives us Twilio-native μ-law directly — no FFmpeg on the hot path.
 *
 * Lifecycle per turn:
 *   1. connect()  — open WS with voice/model config
 *   2. send(text) — stream text chunks from SpeakableTextChunker
 *   3. flush()    — signal end of text input
 *   4. close()    — tear down
 *
 * Events:
 *   'audio'      — { chunk: Buffer }  (μ-law 8kHz raw audio)
 *   'done'       — all audio for this input has been returned
 *   'error'      — { error }
 */

'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const config = require('./config');

class ElevenLabsWS extends EventEmitter {
  /**
   * @param {import('./GenerationContext')} ctx — Current turn's context
   */
  constructor(ctx) {
    super();
    this._ws = null;
    this._ctx = ctx;
    this._cfg = config.tts.elevenlabs;
    this._connected = false;
    this._audioChunkCount = 0;

    // Abort handler
    if (ctx) {
      ctx.signal.addEventListener('abort', () => {
        this.close();
      }, { once: true });
    }
  }

  /**
   * Open the ElevenLabs streaming WebSocket.
   */
  async connect() {
    const { apiKey, voiceId, modelId, outputFormat, optimizeStreamingLatency } = this._cfg;

    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required');

    const url = `${this._cfg.wsUrl}/${voiceId}/stream-input`
      + `?model_id=${modelId}`
      + `&output_format=${outputFormat}`
      + `&optimize_streaming_latency=${optimizeStreamingLatency}`;

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        this._connected = true;
        // Send initial config (BOS — beginning of stream)
        this._ws.send(JSON.stringify({
          text: ' ',  // ElevenLabs requires initial space for BOS
          voice_settings: {
            stability: this._cfg.stability,
            similarity_boost: this._cfg.similarityBoost,
            style: this._cfg.style,
            use_speaker_boost: this._cfg.useSpeakerBoost,
          },
          xi_api_key: apiKey,
        }));
        resolve();
      });

      this._ws.on('message', (raw) => {
        if (this._ctx?.aborted) return;
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch (err) {
          this.emit('error', { error: err, context: 'parse' });
        }
      });

      this._ws.on('error', (err) => {
        this.emit('error', { error: err, context: 'websocket' });
        if (!this._connected) reject(err);
      });

      this._ws.on('close', () => {
        this._connected = false;
      });
    });
  }

  /**
   * Stream a text chunk to ElevenLabs.
   * @param {string} text — Speakable text from the chunker
   */
  send(text) {
    if (!this._connected || this._ctx?.aborted) return;
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        text,
        try_trigger_generation: true,
      }));
    }
  }

  /**
   * Signal end of text input (EOS — end of stream).
   * ElevenLabs will flush remaining audio.
   */
  flush() {
    if (!this._connected || this._ctx?.aborted) return;
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ text: '' }));
    }
  }

  /**
   * Close the WebSocket.
   */
  close() {
    this._connected = false;
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.close(1000, 'turn_end');
      }
      this._ws = null;
    }
  }

  get isConnected() {
    return this._connected;
  }

  /**
   * Handle ElevenLabs response messages.
   */
  _handleMessage(msg) {
    // Audio chunk
    if (msg.audio) {
      this._audioChunkCount++;
      const audioBuffer = Buffer.from(msg.audio, 'base64');
      this.emit('audio', { chunk: audioBuffer, index: this._audioChunkCount - 1 });
    }

    // Final message (generation complete)
    if (msg.isFinal) {
      this.emit('done', { totalChunks: this._audioChunkCount });
    }

    // Alignment data (optional — useful for lip sync / word timing)
    if (msg.normalizedAlignment) {
      this.emit('alignment', msg.normalizedAlignment);
    }
  }
}

module.exports = ElevenLabsWS;
