require('dotenv').config();
const { run, sequentialize } = require('@grammyjs/runner');
const bot = require('./bot/telegramBot');

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
});

// Graceful shutdown
const stopRunner = () => runner.isRunning() && runner.stop();
process.once('SIGINT', stopRunner);
process.once('SIGTERM', stopRunner);
