// ═══════════════════════════════════════════════════════════
// SALES360 STORAGE SERVICE - PRODUCTION GRADE WITH FALLBACK
// Primary: Cloudflare R2 → Fallback 1: Railway Volume → Fallback 2: Direct Stream
// ═══════════════════════════════════════════════════════════

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

class StorageService {
  constructor() {
    // R2 Configuration (Primary)
    this.r2AccountId = process.env.R2_ACCOUNT_ID;
    this.r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
    this.r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.r2BucketName = process.env.R2_BUCKET_NAME;
    this.r2PublicUrl = process.env.R2_PUBLIC_URL;
    
    // Railway Volume Configuration (Fallback 1)
    this.volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
    this.volumeAudioPath = path.join(this.volumePath, 'audio');
    
    // Initialize R2 Client
    if (this.r2AccountId && this.r2AccessKeyId && this.r2SecretAccessKey) {
      this.r2Client = new S3Client({
        region: 'auto',
        endpoint: `https://${this.r2AccountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.r2AccessKeyId,
          secretAccessKey: this.r2SecretAccessKey,
        },
      });
      console.log('[Storage] ✅ R2 client initialized (Primary)');
    } else {
      console.warn('[Storage] ⚠️  R2 not configured, will use fallback storage');
      this.r2Client = null;
    }
    
    // Initialize Railway Volume
    this._initializeVolume();
    
    // Storage stats (for monitoring)
    this.stats = {
      r2_success: 0,
      r2_failures: 0,
      volume_success: 0,
      volume_failures: 0,
      direct_stream: 0,
      total_requests: 0
    };
  }

  _initializeVolume() {
    try {
      if (!fs.existsSync(this.volumePath)) {
        console.warn('[Storage] ⚠️  Volume path does not exist, fallback to /tmp');
        this.volumePath = '/tmp';
        this.volumeAudioPath = path.join(this.volumePath, 'audio');
      }
      
      if (!fs.existsSync(this.volumeAudioPath)) {
        fs.mkdirSync(this.volumeAudioPath, { recursive: true });
        console.log('[Storage] ✅ Created audio directory:', this.volumeAudioPath);
      }
      
      console.log('[Storage] ✅ Railway Volume initialized (Fallback)');
    } catch (error) {
      console.error('[Storage] ❌ Volume initialization failed:', error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SMART UPLOAD WITH AUTOMATIC FALLBACK
  // ═══════════════════════════════════════════════════════════
  async uploadAudio(buffer, filename) {
    this.stats.total_requests++;
    const startTime = Date.now();
    
    console.log('[Storage] 📤 Smart upload starting...');
    console.log('[Storage]    File:', filename);
    console.log('[Storage]    Size:', buffer.length, 'bytes');
    
    // ═══════════════════════════════════════════════════════════
    // ATTEMPT 1: Cloudflare R2 (Primary - Fast CDN)
    // ═══════════════════════════════════════════════════════════
    if (this.r2Client) {
      try {
        console.log('[Storage] 🔵 Attempting R2 upload (Primary)...');
        const url = await this._uploadToR2(buffer, filename);
        const elapsed = Date.now() - startTime;
        
        this.stats.r2_success++;
        console.log(`[Storage] ✅ R2 SUCCESS in ${elapsed}ms`);
        console.log('[Storage]    URL:', url);
        
        return {
          success: true,
          url: url,
          provider: 'r2',
          elapsed: elapsed,
          fallback_used: false
        };
      } catch (error) {
        this.stats.r2_failures++;
        console.warn('[Storage] ⚠️  R2 upload failed:', error.message);
        console.log('[Storage] 🔄 Falling back to Railway Volume...');
        // Continue to fallback
      }
    } else {
      console.log('[Storage] ⏭️  R2 not configured, skipping to fallback');
    }
    
    // ═══════════════════════════════════════════════════════════
    // ATTEMPT 2: Railway Volume (Fallback 1 - Local Disk)
    // ═══════════════════════════════════════════════════════════
    try {
      console.log('[Storage] 🟡 Attempting Volume upload (Fallback 1)...');
      const url = await this._uploadToVolume(buffer, filename);
      const elapsed = Date.now() - startTime;
      
      this.stats.volume_success++;
      console.log(`[Storage] ✅ VOLUME SUCCESS in ${elapsed}ms`);
      console.log('[Storage]    URL:', url);
      
      return {
        success: true,
        url: url,
        provider: 'volume',
        elapsed: elapsed,
        fallback_used: true
      };
    } catch (error) {
      this.stats.volume_failures++;
      console.warn('[Storage] ⚠️  Volume upload failed:', error.message);
      console.log('[Storage] 🔄 Falling back to direct stream...');
      // Continue to final fallback
    }
    
    // ═══════════════════════════════════════════════════════════
    // ATTEMPT 3: Direct Stream (Fallback 2 - No Storage)
    // ═══════════════════════════════════════════════════════════
    try {
      console.log('[Storage] 🟠 Using direct stream (Fallback 2 - No Storage)');
      const base64Audio = buffer.toString('base64');
      const elapsed = Date.now() - startTime;
      
      this.stats.direct_stream++;
      console.log(`[Storage] ✅ DIRECT STREAM in ${elapsed}ms`);
      
      return {
        success: true,
        url: `data:audio/mpeg;base64,${base64Audio}`,
        provider: 'direct_stream',
        elapsed: elapsed,
        fallback_used: true,
        warning: 'Using direct stream - audio not persisted'
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error('[Storage] ❌ ALL STORAGE METHODS FAILED:', error.message);
      
      return {
        success: false,
        error: error.message,
        elapsed: elapsed,
        fallback_used: true
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // R2 UPLOAD (Primary)
  // ═══════════════════════════════════════════════════════════
  async _uploadToR2(buffer, filename) {
    const key = `audio/${filename}`;
    
    const command = new PutObjectCommand({
      Bucket: this.r2BucketName,
      Key: key,
      Body: buffer,
      ContentType: 'audio/mpeg',
    });

    await this.r2Client.send(command);
    
    return `${this.r2PublicUrl}/${key}`;
  }

  // ═══════════════════════════════════════════════════════════
  // RAILWAY VOLUME UPLOAD (Fallback 1)
  // ═══════════════════════════════════════════════════════════
  async _uploadToVolume(buffer, filename) {
    const filepath = path.join(this.volumeAudioPath, filename);
    
    // Write file to volume
    await fs.promises.writeFile(filepath, buffer);
    
    // Return URL that will be served by Express
    const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:8080';
    return `${baseUrl}/audio/${filename}`;
  }

  // ═══════════════════════════════════════════════════════════
  // SERVE AUDIO FROM VOLUME (for fallback URLs)
  // ═══════════════════════════════════════════════════════════
  getAudioPath(filename) {
    return path.join(this.volumeAudioPath, filename);
  }

  // ═══════════════════════════════════════════════════════════
  // CLEANUP OLD FILES (prevent disk full)
  // ═══════════════════════════════════════════════════════════
  async cleanupOldFiles(maxAgeMinutes = 60) {
    try {
      const files = await fs.promises.readdir(this.volumeAudioPath);
      const now = Date.now();
      let deletedCount = 0;
      
      for (const file of files) {
        const filepath = path.join(this.volumeAudioPath, file);
        const stats = await fs.promises.stat(filepath);
        const ageMinutes = (now - stats.mtimeMs) / 1000 / 60;
        
        if (ageMinutes > maxAgeMinutes) {
          await fs.promises.unlink(filepath);
          deletedCount++;
        }
      }
      
      if (deletedCount > 0) {
        console.log(`[Storage] 🧹 Cleaned up ${deletedCount} old files`);
      }
    } catch (error) {
      console.error('[Storage] ❌ Cleanup error:', error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STORAGE HEALTH CHECK
  // ═══════════════════════════════════════════════════════════
  async healthCheck() {
    const health = {
      r2: { available: false, latency: null },
      volume: { available: false, latency: null },
      stats: this.stats
    };
    
    // Test R2
    if (this.r2Client) {
      try {
        const start = Date.now();
        const testBuffer = Buffer.from('health-check');
        await this._uploadToR2(testBuffer, `health-check-${Date.now()}.txt`);
        health.r2.available = true;
        health.r2.latency = Date.now() - start;
      } catch (error) {
        health.r2.error = error.message;
      }
    }
    
    // Test Volume
    try {
      const start = Date.now();
      const testBuffer = Buffer.from('health-check');
      await this._uploadToVolume(testBuffer, `health-check-${Date.now()}.txt`);
      health.volume.available = true;
      health.volume.latency = Date.now() - start;
    } catch (error) {
      health.volume.error = error.message;
    }
    
    return health;
  }

  // ═══════════════════════════════════════════════════════════
  // GET STORAGE STATS (for monitoring)
  // ═══════════════════════════════════════════════════════════
  getStats() {
    const total = this.stats.total_requests;
    
    return {
      ...this.stats,
      r2_success_rate: total > 0 ? (this.stats.r2_success / total * 100).toFixed(1) + '%' : '0%',
      fallback_rate: total > 0 ? ((this.stats.volume_success + this.stats.direct_stream) / total * 100).toFixed(1) + '%' : '0%'
    };
  }
}

module.exports = StorageService;
