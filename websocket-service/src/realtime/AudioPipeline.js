/**
 * Sales360 Realtime Streaming — AudioPipeline
 * ADR-002 Week 1
 *
 * Handles the μ-law audio plumbing between Twilio Media Streams
 * and our STT/TTS providers.
 *
 * Inbound (caller → STT):
 *   Twilio sends base64-encoded μ-law → decode → forward to STT
 *
 * Outbound (TTS → caller):
 *   ElevenLabs returns raw μ-law bytes → base64 encode → send
 *   to Twilio as Media Stream 'media' messages
 *
 * No FFmpeg anywhere — ElevenLabs outputs ulaw_8000 natively.
 */

'use strict';

const config = require('./config');

class AudioPipeline {
  /**
   * @param {WebSocket} twilioWs — The Twilio Media Stream WebSocket
   * @param {string} streamSid — Twilio's stream identifier
   */
  constructor(twilioWs, streamSid) {
    this._ws = twilioWs;
    this._streamSid = streamSid;
    this._sequenceNumber = 0;
    this._outboundActive = false;
  }

  /**
   * Decode an inbound Twilio media message to raw μ-law bytes.
   * @param {object} mediaMsg — Parsed Twilio 'media' event
   * @returns {Buffer} — Raw μ-law audio
   */
  decodeInbound(mediaMsg) {
    return Buffer.from(mediaMsg.payload, 'base64');
  }

  /**
   * Send raw μ-law audio bytes to the caller via Twilio Media Stream.
   * @param {Buffer} audioChunk — Raw μ-law 8kHz audio from ElevenLabs
   */
  sendOutbound(audioChunk) {
    if (!this._ws || this._ws.readyState !== 1) return; // WebSocket.OPEN = 1

    const payload = audioChunk.toString('base64');
    const msg = {
      event: 'media',
      streamSid: this._streamSid,
      media: {
        payload,
      },
    };

    this._ws.send(JSON.stringify(msg));
    this._outboundActive = true;
  }

  /**
   * Clear the Twilio audio buffer (for barge-in).
   * Sends a 'clear' event to stop any queued outbound audio.
   */
  clearOutbound() {
    if (!this._ws || this._ws.readyState !== 1) return;

    this._ws.send(JSON.stringify({
      event: 'clear',
      streamSid: this._streamSid,
    }));
    this._outboundActive = false;
  }

  /**
   * Send a mark event to Twilio for tracking playback position.
   * @param {string} markName — Identifier for this mark
   */
  sendMark(markName) {
    if (!this._ws || this._ws.readyState !== 1) return;

    this._ws.send(JSON.stringify({
      event: 'mark',
      streamSid: this._streamSid,
      mark: { name: markName },
    }));
  }

  /**
   * Update stream SID (set after Twilio sends the 'start' event).
   */
  setStreamSid(sid) {
    this._streamSid = sid;
  }

  get isActive() {
    return this._outboundActive;
  }

  get streamSid() {
    return this._streamSid;
  }
}

module.exports = AudioPipeline;
