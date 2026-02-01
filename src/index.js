require('dotenv').config();
const bot = require('./bot/telegramBot');

console.log('🦁 Starting Wildlife ID Bot...');
console.log('🤖 Using Gemini 2.5 Pro / Flash models');

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Bot started as @${botInfo.username}`);
    console.log('📸 Ready to identify animals!');
  },
});
