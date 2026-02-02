const { Bot, InputFile, InlineKeyboard } = require('grammy');
const ExifParser = require('exif-parser');
const sharp = require('sharp');
const { identifyAnimal } = require('../services/geminiService');
const { getSpeciesPhoto } = require('../services/inaturalistService');
const { createCompositeImage } = require('../services/imageService');
const { getEBirdSpeciesCode, verifyWithEBird } = require('../services/ebirdService');
const { verifyWithGBIF } = require('../services/gbifService');

// Helper function to check if a URL returns a valid page (not an error page)
async function isValidUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await fetch(url, { 
      method: 'GET', 
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WildlifeBot/1.0)'
      }
    });
    clearTimeout(timeout);
    
    // Check for success status
    if (!response.ok) return false;
    
    // Get HTML content to check for error pages
    const html = await response.text();
    const htmlLower = html.toLowerCase();
    
    // Check for common error page indicators
    const errorIndicators = [
      'page not found',
      '404',
      'not found',
      'does not exist',
      'no results',
      'no species found',
      'species not found',
      'we couldn\'t find',
      'sorry, we couldn\'t',
      'no matching',
      'error page'
    ];
    
    // Check title for errors
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].toLowerCase() : '';
    
    // If title contains error indicators, it's likely an error page
    if (errorIndicators.some(indicator => title.includes(indicator))) {
      return false;
    }
    
    // For Wikipedia, check if it's a search/disambiguation page
    if (url.includes('wikipedia.org')) {
      if (response.url.includes('search') || 
          htmlLower.includes('wikipedia does not have an article') ||
          htmlLower.includes('search results')) {
        return false;
      }
    }
    
    // For Singapore Birds, check if species page exists
    if (url.includes('singaporebirds.com')) {
      if (htmlLower.includes('page not found') || 
          htmlLower.includes('no species') ||
          !htmlLower.includes('<article')) {
        return false;
      }
    }
    
    // For eBird, check if species exists
    if (url.includes('ebird.org/species')) {
      if (htmlLower.includes('species not found') ||
          htmlLower.includes('no results')) {
        return false;
      }
    }
    
    return true;
  } catch (e) {
    console.log(`   URL check failed for ${url}: ${e.message}`);
    return false;
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Error handler middleware
bot.catch((err) => {
  console.error('Bot error:', err.message);
});

// Bot commands list
const botCommands = [
  { command: 'start', description: '🦁 Welcome message' },
  { command: 'help', description: '📖 Show help' },
  { command: 'identify', description: '📷 How to identify animals' },
  { command: 'clear', description: '🗑️ Clear all chat messages' }
];

// Set up bot commands menu for all scopes (private chats, groups, etc.)
Promise.all([
  // Default scope (private chats)
  bot.api.setMyCommands(botCommands),
  // All group chats
  bot.api.setMyCommands(botCommands, { scope: { type: 'all_group_chats' } }),
  // All private chats
  bot.api.setMyCommands(botCommands, { scope: { type: 'all_private_chats' } }),
  // Set chat menu button to show commands
  bot.api.setChatMenuButton({ menu_button: { type: 'commands' } })
]).catch(err => console.error('Failed to set commands:', err));

// Store pending photos waiting for location (keyed by uniqueId = odels
const pendingPhotos = new Map();

// Start command
bot.command('start', async (ctx) => {
  console.log(`📩 /start command received from user ${ctx.from.id}`);
  try {
    await ctx.reply(
      `🦁 *Wildlife ID Bot*\n\n` +
      `Send me a photo of any animal and I'll identify it!\n\n` +
      `📷 Just send a photo - no commands needed!\n\n` +
      `Tap the menu button ☰ to see all commands`,
      { parse_mode: 'Markdown' }
    );
    console.log(`✅ /start reply sent successfully`);
  } catch (err) {
    console.error(`❌ /start reply failed:`, err.message);
  }
});

// Identify command - show how to use
bot.command('identify', async (ctx) => {
  console.log(`📩 /identify command received from user ${ctx.from.id}`);
  await ctx.reply(
    `📷 *How to Identify Animals:*\n\n` +
    `1️⃣ Send a photo of an animal\n` +
    `2️⃣ Tell me the location (or I'll use GPS from photo)\n` +
    `3️⃣ Get detailed identification!\n\n` +
    `_Just send a photo to get started!_`,
    { parse_mode: 'Markdown' }
  );
});

// Help command
bot.command('help', async (ctx) => {
  console.log(`📩 /help command received from user ${ctx.from.id}`);
  await ctx.reply(
    `📖 *How to use:*\n\n` +
    `1. Send a photo of an animal\n` +
    `2. Tell me where it was taken\n` +
    `3. Get detailed identification!`,
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

// Store last identification results for detail requests (keyed by scientific name so anyone can access)
const lastIdentifications = new Map();

// Track which users have received the HD image for each species (to avoid sending twice)
// Key: `${scientificName}_${userId}`, Value: true
const userReceivedImage = new Map();

// Handle callback queries (button clicks)
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith('details_')) {
    const scientificName = data.replace('details_', '').replace(/_/g, ' ');
    const tappedByUserId = ctx.from.id;  // The user who tapped the button
    const lastResult = lastIdentifications.get(scientificName);  // Look up by scientific name
    
    if (lastResult) {
      const d = lastResult;
      
      // Build detailed information message
      let detailsMsg = `📚 *Detailed Information*\n\n`;
      detailsMsg += `*${d.commonName}*\n`;
      detailsMsg += `_${d.scientificName}_\n\n`;
      
      // Taxonomy
      detailsMsg += `🏷️ *Taxonomy:*\n`;
      if (d.taxonomy) {
        if (d.taxonomy.order) detailsMsg += `Order: ${d.taxonomy.order}\n`;
        if (d.taxonomy.family) detailsMsg += `Family: ${d.taxonomy.family}\n`;
        if (d.taxonomy.subfamily) detailsMsg += `Subfamily: ${d.taxonomy.subfamily}\n`;
        if (d.taxonomy.genus) detailsMsg += `Genus: _${d.taxonomy.genus}_\n`;
      }
      detailsMsg += `\n`;
      
      // Description
      if (d.description) {
        detailsMsg += `📝 *Description:*\n${d.description}\n\n`;
      }
      
      // Geographic range
      if (d.geographicRange) {
        detailsMsg += `🌍 *Range:*\n${d.geographicRange}\n\n`;
      }
      
      // Conservation status with colored icons
      const getIucnCode = (status) => {
        if (!status) return null;
        const s = status.toUpperCase();
        if (s.includes('LC') || s.includes('LEAST CONCERN')) return 'LC';
        if (s.includes('NT') || s.includes('NEAR THREATENED')) return 'NT';
        if (s.includes('VU') || s.includes('VULNERABLE')) return 'VU';
        if (s.includes('EN') && !s.includes('EXTINCT')) return 'EN';
        if (s.includes('CR') || s.includes('CRITICALLY')) return 'CR';
        if (s.includes('EW') || s.includes('EXTINCT IN WILD')) return 'EW';
        if (s.includes('EX') || s.includes('EXTINCT')) return 'EX';
        if (s.includes('DD') || s.includes('DATA DEFICIENT')) return 'DD';
        if (s.includes('NE') || s.includes('NOT EVALUATED')) return 'NE';
        return null;
      };
      
      const getIucnDisplay = (code) => {
        // Returns colored block + icon + full name - each status distinctly colored
        const display = {
          'EX': { icon: '⬛💀', name: 'Extinct' },
          'EW': { icon: '⬛☠️', name: 'Extinct in the Wild' },
          'CR': { icon: '🟥🔴', name: 'Critically Endangered' },
          'EN': { icon: '🟧🟠', name: 'Endangered' },
          'VU': { icon: '🟨🟡', name: 'Vulnerable' },
          'NT': { icon: '🟩🟢', name: 'Near Threatened' },
          'LC': { icon: '🟢✅', name: 'Least Concern' },
          'DD': { icon: '⬜❓', name: 'Data Deficient' },
          'NE': { icon: '⚪', name: 'Not Evaluated' }
        };
        return display[code] || { icon: '⚪', name: 'Unknown' };
      };
      
      const iucn = d.iucnStatus;
      const globalStatus = iucn?.global || d.conservationStatus;
      const globalCode = getIucnCode(globalStatus);
      
      detailsMsg += `🛡️ *Conservation Status:*\n\n`;
      detailsMsg += `*Global (IUCN Red List):*\n`;
      if (globalCode) {
        const display = getIucnDisplay(globalCode);
        detailsMsg += `${display.icon} ${display.name} (IUCN 3.1)\n\n`;
      } else {
        detailsMsg += `⚪ Not Evaluated\n\n`;
      }
      
      // Local status
      detailsMsg += `*Local Status:*\n`;
      if (iucn && iucn.local && iucn.local !== 'null') {
        const localCode = getIucnCode(iucn.local);
        if (localCode) {
          const display = getIucnDisplay(localCode);
          detailsMsg += `${display.icon} ${display.name}\n\n`;
        } else {
          detailsMsg += `${iucn.local}\n\n`;
        }
      } else {
        detailsMsg += `⚪ Not assessed\n\n`;
      }
      
      // Check if user already received the image (via Similar Species)
      const imageKey = `${scientificName}_${tappedByUserId}`;
      const alreadyReceivedImage = userReceivedImage.get(imageKey);
      
      // Always PM to user (send with original image only if not already sent)
      try {
        let hdBuffer = null;
        if (!alreadyReceivedImage && d._originalImageBuffer) {
          console.log(`   🖼️ Processing HD image (${d._originalImageBuffer.length} bytes)...`);
          // Process image: Full size, natural orientation, high quality JPEG for Telegram
          hdBuffer = await sharp(d._originalImageBuffer)
            .rotate()  // Auto-rotate to natural orientation
            .withMetadata()  // Preserve metadata
            .jpeg({
              quality: 100,  // Maximum quality - no loss
              chromaSubsampling: '4:4:4',  // Best color quality
              force: false
            })
            .toBuffer();
        }
        
        // Always PM the user
        try {
          if (hdBuffer) {
            await ctx.api.sendPhoto(tappedByUserId, new InputFile(hdBuffer, 'photo_hd.jpg'));
            userReceivedImage.set(imageKey, true);
          }
          await ctx.api.sendMessage(tappedByUserId, detailsMsg, { parse_mode: 'Markdown' });
          await ctx.answerCallbackQuery({ text: '📬 Details sent to PM!' });
        } catch (pmError) {
          // Can't PM - user hasn't started chat with bot
          console.log('Cannot PM user:', pmError.message);
          const botInfo = await ctx.api.getMe();
          await ctx.answerCallbackQuery({ 
            text: `⚠️ Please start a chat with @${botInfo.username} first, then tap again.`,
            show_alert: true 
          });
        }
      } catch (e) {
        console.log('Error sending details:', e.message);
        await ctx.answerCallbackQuery({ text: '❌ Error sending details' });
      }
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Data expired. Please identify again.' });
    }
  }
  
  // Handle "Similar Species" button click
  if (data.startsWith('similar_')) {
    const scientificName = data.replace('similar_', '').replace(/_/g, ' ');
    const tappedByUserId = ctx.from.id;  // The user who tapped the button
    const lastResult = lastIdentifications.get(scientificName);  // Look up by scientific name
    
    if (lastResult) {
      const similarSpecies = lastResult.similarSpeciesRuledOut || [];
      
      if (similarSpecies.length > 0) {
        // Build message with similar species list
        let similarMsg = `🔍 *Similar Species Considered:*\n\n`;
        
        similarSpecies.slice(0, 5).forEach((species, index) => {
          let speciesInfo;
          if (typeof species === 'string') {
            speciesInfo = species;
          } else if (typeof species === 'object' && species !== null) {
            const name = species.name || species.species || species.commonName || '';
            const reason = species.reason || '';
            speciesInfo = reason ? `${name} - ${reason}` : name;
          } else {
            speciesInfo = String(species);
          }
          similarMsg += `${index + 1}. ${speciesInfo}\n\n`;
        });
        
        // Check if user already received the image (via More Details)
        const imageKey = `${scientificName}_${tappedByUserId}`;
        const alreadyReceivedImage = userReceivedImage.get(imageKey);
        
        // Always PM to user (send with original image only if not already sent)
        try {
          let hdBuffer = null;
          if (!alreadyReceivedImage && lastResult._originalImageBuffer) {
            console.log(`   🖼️ Processing HD image (${lastResult._originalImageBuffer.length} bytes)...`);
            // Process image: Full size, natural orientation, high quality
            hdBuffer = await sharp(lastResult._originalImageBuffer)
              .rotate()  // Auto-rotate to natural orientation
              .withMetadata()  // Preserve metadata
              .jpeg({
                quality: 100,  // Maximum quality - no loss
                chromaSubsampling: '4:4:4',  // Best color quality
                force: false
              })
              .toBuffer();
          }
          
          // Always PM the user
          try {
            if (hdBuffer) {
              await ctx.api.sendPhoto(tappedByUserId, new InputFile(hdBuffer, 'photo_hd.jpg'));
              userReceivedImage.set(imageKey, true);
            }
            await ctx.api.sendMessage(tappedByUserId, similarMsg, { parse_mode: 'Markdown' });
            await ctx.answerCallbackQuery({ text: '📬 Similar species sent to PM!' });
          } catch (pmError) {
            // Can't PM - user hasn't started chat with bot
            console.log('Cannot PM user:', pmError.message);
            const botInfo = await ctx.api.getMe();
            await ctx.answerCallbackQuery({ 
              text: `⚠️ Please start a chat with @${botInfo.username} first, then tap again.`,
              show_alert: true 
            });
          }
        } catch (e) {
          console.log('Error sending similar species:', e.message);
          await ctx.answerCallbackQuery({ text: '❌ Error sending similar species' });
        }
      } else {
        await ctx.answerCallbackQuery({ text: 'No similar species data available' });
      }
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Data expired. Please identify again.' });
    }
  }
});

// Handle photos - runs in parallel for multiple users
bot.on('message:photo', async (ctx) => {
  // Process each photo request independently (non-blocking)
  handlePhotoMessage(ctx).catch(err => {
    console.error('Photo handler error:', err);
    ctx.reply(`❌ Error: ${err.message}`).catch(() => {});
  });
});

// Separate async function for photo processing
async function handlePhotoMessage(ctx) {
  // Get the largest photo (highest resolution)
  const photos = ctx.message.photo;
  const largestPhoto = photos[photos.length - 1];
  
  // Download image from Telegram
  const file = await ctx.api.getFile(largestPhoto.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  
  const response = await fetch(fileUrl);
  let buffer = Buffer.from(await response.arrayBuffer());
  
  // Extract EXIF GPS coordinates BEFORE any image processing (from original buffer)
  let exifLocation = null;
  try {
    const parser = ExifParser.create(buffer);
    const exifData = parser.parse();
    if (exifData.tags && exifData.tags.GPSLatitude && exifData.tags.GPSLongitude) {
      const lat = exifData.tags.GPSLatitude;
      const lng = exifData.tags.GPSLongitude;
      exifLocation = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      console.log(`📍 Found EXIF GPS: ${exifLocation}`);
    }
  } catch (e) {
    // No EXIF data or parsing failed - ignore
  }
  
  // Process image for analysis: Full size, natural orientation, HD/HQ, no quality loss
  // Use PNG format internally to preserve full quality (lossless)
  buffer = await sharp(buffer)
    .rotate()  // Auto-rotate to natural orientation based on EXIF
    .withMetadata()  // Preserve all metadata
    .png({  // Use PNG for lossless quality
      compressionLevel: 0,  // No compression for fastest processing
      effort: 1  // Minimal effort for speed
    })
    .toBuffer();
  
  console.log(`📷 Image processed: Full size, natural orientation, lossless quality`);
  
  if (exifLocation) {
    // Image has GPS coordinates - process immediately
    console.log(`📍 Using EXIF location: ${exifLocation}`);
    await processIdentification(ctx, buffer, exifLocation);
  } else {
    // No EXIF GPS - always ask for location (ignore caption)
    console.log(`📍 No EXIF GPS found, asking user for location...`);
    const promptMsg = await ctx.reply(
      `🌍 *Where was this photo taken?*\n\n` +
      `Reply with location or /skip`,
      { parse_mode: 'Markdown' }
    );
    console.log(`📍 Location prompt sent, message ID: ${promptMsg.message_id}`);
    
    // Store pending photo with prompt message ID
    pendingPhotos.set(ctx.from.id, { 
      buffer, 
      promptMsgId: promptMsg.message_id,
      timestamp: Date.now() 
    });
  }
}

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
    
    // Store original image buffer for later PM
    d._originalImageBuffer = buffer;
    
    // Check if it's a bird (class Aves)
    const isBird = d.taxonomy?.class?.toLowerCase() === 'aves';
    
    // Step 2: Verify with GBIF using location
    console.log('\n🌍 Verifying with GBIF...');
    console.log(`   📍 Location from user: "${location}"`);
    const gbifResult = await verifyWithGBIF(d, location);
    
    // Use GBIF species name if different from Gemini (GBIF takes priority)
    // This handles taxonomic revisions and synonym updates
    if (gbifResult.verified) {
      if (gbifResult.species?.isSynonym && gbifResult.species?.acceptedName) {
        console.log(`   🔄 Name updated (was synonym): ${d.scientificName} → ${gbifResult.species.acceptedName}`);
        d.scientificName = gbifResult.species.canonicalName || gbifResult.species.acceptedName;
        if (gbifResult.species.commonName) {
          d.commonName = gbifResult.species.commonName;
          console.log(`   🔄 Common name updated: ${d.commonName}`);
        }
      } else if (!gbifResult.matches && gbifResult.gbifName) {
        console.log(`   📝 Using GBIF species: ${gbifResult.gbifName} (Gemini said: ${d.scientificName})`);
        d.scientificName = gbifResult.species?.canonicalName || gbifResult.gbifName;
      }
    }
    
    // Step 3: If bird, also verify with eBird (eBird has most current bird taxonomy)
    if (isBird) {
      console.log('\n🐦 Verifying bird with eBird...');
      // Pass both scientific name and common name for better synonym resolution
      const eBirdResult = await verifyWithEBird(d.scientificName, d.commonName);
      
      // Use eBird species name - eBird taxonomy is authoritative for birds
      if (eBirdResult.verified && eBirdResult.found) {
        if (!eBirdResult.matches || eBirdResult.scientificName !== d.scientificName) {
          console.log(`   🔄 eBird name update: ${d.scientificName} → ${eBirdResult.scientificName}`);
          if (eBirdResult.nameUpdatedReason) {
            console.log(`   📝 Reason: ${eBirdResult.nameUpdatedReason}`);
          }
        }
        d.scientificName = eBirdResult.scientificName;
        d.commonName = eBirdResult.commonName;
        console.log(`   ✅ Using eBird taxonomy: ${d.scientificName} (${d.commonName})`);
      }
    }
    
    // Store identification result AFTER all name updates (keyed by final scientific name)
    console.log(`   💾 Storing result with key: ${d.scientificName}`);
    lastIdentifications.set(d.scientificName, d);
    
    // Get iNaturalist reference photo (uses species only)
    console.log('\n📷 Getting iNaturalist reference photo...');
    const iNatPhoto = await getSpeciesPhoto(d.scientificName);
    
    // Generate links - use scientific name (genus + species only)
    const nameParts = d.scientificName.split(' ');
    const genusSpecies = `${nameParts[0]} ${nameParts[1] || ''}`.trim();
    const scientificNameUnderscore = genusSpecies.replace(/\s+/g, '_');
    
    // Wikipedia uses scientific name with underscores
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${scientificNameUnderscore}`;
    
    // iNaturalist - use taxa ID format: /taxa/5367-Gyps-himalayensis
    const iNatNameHyphen = iNatPhoto.taxonName.replace(/\s+/g, '-');
    const iNaturalistUrl = `https://www.inaturalist.org/taxa/${iNatPhoto.taxonId}-${iNatNameHyphen}`;
    
    // Validate all links in parallel
    const linkChecks = [
      isValidUrl(wikipediaUrl).then(valid => valid ? `[Wikipedia](${wikipediaUrl})` : null),
      isValidUrl(iNaturalistUrl).then(valid => valid ? `[iNaturalist](${iNaturalistUrl})` : null)
    ];
    
    // Bird-specific links - validate with HTML content check
    if (isBird) {
      // eBird - get species code for direct link
      const eBirdData = await getEBirdSpeciesCode(d.scientificName);
      if (eBirdData.found) {
        const eBirdUrl = `https://ebird.org/species/${eBirdData.speciesCode}`;
        linkChecks.push(isValidUrl(eBirdUrl).then(valid => valid ? `[eBird](${eBirdUrl})` : null));
      }
    }
    
    // Wait for all link validations
    const validLinks = (await Promise.all(linkChecks)).filter(link => link !== null);
    const linksText = validLinks.join(' • ');
    
    // Delete status message just before sending result
    try {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    
    // Build buttons for follow-up actions
    const followUpButtons = [];
    
    // Add "More Details" button
    followUpButtons.push([{ text: '📚 More Details', callback_data: `details_${d.scientificName.replace(/\s+/g, '_')}` }]);
    
    // Add "Similar Species" button if there are similar species (for birds only)
    const similarSpecies = d.similarSpeciesRuledOut || [];
    if (similarSpecies.length > 0 && isBird) {
      followUpButtons[0].push({ text: '🔍 Similar Species', callback_data: `similar_${d.scientificName.replace(/\s+/g, '_')}` });
    }
    
    // Send composite image (photo left, text right with badges) with buttons
    if (iNatPhoto.found && iNatPhoto.photoUrl) {
      try {
        const compositeBuffer = await createCompositeImage(iNatPhoto.photoUrl, d);
        
        if (compositeBuffer) {
          const caption = linksText || '';
          await ctx.replyWithPhoto(new InputFile(compositeBuffer, 'identification.jpg'), {
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: followUpButtons }
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
          const caption = `*${d.commonName}*\n_${d.scientificName}_${subspeciesText}${linksText ? `\n\n${linksText}` : ''}`;
          await ctx.replyWithPhoto(iNatPhoto.photoUrl, { 
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: followUpButtons }
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
        await ctx.reply(`*${d.commonName}*\n_${d.scientificName}_${subspeciesText}${linksText ? `\n\n${linksText}` : ''}`, { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: followUpButtons }
        });
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
      await ctx.reply(`*${d.commonName}*\n_${d.scientificName}_${subspeciesText}${linksText ? `\n\n${linksText}` : ''}`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: followUpButtons }
      });
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
