/**
 * Sales360 Realtime Streaming — Media Stream Routes
 * ADR-002 Week 2 (updated from Week 1)
 *
 * COLLISION FIX: The existing wss in server.js uses { server } which
 * grabs ALL upgrade events. We resolve this by checking the path
 * INSIDE the existing wss 'connection' handler would never fire for
 * /twilio/media — instead we intercept at the HTTP server 'upgrade'
 * event BEFORE the existing wss sees it, by registering our handler
 * first (prepend listener).
 *
 * Wire-up in server.js — call BEFORE new WebSocket.Server({ server }):
 *
 *   const { attachMediaStreamRoutes } = require('./src/realtime/media-stream-routes');
 *   attachMediaStreamRoutes(server, app, { echoMode: false });
 */

'use strict';

const { parse } = require('url');
const WebSocket = require('ws');
const MediaStreamHandler = require('./MediaStreamHandler');

const activeSessions = new Map();

function attachMediaStreamRoutes(server, app, opts = {}) {
  const echoMode = opts.echoMode !== undefined ? opts.echoMode : false;

  const wss = new WebSocket.Server({ noServer: true });

  // ── PREPEND so we intercept /twilio/media BEFORE the dashboard wss ──
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
    const callSid = query.CallSid || `media-${Date.now()}`;

    console.log(`[MediaStream] New session CallSid=${callSid} echoMode=${echoMode}`);

    const handler = new MediaStreamHandler(ws, { callSid, echoMode });
    activeSessions.set(callSid, handler);

    handler.on('close', () => {
      activeSessions.delete(callSid);
      console.log(`[MediaStream] Session closed CallSid=${callSid} remaining=${activeSessions.size}`);
    });

    handler.on('streamStart', (info) => {
      console.log(`[MediaStream] Stream started:`, JSON.stringify(info));
    });

    handler.on('transcript', ({ callSid, text, isFinal }) => {
      if (isFinal) {
        console.log(`[MediaStream] Final transcript CallSid=${callSid}: "${text}"`);
      }
    });
  });

  if (app) {
    app.get('/twilio/media-test', (req, res) => {
      const host = req.headers.host || 'localhost';
      const wsUrl = `wss://${host}/twilio/media`;
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    });

    app.post('/twilio/media-test', (req, res) => {
      const host = req.headers.host || 'localhost';
      const wsUrl = `wss://${host}/twilio/media`;
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    });

    app.get('/twilio/media-status', (req, res) => {
      const sessions = [];
      for (const [callSid, handler] of activeSessions) {
        sessions.push({
          callSid,
          streamSid: handler.streamSid,
          turnCount: handler.turnCount,
          metrics: handler.metrics.summary(),
        });
      }
      res.json({ activeSessions: sessions.length, sessions, echoMode });
    });
  }

  console.log(`[MediaStreamRoutes] Attached — /twilio/media (WS) echoMode=${echoMode}`);
  return wss;
}

module.exports = { attachMediaStreamRoutes, activeSessions };
