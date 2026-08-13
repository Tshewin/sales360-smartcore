/**
 * Sales360 Realtime Streaming — AudioPipeline
 * ADR-002 Week 2 (debug + format fix)
 */

'use strict';

class AudioPipeline {
  constructor(twilioWs, streamSid) {
    this._ws         = twilioWs;
    this._streamSid  = streamSid;
    this._outboundActive = false;
    this._chunksSent = 0;
  }

  decodeInbound(mediaMsg) {
    return Buffer.from(mediaMsg.payload, 'base64');
  }

  sendOutbound(audioChunk) {
    if (!this._ws || this._ws.readyState !== 1) {
      console.log('[AudioPipeline] sendOutbound SKIPPED — ws not open. readyState=' + (this._ws ? this._ws.readyState : 'null'));
      return;
    }
    if (!this._streamSid) {
      console.log('[AudioPipeline] sendOutbound SKIPPED — no streamSid');
      return;
    }

    var payload = audioChunk.toString('base64');
    var msg = JSON.stringify({
      event:     'media',
      streamSid: this._streamSid,
      media:     { payload: payload },
    });

    this._ws.send(msg);
    this._chunksSent++;
    this._outboundActive = true;

    // Log first chunk and every 10th after
    if (this._chunksSent === 1 || this._chunksSent % 100 === 0) {
      console.log('[AudioPipeline] Sent chunk #' + this._chunksSent + ' streamSid=' + this._streamSid + ' bytes=' + audioChunk.length);
    }
  }

  clearOutbound() {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify({
      event:     'clear',
      streamSid: this._streamSid,
    }));
    this._outboundActive = false;
    console.log('[AudioPipeline] Cleared outbound buffer');
  }

  setStreamSid(sid) {
    this._streamSid = sid;
    console.log('[AudioPipeline] StreamSid set: ' + sid);
  }

  get isActive()   { return this._outboundActive; }
  get streamSid()  { return this._streamSid; }
  get chunksSent() { return this._chunksSent; }
}

module.exports = AudioPipeline;
