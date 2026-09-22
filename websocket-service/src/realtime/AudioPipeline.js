/**
 * Sales360 Realtime Streaming — AudioPipeline
 * Patch E: Add sendMark() + lastOutboundAt tracking
 */

'use strict';

class AudioPipeline {
  constructor(twilioWs, streamSid) {
    this._ws             = twilioWs;
    this._streamSid      = streamSid;
    this._outboundActive = false;
    this._chunksSent     = 0;
    this._lastOutboundAt = Date.now();  // Patch E: track last outbound write
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
    this._lastOutboundAt = Date.now();  // Patch E

    if (false) {
      console.log('[AudioPipeline] Sent chunk #' + this._chunksSent + ' streamSid=' + this._streamSid + ' bytes=' + audioChunk.length);
    }
  }

  // Patch E: Send a Twilio mark event — Twilio echoes it back when buffer plays to that point
  sendMark(name) {
    if (!this._ws || this._ws.readyState !== 1) return;
    if (!this._streamSid) return;
    this._ws.send(JSON.stringify({
      event:     'mark',
      streamSid: this._streamSid,
      mark:      { name: name },
    }));
    this._lastOutboundAt = Date.now();
    console.log('[AudioPipeline] Mark sent: ' + name);
  }

  clearOutbound() {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify({
      event:     'clear',
      streamSid: this._streamSid,
    }));
    this._outboundActive = false;
    this._lastOutboundAt = Date.now();
    console.log('[AudioPipeline] Cleared outbound buffer');
  }

  setStreamSid(sid) {
    this._streamSid = sid;
    console.log('[AudioPipeline] StreamSid set: ' + sid);
  }

  get isActive()        { return this._outboundActive; }
  get streamSid()       { return this._streamSid; }
  get chunksSent()      { return this._chunksSent; }
  get lastOutboundAt()  { return this._lastOutboundAt; }  // Patch E
}

module.exports = AudioPipeline;
