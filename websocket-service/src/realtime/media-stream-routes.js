/**
 * Sales360 Realtime Streaming — Media Stream Routes
 * ADR-002 Week 2
 */

'use strict';

const { parse } = require('url');
const WebSocket = require('ws');
const MediaStreamHandler = require('./MediaStreamHandler');

const activeSessions = new Map();

function attachMediaStreamRoutes(server, app, opts = {}) {
  const echoMode = opts.echoMode !== undefined ? opts.echoMode : false;

  const wss = new WebSocket.Server({ noServer: true });

  server.prependListener('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);
    if (pathname === '/twilio/media') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws, request) => {
    const { query } = parse(request.url, true);
    const callSid = query.CallSid || ('media-' + Date.now());

    console.log('[MediaStream] New session CallSid=' + callSid + ' echoMode=' + echoMode);

    const handler = new MediaStreamHandler(ws, { callSid, echoMode });
    activeSessions.set(callSid, handler);

    handler.on('close', function() {
      activeSessions.delete(callSid);
      console.log('[MediaStream] Session closed CallSid=' + callSid + ' remaining=' + activeSessions.size);
    });

    handler.on('streamStart', function(info) {
      console.log('[MediaStream] Stream started:', JSON.stringify(info));
    });

    handler.on('transcript', function(data) {
      if (data.isFinal) {
        console.log('[MediaStream] Final transcript CallSid=' + data.callSid + ': "' + data.text + '"');
      }
    });
  });

  if (app) {
    app.get('/twilio/media-test', function(req, res) {
      var host = req.headers.host || 'localhost';
      var wsUrl = 'wss://' + host + '/twilio/media';
      var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';
      twiml += '<Start>';
      twiml += '<Stream url="' + wsUrl + '" track="both_tracks" />';
      twiml += '</Start>';
      twiml += '<Pause length="60"/>';
      twiml += '</Response>';
      res.type('text/xml').send(twiml);
    });

    app.post('/twilio/media-test', function(req, res) {
      var host = req.headers.host || 'localhost';
      var wsUrl = 'wss://' + host + '/twilio/media';
      var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';
      twiml += '<Start>';
      twiml += '<Stream url="' + wsUrl + '" track="both_tracks" />';
      twiml += '</Start>';
      twiml += '<Pause length="60"/>';
      twiml += '</Response>';
      res.type('text/xml').send(twiml);
    });

    app.get('/twilio/media-status', function(req, res) {
      var sessions = [];
      activeSessions.forEach(function(handler, callSid) {
        sessions.push({
          callSid: callSid,
          streamSid: handler.streamSid,
          turnCount: handler.turnCount,
          metrics: handler.metrics.summary(),
        });
      });
      res.json({ activeSessions: sessions.length, sessions: sessions, echoMode: echoMode });
    });
  }

  console.log('[MediaStreamRoutes] Attached — /twilio/media (WS) echoMode=' + echoMode);
  return wss;
}

module.exports = { attachMediaStreamRoutes, activeSessions };
