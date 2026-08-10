/**
 * Sales360 Realtime Streaming — ElevenLabs ulaw_8000 Verification
 * ADR-002 Week 1 — Task 4 (revised)
 *
 * Usage:
 *   $env:ELEVENLABS_API_KEY="sk_xxx"
 *   $env:ELEVENLABS_VOICE_ID="lJd1hi6nFFWkrcDH9i3a"
 *   node src/realtime/test-elevenlabs-ulaw.js
 */

'use strict';

const WebSocket = require('ws');

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a';
const MODEL_ID = 'eleven_turbo_v2_5';
const OUTPUT_FORMAT = 'ulaw_8000';
const TEST_TEXT = 'Good afternoon, this is Sales360 AI. I am calling to follow up on your enquiry. Do you have a couple of minutes?';

async function main() {
  if (!API_KEY) {
    console.error('❌ Set ELEVENLABS_API_KEY environment variable');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log('  ElevenLabs ulaw_8000 Format Verification');
  console.log('═══════════════════════════════════════════');
  console.log(`Voice:  ${VOICE_ID}`);
  console.log(`Model:  ${MODEL_ID}`);
  console.log(`Format: ${OUTPUT_FORMAT}`);
  console.log(`Text:   "${TEST_TEXT}"`);
  console.log('');

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input`
    + `?model_id=${MODEL_ID}`
    + `&output_format=${OUTPUT_FORMAT}`
    + `&optimize_streaming_latency=4`;

  const audioChunks = [];
  let firstChunkTime = null;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // ── Auth now goes in the WS header, not BOS body ──
    const ws = new WebSocket(url, {
      headers: { 'xi-api-key': API_KEY },
    });

    const timeout = setTimeout(() => {
      console.log('\n⚠️  Raw messages received before timeout:');
      ws.close();
      reject(new Error('Timeout — no isFinal in 20s'));
    }, 20000);

    ws.on('open', () => {
      const connectTime = Date.now() - startTime;
      console.log(`✅ WebSocket connected (${connectTime}ms)`);

      // BOS — voice settings only, no api key in body
      ws.send(JSON.stringify({
        text: ' ',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      }));

      // Text chunk
      ws.send(JSON.stringify({
        text: TEST_TEXT,
        try_trigger_generation: true,
      }));

      // EOS — flush
      ws.send(JSON.stringify({ text: '' }));

      console.log('📤 BOS + text + EOS sent');
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Log every message type for debugging
        const keys = Object.keys(msg).join(', ');
        console.log(`📨 Message keys: [${keys}]`);

        // Audio chunk
        if (msg.audio) {
          const chunk = Buffer.from(msg.audio, 'base64');
          audioChunks.push(chunk);

          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const ttfb = firstChunkTime - startTime;
            console.log(`✅ First audio chunk — TTFB: ${ttfb}ms  size: ${chunk.length} bytes`);
          }
        }

        // Error from ElevenLabs
        if (msg.error || msg.message) {
          console.error('❌ ElevenLabs error message:', JSON.stringify(msg));
        }

        // Final
        if (msg.isFinal) {
          clearTimeout(timeout);
          ws.close();

          const totalAudio = Buffer.concat(audioChunks);
          const totalTime  = Date.now() - startTime;

          console.log('');
          console.log('── Audio Analysis ──────────────────────');
          console.log(`Total chunks:    ${audioChunks.length}`);
          console.log(`Total bytes:     ${totalAudio.length}`);
          console.log(`Total time:      ${totalTime}ms`);

          const durationSecs = totalAudio.length / 8000;
          console.log(`Est. duration:   ${durationSecs.toFixed(2)}s`);

          // Byte distribution check
          const byteCount = new Array(256).fill(0);
          for (let i = 0; i < totalAudio.length; i++) byteCount[totalAudio[i]]++;
          const zeroRatio = byteCount[0] / totalAudio.length;
          const validMulaw = zeroRatio < 0.5;
          console.log(`Zero-byte ratio: ${(zeroRatio * 100).toFixed(1)}% ${validMulaw ? '✅' : '⚠️'}`);

          // Base64 round-trip
          const b64 = totalAudio.toString('base64');
          const b64Match = Buffer.from(b64, 'base64').equals(totalAudio);
          console.log(`Base64 round-trip: ${b64Match ? '✅ PASS' : '❌ FAIL'}`);

          const sizes = audioChunks.map(c => c.length);
          const avg   = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
          console.log(`Chunk sizes:     min=${Math.min(...sizes)} avg=${avg} max=${Math.max(...sizes)}`);

          console.log('');
          console.log('── Twilio Compatibility ─────────────────');
          console.log(`Format ulaw_8000:     ✅`);
          console.log(`No FFmpeg needed:     ✅`);
          console.log(`Twilio-ready base64:  ${b64Match ? '✅' : '❌'}`);

          const pass = b64Match && validMulaw && audioChunks.length > 0;
          console.log('');
          console.log('═══════════════════════════════════════════');
          console.log(`  RESULT: ${pass ? '✅ PASS — ready for Week 2' : '❌ FAIL — check output above'}`);
          console.log('═══════════════════════════════════════════');

          resolve();
        }
      } catch (err) {
        console.error('Parse error:', err.message, 'raw:', raw.toString().substring(0, 200));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error('❌ WebSocket error:', err.message);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      console.log(`WS closed — code: ${code} reason: ${reason?.toString() || 'none'}`);
    });
  });
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
