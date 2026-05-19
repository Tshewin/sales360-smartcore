// ═══════════════════════════════════════════════════════════
// AUDIO SERVING ROUTE (for Railway Volume fallback)
// Add this to your server.js or call-routes.js
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');

function setupAudioRoutes(app, storageService) {
  // Serve audio files from Railway Volume (fallback storage)
  app.get('/audio/:filename', async (req, res) => {
    try {
      const filename = req.params.filename;
      const filepath = storageService.getAudioPath(filename);
      
      // Check if file exists
      if (!fs.existsSync(filepath)) {
        console.error('[Audio Server] ❌ File not found:', filename);
        return res.status(404).json({ error: 'Audio file not found' });
      }
      
      console.log('[Audio Server] 📤 Serving audio:', filename);
      
      // Set headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      
      // Stream file
      const stream = fs.createReadStream(filepath);
      stream.pipe(res);
      
      stream.on('error', (error) => {
        console.error('[Audio Server] ❌ Stream error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve audio' });
        }
      });
      
    } catch (error) {
      console.error('[Audio Server] ❌ Error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  // Storage health check endpoint
  app.get('/storage/health', async (req, res) => {
    try {
      const health = await storageService.healthCheck();
      res.json({
        status: 'ok',
        storage: health
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error.message
      });
    }
  });
  
  // Storage stats endpoint (for monitoring)
  app.get('/storage/stats', (req, res) => {
    const stats = storageService.getStats();
    res.json({
      status: 'ok',
      stats: stats
    });
  });
  
  console.log('[Audio Server] ✅ Audio serving routes mounted');
}

// ═══════════════════════════════════════════════════════════
// BACKGROUND CLEANUP TASK
// ═══════════════════════════════════════════════════════════
function startCleanupTask(storageService) {
  // Run cleanup every 30 minutes
  setInterval(async () => {
    console.log('[Storage] 🧹 Running scheduled cleanup...');
    await storageService.cleanupOldFiles(60); // Delete files older than 1 hour
  }, 30 * 60 * 1000); // 30 minutes
  
  console.log('[Storage] ✅ Cleanup task scheduled (every 30 minutes)');
}

module.exports = { setupAudioRoutes, startCleanupTask };
