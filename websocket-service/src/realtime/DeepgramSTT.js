/**
 * Sales360 Realtime Streaming — DeepgramSTT
 * ADR-002 Week 2 — Updated for TurnCompletionController
 *
 * Changes:
 * - vad_events: true — enables SpeechStarted event
 * - Emits 'speechFinal' when speech_final=true
 * - Emits 'speechStarted' on VAD SpeechStarted event
 * - Both used by TurnCompletionController for adaptive turn detection
 */

'use strict';

const WebSocket = require('ws');
const STTAdapter = require('./STTAdapter');
const config = require('./config');

class DeepgramSTT extends STTAdapter {
  constructor(options = {}) {
    super(options);
    this.provider = 'deepgram';
    this._ws = null;
    this._cfg = { ...config.stt.deepgram, ...options };
    this._keepAliveInterval = null;
  }

  async connect() {
    const apiKey = this._cfg.apiKey;
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required');

    const params = new URLSearchParams({
      model:            this._cfg.model,
      language:         this._cfg.language,
      encoding:         this._cfg.encoding,
      sample_rate:      String(this._cfg.sampleRate),
      channels:         String(this._cfg.channels),
      punctuate:        String(this._cfg.punctuate),
      interim_results:  String(this._cfg.interimResults),
      utterance_end_ms: String(this._cfg.utteranceEndMs),
      endpointing:      String(this._cfg.endpointing),
      smart_format:     String(this._cfg.smartFormat),
      vad_events:       'true',   // enables SpeechStarted event
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      this._ws.on('open', () => {
        this.connected = true;
        this._keepAliveInterval = setInterval(() => {
          if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 8000);
        this.emit('connected');
        resolve();
      });

      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch (err) {
          this.emit('error', { error: err, context: 'parse' });
        }
      });

      this._ws.on('error', (err) => {
        this.emit('error', { error: err, context: 'websocket' });
        if (!this.connected) reject(err);
      });

      this._ws.on('close', (code, reason) => {
        this.connected = false;
        clearInterval(this._keepAliveInterval);
        this.emit('closed', { code, reason: reason?.toString() });
      });
    });
  }

  sendAudio(audioChunk) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(audioChunk);
    }
  }

  async endAudio() {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  async close() {
    clearInterval(this._keepAliveInterval);
    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.close(1000, 'session_end');
      }
      this._ws = null;
    }
    this.connected = false;
  }

  _handleMessage(msg) {
    // Speech transcript results
    if (msg.type === 'Results' && msg.channel?.alternatives?.length > 0) {
      const alt = msg.channel.alternatives[0];
      const text = alt.transcript || '';
      if (text.length === 0) return;

      const result = {
        text,
        confidence:  alt.confidence || 0,
        isFinal:     msg.is_final === true,
        speechFinal: msg.speech_final === true,
        words:       alt.words || [],
      };

      if (result.isFinal) {
        this.emit('final', result);
        // speech_final = Deepgram's endpointing detected a silence gap
        // This is the candidate turn-end signal for TurnCompletionController
        if (result.speechFinal) {
          this.emit('speechFinal', result);
        }
      } else {
        this.emit('interim', result);
      }
    }

    // VAD SpeechStarted — prospect resumed speaking
    // Critical for cancelling pending turn commits
    if (msg.type === 'SpeechStarted') {
      this.emit('speechStarted', { timestamp: msg.timestamp });
    }

    // UtteranceEnd — backstop signal
    if (msg.type === 'UtteranceEnd') {
      this.emit('utteranceEnd', { lastWordEnd: msg.last_word_end });
    }

    // Metadata
    if (msg.type === 'Metadata') {
      this.emit('metadata', msg);
    }
  }
}

module.exports = DeepgramSTT;
