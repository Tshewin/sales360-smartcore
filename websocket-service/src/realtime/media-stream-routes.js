/**
 * Sales360 Realtime Streaming — Media Stream Routes
 * ADR-002 Week 2
 *
 * No prependListener — upgrade handled entirely in server.js
 * This module just manages the WSS and session lifecycle.
 */

'use strict';

const WebSocket = require('ws');
const { parse } = require('url');
const MediaStreamHandler = require('./MediaStreamHandler');

const activeSessions = new Map();

// WSS instance — exported so server.js can pass upgrades to it
const mediaWss = new WebSocket.Server({ noServer: true });

function attachMediaStreamRoutes(server, app, opts) {
  opts = opts || {};
  var echoMode     = opts.echoMode !== undefined ? opts.echoMode : false;
  var systemPrompt = opts.systemPrompt || '';
  var openingLine  = opts.openingLine  || '';

  mediaWss.on('connection', function(ws, request) {
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
      twiml += '<Connect>';
      twiml += '<Stream url="' + wsUrl + '" />';
      twiml += '</Connect>';
      twiml += '</Response>';
      res.type('text/xml').send(twiml);
    });

    app.post('/twilio/media-test', function(req, res) {
      var host  = req.headers.host || 'localhost';
      var wsUrl = 'wss://' + host + '/twilio/media';
      var twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';
      twiml += '<Connect>';
      twiml += '<Stream url="' + wsUrl + '" />';
      twiml += '</Connect>';
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
}

module.exports = { attachMediaStreamRoutes, mediaWss, activeSessions };
