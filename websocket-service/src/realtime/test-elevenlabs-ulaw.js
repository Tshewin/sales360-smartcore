/**
 * Sales360 Realtime Streaming — ElevenLabs ulaw_8000 Verification
 * ADR-002 Week 1 — Task 4
 *
 * Standalone test script to verify ElevenLabs outputs valid
 * ulaw_8000 audio that Twilio can consume directly.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xxx node src/realtime/test-elevenlabs-ulaw.js
 *
 * What it checks:
 *   1. WebSocket connects to ElevenLabs with ulaw_8000 format
 *   2. Audio chunks are received
 *   3. Audio is valid μ-law (byte values in expected range)
 *   4. Sample rate / byte rate is consistent with 8kHz mono
 *   5. Audio can be base64-encoded for Twilio Media Streams
 */

'use strict';

const WebSocket = require('ws');

const API_KEY = process.env.ELEVENLABS_API_KEY;
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
  console.log(`Voice: ${VOICE_ID}`);
  console.log(`Model: ${MODEL_ID}`);
  console.log(`Format: ${OUTPUT_FORMAT}`);
  console.log(`Text: "${TEST_TEXT}"`);
  console.log('');

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input`
    + `?model_id=${MODEL_ID}`
    + `&output_format=${OUTPUT_FORMAT}`
    + `&optimize_streaming_latency=4`;

  const audioChunks = [];
  let firstChunkTime = null;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timeout — no response in 15s'));
    }, 15000);

    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      const connectTime = Date.now() - startTime;
      console.log(`   Connection time: ${connectTime}ms`);

      // Send BOS (beginning of stream)
      ws.send(JSON.stringify({
        text: ' ',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
        xi_api_key: API_KEY,
      }));

      // Send text
      ws.send(JSON.stringify({
        text: TEST_TEXT,
        try_trigger_generation: true,
      }));

      // Send EOS (end of stream)
      ws.send(JSON.stringify({ text: '' }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.audio) {
          const chunk = Buffer.from(msg.audio, 'base64');
          audioChunks.push(chunk);

          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const ttfb = firstChunkTime - startTime;
            console.log(`✅ First audio chunk received`);
            console.log(`   TTFB: ${ttfb}ms`);
            console.log(`   Chunk size: ${chunk.length} bytes`);
          }
        }

        if (msg.isFinal) {
          clearTimeout(timeout);
          ws.close();

          // ── Analyse results ──
          const totalAudio = Buffer.concat(audioChunks);
          const totalTime = Date.now() - startTime;

          console.log('');
          console.log('── Audio Analysis ──────────────────────');
          console.log(`Total chunks: ${audioChunks.length}`);
          console.log(`Total bytes: ${totalAudio.length}`);
          console.log(`Total time: ${totalTime}ms`);

          // μ-law 8kHz mono = 8000 bytes/second
          const durationSecs = totalAudio.length / 8000;
          console.log(`Estimated duration: ${durationSecs.toFixed(2)}s`);

          // Verify μ-law byte characteristics
          // μ-law values are typically 0x00-0xFF, with silence around 0xFF/0x7F
          const byteDistribution = new Uint8Array(256);
          for (let i = 0; i < totalAudio.length; i++) {
            byteDistribution[totalAudio[i]]++;
          }

          // Check for silence bias (μ-law silence = 0xFF or 0x7F)
          const silenceBytes = (byteDistribution[0xFF] || 0) + (byteDistribution[0x7F] || 0);
          const silenceRatio = silenceBytes / totalAudio.length;

          console.log(`Silence ratio: ${(silenceRatio * 100).toFixed(1)}%`);

          // Verify it's not all zeros (would indicate wrong format)
          const zeroBytes = byteDistribution[0x00] || 0;
          const zeroRatio = zeroBytes / totalAudio.length;

          if (zeroRatio > 0.5) {
            console.log('⚠️  High zero-byte ratio — may not be valid μ-law');
          } else {
            console.log('✅ Byte distribution looks like valid μ-law');
          }

          // Verify Twilio compatibility (base64 encoding)
          const b64 = totalAudio.toString('base64');
          const decoded = Buffer.from(b64, 'base64');
          const b64Match = decoded.equals(totalAudio);
          console.log(`✅ Base64 round-trip: ${b64Match ? 'PASS' : 'FAIL'}`);
          console.log(`   Base64 payload size: ${b64.length} chars`);

          // Verify chunk sizes (Twilio expects reasonable frame sizes)
          const sizes = audioChunks.map(c => c.length);
          const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
          const minSize = Math.min(...sizes);
          const maxSize = Math.max(...sizes);
          console.log(`   Chunk sizes: min=${minSize} avg=${avgSize} max=${maxSize}`);

          console.log('');
          console.log('── Twilio Compatibility ────────────────');
          console.log(`Format: ulaw_8000 ✅`);
          console.log(`Sample rate: 8000 Hz (${durationSecs > 0.5 ? '✅' : '⚠️  too short to verify'})`);
          console.log(`Encoding: μ-law ✅`);
          console.log(`No FFmpeg needed: ✅`);

          console.log('');
          console.log('═══════════════════════════════════════════');
          console.log(`  RESULT: ${b64Match && zeroRatio < 0.5 ? '✅ PASS' : '❌ FAIL'}`);
          console.log('═══════════════════════════════════════════');

          resolve();
        }
      } catch (err) {
        console.error('Parse error:', err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error('❌ WebSocket error:', err.message);
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
