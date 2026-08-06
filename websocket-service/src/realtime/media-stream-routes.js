/**
 * Sales360 Realtime Streaming — Media Stream Routes
 * ADR-002 Week 1 — Task 2
 *
 * ADDITIVE ONLY — this file does NOT modify call-routes.js.
 * It adds a single WebSocket upgrade endpoint: /twilio/media
 *
 * Usage in server.js (or wherever the Express app is created):
 *
 *   const { attachMediaStreamRoutes } = require('./src/realtime/media-stream-routes');
 *   attachMediaStreamRoutes(server);   // pass the http.Server, not the Express app
 *
 * Twilio TwiML that connects to this:
 *
 *   <Response>
 *     <Connect>
 *       <Stream url="wss://your-domain.up.railway.app/twilio/media" />
 *     </Connect>
 *   </Response>
 *
 * Week 1: echo mode only (no LLM, no STT).
 * The /twilio/media-test route returns TwiML that triggers Media Streams
 * so we can verify the WebSocket handshake + audio echo end-to-end.
 */

'use strict';

const { parse } = require('url');
const WebSocket = require('ws');
const MediaStreamHandler = require('./MediaStreamHandler');

// Track active sessions for metrics/debugging
const activeSessions = new Map();

/**
 * Attach the Media Stream WebSocket route to an HTTP server.
 * This uses its own WebSocketServer that only handles /twilio/media,
 * leaving any existing WebSocket routes untouched.
 *
 * @param {http.Server} server — The HTTP server (not Express app)
 * @param {Express} app — The Express app (for adding HTTP test routes)
 * @param {object} opts
 * @param {boolean} opts.echoMode — Enable echo test mode (default: true for Week 1)
 */
function attachMediaStreamRoutes(server, app, opts = {}) {
  const echoMode = opts.echoMode !== undefined ? opts.echoMode : true;

  // ── WebSocket Server (path-filtered) ──────────────────────
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);

    if (pathname === '/twilio/media') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Don't handle other paths — let existing WSS handlers deal with them
  });

  wss.on('connection', (ws, request) => {
    // Extract CallSid from query params if available
    const { query } = parse(request.url, true);
    const callSid = query.CallSid || `media-${Date.now()}`;

    console.log(`[MediaStreamRoutes] New connection CallSid=${callSid} echoMode=${echoMode}`);

    const handler = new MediaStreamHandler(ws, {
      callSid,
      echoMode,
    });

    activeSessions.set(callSid, handler);

    handler.on('close', () => {
      activeSessions.delete(callSid);
      console.log(`[MediaStreamRoutes] Session closed CallSid=${callSid} active=${activeSessions.size}`);
    });

    handler.on('streamStart', (info) => {
      console.log(`[MediaStreamRoutes] Stream started:`, JSON.stringify(info));
    });
  });

  // ── HTTP Test Routes (additive) ───────────────────────────

  if (app) {
    /**
     * GET /twilio/media-test
     * Returns TwiML that tells Twilio to open a Media Stream.
     * Use this as the webhook URL for a test call.
     */
    app.get('/twilio/media-test', (req, res) => {
      const host = req.headers.host || 'localhost';
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      const wsUrl = `${protocol}://${host}/twilio/media`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting to Sales360 media stream echo test.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Say>Media stream ended. Goodbye.</Say>
</Response>`;

      res.type('text/xml').send(twiml);
    });

    /**
     * POST /twilio/media-test
     * Same as GET but for Twilio's POST webhook.
     */
    app.post('/twilio/media-test', (req, res) => {
      const host = req.headers.host || 'localhost';
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      const wsUrl = `${protocol}://${host}/twilio/media`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting to Sales360 media stream echo test.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Say>Media stream ended. Goodbye.</Say>
</Response>`;

      res.type('text/xml').send(twiml);
    });

    /**
     * GET /twilio/media-status
     * Debug endpoint — shows active Media Stream sessions.
     */
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
      res.json({
        activeSessions: sessions.length,
        sessions,
        echoMode,
      });
    });
  }

  console.log(`[MediaStreamRoutes] Attached — /twilio/media (WS), /twilio/media-test (HTTP), /twilio/media-status (HTTP)`);
  return wss;
}

module.exports = { attachMediaStreamRoutes };
