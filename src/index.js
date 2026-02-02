require('dotenv').config();
const express = require('express');
const { run } = require('@grammyjs/runner');
const bot = require('./bot/telegramBot');

// ============================================
// EXPRESS SERVER - Keeps Azure App Alive 24/7
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint - Azure pings this to keep app alive
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    bot: 'Wildlife ID Bot',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: Math.floor(process.uptime()) });
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

// ============================================
// TELEGRAM BOT - Parallel Processing
// ============================================
console.log('🦁 Starting Wildlife ID Bot...');
console.log('🤖 Using Gemini 2.5 Pro / Flash models');
console.log('⚡ Parallel request handling enabled');

// Use runner for true concurrent/parallel request processing
// Each update is processed independently - no blocking between users
const runner = run(bot, {
  // Process updates concurrently (not sequentially)
  fetcher: {
    // Allow multiple updates to be fetched at once
    allowedUpdates: ['message', 'callback_query']
  },
  // No sequential constraints - full parallel processing
  runner: {
    fetch: {
      // Fetch multiple updates
      limit: 100
    }
  }
});

// Get bot info and log startup
bot.api.getMe().then((botInfo) => {
  console.log(`✅ Bot started as @${botInfo.username}`);
  console.log('📸 Ready to identify animals!');
  console.log('🔄 Processing requests in parallel - no blocking!');
}).catch(err => {
  console.error('❌ Failed to start bot:', err.message);
});

// Graceful shutdown
const stopRunner = () => runner.isRunning() && runner.stop();
process.once('SIGINT', stopRunner);
process.once('SIGTERM', stopRunner);
