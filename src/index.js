require('dotenv').config();
const express = require('express');
const { webhookCallback } = require('grammy');
const bot = require('./bot/telegramBot');

// ============================================
// EXPRESS SERVER WITH WEBHOOK
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

// Webhook secret for security (optional but recommended)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'wildlife-bot-secret';

// Parse JSON bodies for webhook validation
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    bot: 'Wildlife ID Bot',
    mode: 'webhook',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: Math.floor(process.uptime()) });
});

// Telegram webhook endpoint with validation
app.post('/webhook', (req, res, next) => {
  // Validate that the request body contains a valid Telegram update
  if (!req.body || typeof req.body.update_id === 'undefined') {
    console.log('Invalid webhook request received (missing update_id)');
    return res.status(200).json({ ok: true, message: 'Invalid update ignored' });
  }
  next();
}, webhookCallback(bot, 'express'));

// Handle GET requests to /webhook (health checks, browser access)
app.get('/webhook', (req, res) => {
  res.json({ status: 'ok', message: 'Webhook endpoint active' });
});

// ============================================
// START SERVER & SETUP WEBHOOK
// ============================================
console.log('🦁 Starting Wildlife ID Bot (Webhook Mode)...');
console.log('🤖 Using Gemini 2.5 Pro / Flash models');

async function startServer() {
  // Start HTTP server first
  app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
  });

  // Setup webhook if WEBHOOK_URL is provided (for production)
  const webhookUrl = process.env.WEBHOOK_URL;
  
  if (webhookUrl) {
    try {
      // Delete any existing webhook first
      await bot.api.deleteWebhook();
      
      // Set new webhook
      await bot.api.setWebhook(`${webhookUrl}/webhook`, {
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
      });
      
      const botInfo = await bot.api.getMe();
      console.log(`✅ Bot started as @${botInfo.username}`);
      console.log(`🔗 Webhook set to: ${webhookUrl}/webhook`);
      console.log('📸 Ready to identify animals!');
    } catch (err) {
      console.error('❌ Failed to set webhook:', err.message);
    }
  } else {
    // Local development - use polling
    console.log('⚠️ No WEBHOOK_URL set - starting in polling mode for local dev');
    await bot.api.deleteWebhook();
    bot.start({
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    
    const botInfo = await bot.api.getMe();
    console.log(`✅ Bot started as @${botInfo.username} (polling mode)`);
  }
}

startServer();

// Graceful shutdown
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
