const { Bot, InputFile } = require('grammy');
const { identifyAnimal } = require('../services/geminiService');
const { getSpeciesPhoto } = require('../services/inaturalistService');
const { createCompositeImage } = require('../services/imageService');
const { getEBirdSpeciesCode } = require('../services/ebirdService');
const { verifyWithGBIF } = require('../services/gbifService');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Set up bot commands menu
bot.api.setMyCommands([
  { command: 'start', description: '🦁 Welcome message' },
  { command: 'help', description: '📖 Show help' },
  { command: 'clear', description: '🗑️ Clear all chat messages' }
]);

// Store pending photos waiting for location
const pendingPhotos = new Map();

// Start command
bot.command('start', async (ctx) => {
  await ctx.reply(
    `🦁 *Wildlife ID Bot*\n\n` +
    `Send me a photo of any animal and I'll identify it!\n\n` +
    `Tap the menu button (/) to see commands`,
    { parse_mode: 'Markdown' }
  );
});

// Help command
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *How to use:*\n\n` +
    `1. Send a photo of an animal\n` +
    `2. Tell me where it was taken\n` +
    `3. Get detailed identification!\n\n`+
    { parse_mode: 'Markdown' }
  );
});

// Clear command - delete ALL messages in chat (parallel deletion)
bot.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const currentMsgId = ctx.message.message_id;
  
  // Delete the /clear command message
  try {
    await ctx.api.deleteMessage(chatId, currentMsgId);
  } catch (e) {}
  
  // Clear pending photos
  pendingPhotos.delete(ctx.from.id);
  
  // Delete last 200 messages in parallel (much faster)
  const deletePromises = [];
  for (let i = 1; i <= 200; i++) {
    const msgId = currentMsgId - i;
    if (msgId <= 0) break;
    deletePromises.push(
      ctx.api.deleteMessage(chatId, msgId).catch(() => {})
    );
  }
  
  await Promise.all(deletePromises);
  
  // Send confirmation (will auto-delete after 1.5 seconds)
  const confirmMsg = await ctx.reply('🗑️ Chat cleared');
  setTimeout(async () => {
    try {
      await ctx.api.deleteMessage(chatId, confirmMsg.message_id);
    } catch (e) {}
  }, 1500);
});

// Handle text messages (for location input)
bot.on('message:text', async (ctx) => {
  const pending = pendingPhotos.get(ctx.from.id);
  if (pending) {
    const location = ctx.message.text.trim();
    
    // Delete the location prompt message
    try {
      await ctx.api.deleteMessage(ctx.chat.id, pending.promptMsgId);
    } catch (e) {}
    // Delete user's location reply
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (e) {}
    
    pendingPhotos.delete(ctx.from.id);
    await processIdentification(ctx, pending.buffer, location);
  }
});

// Handle photos
bot.on('message:photo', async (ctx) => {
  try {
    // Get the largest photo
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];
    
    // Download image from Telegram
    const file = await ctx.api.getFile(largestPhoto.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Check if caption has location
    const caption = ctx.message.caption || '';
    const locationMatch = caption.match(/(?:in|from|at|near|@)\s*([A-Za-z\s,]+)/i);
    
    if (locationMatch || caption.length > 2) {
      // Caption has location - process immediately
      const location = locationMatch ? locationMatch[1].trim() : caption.trim();
      await processIdentification(ctx, buffer, location);
    } else {
      // No location in caption - ask user
      const promptMsg = await ctx.reply(
        `🌍 *Where was this photo taken?*\n\n` +
        `Reply with location or /skip`,
        { parse_mode: 'Markdown' }
      );
      
      // Store pending photo with prompt message ID
      pendingPhotos.set(ctx.from.id, { 
        buffer, 
        promptMsgId: promptMsg.message_id,
        timestamp: Date.now() 
      });
    }
    
  } catch (error) {
    console.error('Error receiving photo:', error);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});
// Process identification
async function processIdentification(ctx, buffer, location) {
  let statusMsg;
  
  try {
    // Simple status message
    statusMsg = await ctx.reply('🔬 *Analyzing...*', { parse_mode: 'Markdown' });

    // Step 1: Identify with Gemini 2.5 Pro
    console.log('\n🤖 Starting Gemini 2.5 Pro analysis...');
    const result = await identifyAnimal(buffer, 'image/jpeg', { location });
    
    if (!result.success || !result.data.identified) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      const reason = result.data?.reason || result.error || 'Could not identify';
      await ctx.reply(`❌ *Could not identify animal*\n\n${reason}`, { parse_mode: 'Markdown' });
      return;
    }
    
    const d = result.data;
    
    // Step 2: Verify with GBIF using location
    console.log('\n🌍 Verifying with GBIF...');
    const gbifResult = await verifyWithGBIF(d, location);
    
    // Add GBIF verification info to data for display
    d.gbifVerification = gbifResult;
    
    // Get iNaturalist reference photo (uses species only)
    console.log('\n📷 Getting iNaturalist reference photo...');
    const iNatPhoto = await getSpeciesPhoto(d.scientificName);
    
    // Delete status message
    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    
    // Generate links - use scientific name (genus + species only)
    const nameParts = d.scientificName.split(' ');
    const genusSpecies = `${nameParts[0]} ${nameParts[1] || ''}`.trim();
    const scientificNameUnderscore = genusSpecies.replace(/\s+/g, '_');
    const scientificNameHyphen = genusSpecies.toLowerCase().replace(/\s+/g, '-');
    
    // Wikipedia uses scientific name with underscores
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${scientificNameUnderscore}`;
    
    // iNaturalist - use taxa ID format: /taxa/5367-Gyps-himalayensis
    let iNaturalistUrl;
    const iNatNameHyphen = iNatPhoto.taxonName.replace(/\s+/g, '-');
    iNaturalistUrl = `https://www.inaturalist.org/taxa/${iNatPhoto.taxonId}-${iNatNameHyphen}`;
    
    // Check if it's a bird (class Aves)
    const isBird = d.taxonomy?.class?.toLowerCase() === 'aves';
    let birdLinks = '';
    if (isBird) {
      // eBird - get species code for direct link
      const eBirdData = await getEBirdSpeciesCode(d.scientificName);
      const eBirdUrl = eBirdData.found 
        ? `https://ebird.org/species/${eBirdData.speciesCode}`
        : `https://ebird.org/explore?q=${encodeURIComponent(genusSpecies)}`;
      // SingaporeBirds - uses hyphenated lowercase common name
      const commonNameHyphen = d.commonName.toLowerCase().replace(/\s+/g, '-');
      const sgBirdsUrl = `https://singaporebirds.com/species/${commonNameHyphen}/`;
      birdLinks = `\n[eBird](${eBirdUrl}) • [Singapore Birds](${sgBirdsUrl})`;
    }
    
    // Build caption with links
    const baseLinks = `[Wikipedia](${wikipediaUrl}) • [iNaturalist](${iNaturalistUrl})`;
    
    // Send composite image (photo left, text right with badges)
    if (iNatPhoto.found && iNatPhoto.photoUrl) {
      try {
        const compositeBuffer = await createCompositeImage(iNatPhoto.photoUrl, d);
        
        if (compositeBuffer) {
          const caption = `${baseLinks}${birdLinks}`;
          await ctx.replyWithPhoto(new InputFile(compositeBuffer, 'identification.jpg'), {
            caption: caption,
            parse_mode: 'Markdown'
          });
        } else {
          // Fallback to regular photo with caption
          const subspecies = d.taxonomy?.subspecies;
          const hasValidSubspecies = subspecies && 
            subspecies !== 'Not determined' && 
            subspecies !== 'Unable to determine from image' &&
            subspecies !== 'monotypic' &&
            !subspecies.toLowerCase().includes('unknown');
          const subspeciesText = hasValidSubspecies ? `\n\nSubspecies: _${subspecies}_` : '';
          const caption = `*${d.commonName}*\n_${d.scientificName}_${subspeciesText}\n\n${baseLinks}${birdLinks}`;
          await ctx.replyWithPhoto(iNatPhoto.photoUrl, { 
            caption: caption,
            parse_mode: 'Markdown'
          });
        }
      } catch (e) {
        console.log('Could not send composite image:', e.message);
        const subspecies = d.taxonomy?.subspecies;
        const hasValidSubspecies = subspecies && 
          subspecies !== 'Not determined' && 
          subspecies !== 'Unable to determine from image' &&
          subspecies !== 'monotypic' &&
          !subspecies.toLowerCase().includes('unknown');
        const subspeciesText = hasValidSubspecies ? `\n\nSubspecies: _${subspecies}_` : '';
        await ctx.reply(`*${d.commonName}*\n_${d.scientificName}_${subspeciesText}\n\n${baseLinks}${birdLinks}`, { parse_mode: 'Markdown' });
      }
    } else {
      // No photo available, send text only
      const subspecies = d.taxonomy?.subspecies;
      const hasValidSubspecies = subspecies && 
        subspecies !== 'Not determined' && 
        subspecies !== 'Unable to determine from image' &&
        subspecies !== 'monotypic' &&
        !subspecies.toLowerCase().includes('unknown');
      const subspeciesText = hasValidSubspecies ? `\n\nSubspecies: _${subspecies}_` : '';
      await ctx.reply(`*${d.commonName}*\n_${d.scientificName}_${subspeciesText}\n\n${baseLinks}${birdLinks}`, { parse_mode: 'Markdown' });
    }
    
  } catch (error) {
    console.error('Error:', error);
    try {
      if (statusMsg) await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    await ctx.reply(`❌ Error: ${error.message}`);
  }
}

// Handle errors
bot.catch((err) => {
  console.error('Bot error:', err);
});

module.exports = bot;
