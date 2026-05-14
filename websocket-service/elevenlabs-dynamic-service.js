// ═══════════════════════════════════════════════════════════
// SALES360 ELEVENLABS DYNAMIC AUDIO SERVICE
// Generate audio on-the-fly for Twilio <Play> tags
// ═══════════════════════════════════════════════════════════

class ElevenLabsDynamicService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'lJd1hi6nFFWkrcDH9i3a';
    
    // Regional voice mapping (Chuks's voice + ElevenLabs library)
    this.voiceMap = {
      'Nigeria': {
        'Male': this.defaultVoiceId, // Chuks's cloned voice
        'Female': '21m00Tcm4TlvDq8ikWAM' // Rachel
      },
      'UK': {
        'Male': 'VR6AewLTigWG4xSOukaG', // Arnold (British)
        'Female': 'MF3mGyEYCl7XYWbV9V6O' // Elli (British)
      },
      'Dubai': {
        'Male': 'pNInz6obpgDQGcFmaJgB', // Adam (deeper)
        'Female': 'EXAVITQu4vr4xnSDxMaL' // Bella
      },
      'India': {
        'Male': 'pqHfZKP75CvOlQylNhV4', // Bill
        'Female': 'XB0fDUnXU5powFXDhCwa' // Charlotte
      }
    };
    
    if (!this.apiKey) {
      console.warn('[ElevenLabs] ⚠️  API key not configured - voice cloning disabled');
      this.enabled = false;
    } else {
      console.log('[ElevenLabs] ✅ Service initialized');
      console.log('[ElevenLabs] Default voice (Chuks):', this.defaultVoiceId);
      this.enabled = true;
    }
  }

  // Get voice ID based on region
  getVoiceId(region = 'Nigeria', gender = 'Male') {
    const regionVoices = this.voiceMap[region];
    if (regionVoices && regionVoices[gender]) {
      return regionVoices[gender];
    }
    
    // Default to Chuks's voice
    return this.defaultVoiceId;
  }

  // Generate audio buffer from text
  async generateAudio(text, region = 'Nigeria', gender = 'Male') {
    if (!this.enabled) {
      console.log('[ElevenLabs] Service disabled - returning null');
      return null;
    }

    const voiceId = this.getVoiceId(region, gender);
    
    console.log(`[ElevenLabs] 🎤 Generating audio...`);
    console.log(`[ElevenLabs]    Region: ${region}`);
    console.log(`[ElevenLabs]    Voice: ${voiceId}`);
    console.log(`[ElevenLabs]    Text: "${text.substring(0, 60)}..."`);
    
    try {
      const startTime = Date.now();
      
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': this.apiKey
          },
          body: JSON.stringify({
            text: text,
            model_id: 'eleven_turbo_v2_5', // ⚡ OPTIMIZED: Faster model (was eleven_monolingual_v1)
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              style: 0,
              use_speaker_boost: true
            },
            optimize_streaming_latency: 3, // ⚡ OPTIMIZED: Reduce latency (0-4, higher = faster)
            output_format: 'mp3_44100_128'  // ⚡ OPTIMIZED: Smaller file size (was default 192kbps)
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ElevenLabs] ❌ API error:', response.status, errorText);
        return null;
      }

      const audioBuffer = await response.arrayBuffer();
      const generationTime = Date.now() - startTime;
      
      console.log(`[ElevenLabs] ✅ Audio generated in ${generationTime}ms`);
      console.log(`[ElevenLabs]    Size: ${audioBuffer.byteLength} bytes`);
      
      return Buffer.from(audioBuffer);
      
    } catch (error) {
      console.error('[ElevenLabs] ❌ Error:', error.message);
      return null;
    }
  }

  // Check if service is ready
  isReady() {
    return this.enabled;
  }

  // Get available voices for region
  getAvailableVoices(region) {
    return this.voiceMap[region] || {};
  }
}

module.exports = ElevenLabsDynamicService;
