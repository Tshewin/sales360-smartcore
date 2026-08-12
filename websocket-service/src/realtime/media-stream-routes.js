/**
 * Sales360 Realtime Streaming — Media Stream Routes
 * ADR-002 Week 2
 */

'use strict';

const { parse } = require('url');
const WebSocket = require('ws');
const MediaStreamHandler = require('./MediaStreamHandler');

const activeSessions = new Map();

function attachMediaStreamRoutes(server, app, opts) {
  opts = opts || {};
  var echoMode = opts.echoMode !== undefined ? opts.echoMode : false;
  var systemPrompt = opts.systemPrompt || '';
  var openingLine  = opts.openingLine  || '';

  var wss = new WebSocket.Server({ noServer: true });

  server.prependListener('upgrade', function(request, socket, head) {
    var pathname = parse(request.url).pathname;
    if (pathname === '/twilio/media') {
      wss.handleUpgrade(request, socket, head, function(ws) {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', function(ws, request) {
    var query   = parse(request.url, true).query;
    var callSid = query.CallSid || ('media-' + Date.now());

    console.log('[MediaStream] New session CallSid=' + callSid + ' echoMode=' + echoMode);

    var handler = new MediaStreamHandler(ws, {
      callSid:      callSid,
      echoMode:     echoMode,
      systemPrompt: systemPrompt,
      openingLine:  openingLine,
    });

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
      var host  = req.headers.host || 'localhost';
      var wsUrl = 'wss://' + host + '/twilio/media';
      var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';
      twiml += '<Start><Stream url="' + wsUrl + '" track="both_tracks" /></Start>';
      twiml += '<Pause length="60"/>';
      twiml += '</Response>';
      res.type('text/xml').send(twiml);
    });

    app.post('/twilio/media-test', function(req, res) {
      var host  = req.headers.host || 'localhost';
      var wsUrl = 'wss://' + host + '/twilio/media';
      var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';
      twiml += '<Start><Stream url="' + wsUrl + '" track="both_tracks" /></Start>';
      twiml += '<Pause length="60"/>';
      twiml += '</Response>';
      res.type('text/xml').send(twiml);
    });

    app.get('/twilio/media-status', function(req, res) {
      var sessions = [];
      activeSessions.forEach(function(handler, callSid) {
        sessions.push({
          callSid:   callSid,
          streamSid: handler.streamSid,
          turnCount: handler.turnCount,
          metrics:   handler.metrics.summary(),
        });
      });
      res.json({ activeSessions: sessions.length, sessions: sessions, echoMode: echoMode });
    });
  }

  console.log('[MediaStreamRoutes] Attached — /twilio/media (WS) echoMode=' + echoMode);
  return wss;
}

module.exports = { attachMediaStreamRoutes, activeSessions };
