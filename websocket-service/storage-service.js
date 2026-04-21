// ═══════════════════════════════════════════════════════════
// SALES360 AUDIO STORAGE SERVICE
// Uploads temporary audio files for Twilio <Play>
// Supports: Cloudflare R2, AWS S3
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');

class StorageService {
  constructor() {
    // Check which storage provider is configured
    this.provider = process.env.AUDIO_STORAGE_PROVIDER || 'r2'; // 'r2' or 's3'
    
    // Cloudflare R2 credentials
    this.r2AccountId = process.env.R2_ACCOUNT_ID;
    this.r2AccessKey = process.env.R2_ACCESS_KEY_ID;
    this.r2SecretKey = process.env.R2_SECRET_ACCESS_KEY;
    this.r2BucketName = process.env.R2_BUCKET_NAME || 'sales360-audio';
    this.r2PublicUrl = process.env.R2_PUBLIC_URL; // e.g., https://audio.sales360-ai.com
    
    // AWS S3 credentials (fallback)
    this.s3Region = process.env.AWS_REGION || 'us-east-1';
    this.s3AccessKey = process.env.AWS_ACCESS_KEY_ID;
    this.s3SecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    this.s3BucketName = process.env.S3_BUCKET_NAME || 'sales360-audio';
    
    this.enabled = false;
    
    if (this.provider === 'r2' && this.r2AccountId && this.r2AccessKey) {
      console.log('[Storage] ✅ Cloudflare R2 configured');
      console.log('[Storage]    Bucket:', this.r2BucketName);
      this.enabled = true;
    } else if (this.provider === 's3' && this.s3AccessKey) {
      console.log('[Storage] ✅ AWS S3 configured');
      console.log('[Storage]    Bucket:', this.s3BucketName);
      this.enabled = true;
    } else {
      console.warn('[Storage] ⚠️  No storage provider configured');
    }
  }

  // Upload audio buffer and return public URL
  async uploadAudio(audioBuffer, callSid) {
    if (!this.enabled) {
      console.log('[Storage] Disabled - returning data URI fallback');
      return this._createDataUri(audioBuffer);
    }

    try {
      const filename = this._generateFilename(callSid);
      
      console.log(`[Storage] 📤 Uploading audio...`);
      console.log(`[Storage]    Provider: ${this.provider}`);
      console.log(`[Storage]    File: ${filename}`);
      console.log(`[Storage]    Size: ${audioBuffer.byteLength} bytes`);
      
      if (this.provider === 'r2') {
        return await this._uploadToR2(audioBuffer, filename);
      } else if (this.provider === 's3') {
        return await this._uploadToS3(audioBuffer, filename);
      }
      
      // Fallback to data URI
      return this._createDataUri(audioBuffer);
      
    } catch (error) {
      console.error('[Storage] ❌ Upload failed:', error.message);
      // Fallback to data URI
      return this._createDataUri(audioBuffer);
    }
  }

  // Upload to Cloudflare R2
  async _uploadToR2(audioBuffer, filename) {
    const endpoint = `https://${this.r2AccountId}.r2.cloudflarestorage.com`;
    const url = `${endpoint}/${this.r2BucketName}/${filename}`;
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.byteLength.toString()
      },
      body: audioBuffer
    });

    if (!response.ok) {
      throw new Error(`R2 upload failed: ${response.status}`);
    }

    const publicUrl = this.r2PublicUrl 
      ? `${this.r2PublicUrl}/${filename}`
      : `${endpoint}/${this.r2BucketName}/${filename}`;
    
    console.log('[Storage] ✅ Uploaded to R2:', publicUrl);
    
    return publicUrl;
  }

  // Upload to AWS S3
  async _uploadToS3(audioBuffer, filename) {
    // For now, return data URI
    // Full S3 SDK integration can be added later if needed
    console.log('[Storage] S3 upload not implemented yet, using data URI');
    return this._createDataUri(audioBuffer);
  }

  // Generate unique filename
  _generateFilename(callSid) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `audio/${callSid}-${timestamp}-${random}.mp3`;
  }

  // Create data URI as fallback (embeds audio in TwiML)
  _createDataUri(audioBuffer) {
    const base64 = audioBuffer.toString('base64');
    return `data:audio/mpeg;base64,${base64}`;
  }

  // Check if service is ready
  isReady() {
    return this.enabled;
  }

  // Clean up old files (optional - can be called periodically)
  async cleanupOldFiles(olderThanHours = 24) {
    // Implementation depends on provider
    // For now, we'll rely on bucket lifecycle policies
    console.log('[Storage] Cleanup not implemented - use bucket lifecycle policies');
  }
}

module.exports = StorageService;
