require('dotenv').config();
const { run } = require('@grammyjs/runner');
const bot = require('./bot/telegramBot');

console.log('🦁 Starting Wildlife ID Bot...');
console.log('🤖 Using Gemini 2.5 Pro / Flash models');
console.log('⚡ Parallel request handling enabled');

// Use runner for true concurrent/parallel request processing
const runner = run(bot);

// Get bot info and log startup
bot.api.getMe().then((botInfo) => {
  console.log(`✅ Bot started as @${botInfo.username}`);
  console.log('📸 Ready to identify animals!');
});

// Graceful shutdown
const stopRunner = () => runner.isRunning() && runner.stop();
process.once('SIGINT', stopRunner);
process.once('SIGTERM', stopRunner);
