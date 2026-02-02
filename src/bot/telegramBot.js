const { Bot, InputFile, InlineKeyboard } = require('grammy');
const ExifParser = require('exif-parser');
const sharp = require('sharp');
const crypto = require('crypto');
const { identifyAnimal } = require('../services/geminiService');
const { getSpeciesPhoto } = require('../services/inaturalistService');
const { createCompositeImage } = require('../services/imageService');
const { getEBirdSpeciesCode, verifyWithEBird } = require('../services/ebirdService');
const { verifyWithGBIF } = require('../services/gbifService');

// ============================================
// REQUEST CONTEXT MANAGER
// Handles isolation, tracking, and lifecycle of concurrent requests
// ============================================

/**
 * @typedef {Object} RequestContext
 * @property {string} requestId - Unique identifier for this request
 * @property {number} userId - Telegram user ID
 * @property {number} chatId - Telegram chat ID
 * @property {number} messageId - Original message ID that triggered this request
 * @property {Buffer} [buffer] - Image buffer (if applicable)
 * @property {number} [promptMsgId] - Location prompt message ID (for pending photos)
 * @property {string} status - Request status: 'pending' | 'processing' | 'completed' | 'failed' | 'expired'
 * @property {number} createdAt - Timestamp when request was created
 * @property {number} [completedAt] - Timestamp when request completed
 * @property {Error} [error] - Error if request failed
 */

class RequestManager {
  constructor(options = {}) {
    /** @type {Map<string, RequestContext>} */
    this.requests = new Map();
    
    /** @type {Map<number, Set<string>>} User ID -> Set of request IDs */
    this.userRequests = new Map();
    
    // Configuration
    this.config = {
      requestTimeout: options.requestTimeout || 180000,      // 3 minutes
      pendingTimeout: options.pendingTimeout || 300000,      // 5 minutes for location input
      cleanupInterval: options.cleanupInterval || 60000,     // Cleanup every minute
      maxRequestsPerUser: options.maxRequestsPerUser || 5,   // Max concurrent requests per user
    };
    
    // Start cleanup timer
    this._cleanupTimer = setInterval(() => this._cleanup(), this.config.cleanupInterval);
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      expiredRequests: 0,
    };
  }

  /**
   * Generate a unique request ID
   * @returns {string}
   */
  _generateRequestId() {
    return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Create a new request context
   * @param {Object} ctx - Grammy context
   * @param {Object} data - Additional request data
   * @returns {RequestContext}
   */
  createRequest(ctx, data = {}) {
    const requestId = this._generateRequestId();
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id;

    // Check if user has too many pending requests
    const userReqs = this.userRequests.get(userId) || new Set();
    if (userReqs.size >= this.config.maxRequestsPerUser) {
      // Remove oldest request for this user
      const oldestReqId = userReqs.values().next().value;
      this._removeRequest(oldestReqId);
      console.log(`⚠️ [${requestId}] Removed oldest request for user ${userId} (limit reached)`);
    }

    /** @type {RequestContext} */
    const request = {
      requestId,
      userId,
      chatId,
      messageId,
      status: 'pending',
      createdAt: Date.now(),
      ...data,
    };

    this.requests.set(requestId, request);
    
    // Track by user
    if (!this.userRequests.has(userId)) {
      this.userRequests.set(userId, new Set());
    }
    this.userRequests.get(userId).add(requestId);
    
    // Track by chat (for multi-group support)
    if (!this.chatRequests) {
      this.chatRequests = new Map();
    }
    if (!this.chatRequests.has(chatId)) {
      this.chatRequests.set(chatId, new Set());
    }
    this.chatRequests.get(chatId).add(requestId);
    
    this.stats.totalRequests++;
    console.log(`📝 [${requestId}] Request created for user ${userId} in chat ${chatId}`);
    
    return request;
  }

  /**
   * Get a request by ID
   * @param {string} requestId
   * @returns {RequestContext|null}
   */
  getRequest(requestId) {
    return this.requests.get(requestId) || null;
  }

  /**
   * Find pending request for a user in a specific chat (most recent)
   * @param {number} userId
   * @param {number} [chatId] - Optional chat ID for multi-group support
   * @returns {RequestContext|null}
   */
  findPendingRequest(userId, chatId = null) {
    const userReqs = this.userRequests.get(userId);
    if (!userReqs) return null;

    let latestPending = null;
    for (const reqId of userReqs) {
      const req = this.requests.get(reqId);
      if (req && req.status === 'pending' && req.buffer) {
        // If chatId specified, must match
        if (chatId && req.chatId !== chatId) continue;
        if (!latestPending || req.createdAt > latestPending.createdAt) {
          latestPending = req;
        }
      }
    }
    return latestPending;
  }

  /**
   * Update request status
   * @param {string} requestId
   * @param {string} status
   * @param {Object} [additionalData]
   */
  updateStatus(requestId, status, additionalData = {}) {
    const request = this.requests.get(requestId);
    if (!request) {
      console.warn(`⚠️ [${requestId}] Cannot update status - request not found`);
      return;
    }

    request.status = status;
    Object.assign(request, additionalData);

    if (status === 'completed' || status === 'failed' || status === 'expired') {
      request.completedAt = Date.now();
      const duration = request.completedAt - request.createdAt;
      
      if (status === 'completed') {
        this.stats.completedRequests++;
        console.log(`✅ [${requestId}] Completed in ${duration}ms`);
      } else if (status === 'failed') {
        this.stats.failedRequests++;
        console.log(`❌ [${requestId}] Failed after ${duration}ms: ${additionalData.error?.message || 'Unknown error'}`);
      } else if (status === 'expired') {
        this.stats.expiredRequests++;
        console.log(`⏰ [${requestId}] Expired after ${duration}ms`);
      }
    } else {
      console.log(`🔄 [${requestId}] Status: ${status}`);
    }
  }

  /**
   * Remove a request and clean up all tracking
   * @param {string} requestId
   */
  _removeRequest(requestId) {
    const request = this.requests.get(requestId);
    if (!request) return;

    // Remove from user tracking
    const userReqs = this.userRequests.get(request.userId);
    if (userReqs) {
      userReqs.delete(requestId);
      if (userReqs.size === 0) {
        this.userRequests.delete(request.userId);
      }
    }
    
    // Remove from chat tracking
    if (this.chatRequests) {
      const chatReqs = this.chatRequests.get(request.chatId);
      if (chatReqs) {
        chatReqs.delete(requestId);
        if (chatReqs.size === 0) {
          this.chatRequests.delete(request.chatId);
        }
      }
    }

    this.requests.delete(requestId);
    console.log(`🗑️ [${requestId}] Request removed from tracking`);
  }

  /**
   * Complete and immediately remove a request
   * @param {string} requestId
   */
  completeAndRemove(requestId) {
    this.updateStatus(requestId, 'completed');
    this._removeRequest(requestId);
  }

  /**
   * Clear all pending requests for a user
   * @param {number} userId
   */
  clearUserRequests(userId) {
    const userReqs = this.userRequests.get(userId);
    if (!userReqs) return;

    for (const reqId of userReqs) {
      this.updateStatus(reqId, 'expired', { reason: 'User cleared requests' });
      this._removeRequest(reqId);
    }
    console.log(`🗑️ Cleared all requests for user ${userId}`);
  }

  /**
   * Cleanup expired requests
   * @private
   */
  _cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [reqId, request] of this.requests.entries()) {
      const age = now - request.createdAt;
      const timeout = request.buffer ? this.config.pendingTimeout : this.config.requestTimeout;

      // Remove completed/failed requests older than 5 minutes
      if ((request.status === 'completed' || request.status === 'failed') && age > 300000) {
        this._removeRequest(reqId);
        cleaned++;
        continue;
      }

      // Expire pending requests that exceeded timeout
      if (request.status === 'pending' && age > timeout) {
        this.updateStatus(reqId, 'expired', { reason: 'Timeout' });
        this._removeRequest(reqId);
        cleaned++;
        continue;
      }

      // Expire processing requests that exceeded timeout (stuck)
      if (request.status === 'processing' && age > this.config.requestTimeout) {
        this.updateStatus(reqId, 'expired', { reason: 'Processing timeout' });
        this._removeRequest(reqId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleanup: removed ${cleaned} expired requests`);
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      activeRequests: this.requests.size,
      activeUsers: this.userRequests.size,
    };
  }

  /**
   * Shutdown manager
   */
  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    console.log('📊 RequestManager shutdown. Final stats:', this.getStats());
  }
}

// Initialize request manager
const requestManager = new RequestManager({
  requestTimeout: 180000,    // 3 minutes for processing
  pendingTimeout: 300000,    // 5 minutes for location input
  cleanupInterval: 60000,    // Cleanup every minute
  maxRequestsPerUser: 5,     // Max 5 concurrent requests per user
});

// ============================================
// WEEKLY RATE LIMITER
// Limits requests per group, resets every Monday 00:00 SST (UTC+8)
// ============================================

class WeeklyRateLimiter {
  constructor(options = {}) {
    /** @type {Map<number, {count: number, resetAt: number}>} chatId -> usage data */
    this.usage = new Map();
    
    // Configuration
    this.config = {
      maxRequestsPerWeek: options.maxRequestsPerWeek || 50,
      timezone: options.timezone || 'Asia/Singapore',  // SST = UTC+8
    };
    
    // Schedule weekly reset check every hour
    this._resetTimer = setInterval(() => this._checkResets(), 3600000);
    
    console.log(`📊 WeeklyRateLimiter initialized: ${this.config.maxRequestsPerWeek} requests/week per group`);
  }

  /**
   * Get next Monday 00:00 SST timestamp
   * @returns {number} Unix timestamp in milliseconds
   */
  _getNextMondayReset() {
    // Create date in Singapore timezone
    const now = new Date();
    
    // Get current time in Singapore
    const sgTime = new Date(now.toLocaleString('en-US', { timeZone: this.config.timezone }));
    
    // Calculate days until next Monday (1 = Monday)
    const currentDay = sgTime.getDay(); // 0 = Sunday, 1 = Monday, ...
    let daysUntilMonday = (8 - currentDay) % 7;
    if (daysUntilMonday === 0) {
      // If it's Monday, check if we're past midnight
      if (sgTime.getHours() >= 0) {
        daysUntilMonday = 7; // Next Monday
      }
    }
    
    // Set to next Monday 00:00:00 SST
    const nextMonday = new Date(sgTime);
    nextMonday.setDate(sgTime.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);
    
    // Convert back to UTC timestamp
    // SST is UTC+8, so subtract 8 hours to get UTC
    const utcTimestamp = nextMonday.getTime() - (8 * 60 * 60 * 1000);
    
    return utcTimestamp;
  }

  /**
   * Get or initialize usage data for a chat
   * @param {number} chatId
   * @returns {{count: number, resetAt: number}}
   */
  _getUsage(chatId) {
    if (!this.usage.has(chatId)) {
      this.usage.set(chatId, {
        count: 0,
        resetAt: this._getNextMondayReset(),
      });
    }
    
    const data = this.usage.get(chatId);
    
    // Check if reset time has passed
    if (Date.now() >= data.resetAt) {
      data.count = 0;
      data.resetAt = this._getNextMondayReset();
      console.log(`🔄 Rate limit reset for chat ${chatId}. Next reset: ${new Date(data.resetAt).toISOString()}`);
    }
    
    return data;
  }

  /**
   * Check if a chat can make a request
   * @param {number} chatId
   * @returns {{allowed: boolean, remaining: number, resetAt: number, resetIn: string}}
   */
  checkLimit(chatId) {
    const data = this._getUsage(chatId);
    const remaining = Math.max(0, this.config.maxRequestsPerWeek - data.count);
    const resetIn = this._formatTimeUntilReset(data.resetAt);
    
    return {
      allowed: data.count < this.config.maxRequestsPerWeek,
      remaining,
      resetAt: data.resetAt,
      resetIn,
      used: data.count,
      limit: this.config.maxRequestsPerWeek,
    };
  }

  /**
   * Consume one request for a chat
   * @param {number} chatId
   * @returns {{success: boolean, remaining: number}}
   */
  consume(chatId) {
    const data = this._getUsage(chatId);
    
    if (data.count >= this.config.maxRequestsPerWeek) {
      return {
        success: false,
        remaining: 0,
        resetIn: this._formatTimeUntilReset(data.resetAt),
      };
    }
    
    data.count++;
    const remaining = this.config.maxRequestsPerWeek - data.count;
    
    console.log(`📊 Chat ${chatId} usage: ${data.count}/${this.config.maxRequestsPerWeek} (${remaining} remaining)`);
    
    return {
      success: true,
      remaining,
      used: data.count,
    };
  }

  /**
   * Format time until reset in human-readable format
   * @param {number} resetAt
   * @returns {string}
   */
  _formatTimeUntilReset(resetAt) {
    const msUntilReset = resetAt - Date.now();
    if (msUntilReset <= 0) return 'now';
    
    const days = Math.floor(msUntilReset / (24 * 60 * 60 * 1000));
    const hours = Math.floor((msUntilReset % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((msUntilReset % (60 * 60 * 1000)) / (60 * 1000));
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
    
    return parts.join(' ') || '< 1m';
  }

  /**
   * Get formatted reset time in SST
   * @param {number} chatId
   * @returns {string}
   */
  getResetTimeFormatted(chatId) {
    const data = this._getUsage(chatId);
    const resetDate = new Date(data.resetAt);
    return resetDate.toLocaleString('en-SG', { 
      timeZone: this.config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' SST';
  }

  /**
   * Check and reset any expired limits
   * @private
   */
  _checkResets() {
    const now = Date.now();
    for (const [chatId, data] of this.usage.entries()) {
      if (now >= data.resetAt) {
        data.count = 0;
        data.resetAt = this._getNextMondayReset();
        console.log(`🔄 Scheduled reset for chat ${chatId}`);
      }
    }
  }

  /**
   * Get usage stats for a chat
   * @param {number} chatId
   * @returns {Object}
   */
  getStats(chatId) {
    const data = this._getUsage(chatId);
    return {
      chatId,
      used: data.count,
      limit: this.config.maxRequestsPerWeek,
      remaining: Math.max(0, this.config.maxRequestsPerWeek - data.count),
      resetAt: new Date(data.resetAt).toISOString(),
      resetIn: this._formatTimeUntilReset(data.resetAt),
    };
  }

  /**
   * Shutdown limiter
   */
  shutdown() {
    if (this._resetTimer) {
      clearInterval(this._resetTimer);
    }
    console.log('📊 WeeklyRateLimiter shutdown');
  }
}

// Initialize rate limiter
const rateLimiter = new WeeklyRateLimiter({
  maxRequestsPerWeek: 50,
  timezone: 'Asia/Singapore',
});

// ============================================
// IDENTIFICATION RESULT CACHE
// Stores results keyed by chatId_scientificName for button callbacks
// Supports multiple groups simultaneously
// ============================================

class ResultCache {
  constructor(ttlMs = 300000) { // 5 minute default TTL (shorter for memory efficiency)
    this.cache = new Map();
    this.ttl = ttlMs;
    
    // Cleanup expired entries every 2 minutes
    this._cleanupTimer = setInterval(() => this._cleanup(), 120000);
  }

  /**
   * Generate cache key scoped to chat
   * @param {number} chatId
   * @param {string} scientificName
   * @returns {string}
   */
  static makeKey(chatId, scientificName) {
    return `${chatId}_${scientificName}`;
  }

  set(key, value) {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.value;
  }

  /**
   * Remove entry immediately
   * @param {string} key
   */
  remove(key) {
    this.cache.delete(key);
  }

  /**
   * Clear all entries for a specific chat
   * @param {number} chatId
   */
  clearChat(chatId) {
    const prefix = `${chatId}_`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  _cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 ResultCache: cleaned ${cleaned} expired entries`);
    }
  }

  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
  }
}

const identificationCache = new ResultCache(300000); // 5 minute TTL (shorter for memory efficiency)
const userImageCache = new ResultCache(300000); // Track which users received HD images (5 min TTL)

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

// Error handler middleware - log with context
bot.catch((err) => {
  console.error('Bot error:', err.message);
});

// Bot commands list
const botCommands = [
  { command: 'start', description: '🦁 Welcome message' },
  { command: 'menu', description: '📋 Show menu buttons' },
  { command: 'help', description: '📖 Show help' },
  { command: 'identify', description: '📷 How to identify animals' },
  { command: 'limit', description: '📊 Check weekly usage limit' },
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

// Start command
bot.command('start', async (ctx) => {
  console.log(`📩 /start command received from user ${ctx.from.id}`);
  try {
    await ctx.reply(
      `🦁 *Wildlife ID Bot*\n\n` +
      `Send me a photo of any animal and I'll identify it!\n\n` +
      `📷 Just send a photo - no commands needed!\n\n` +
      `*Commands:*\n` +
      `/start - Welcome message\n` +
      `/help - Show help\n` +
      `/identify - How to identify\n` +
      `/clear - Clear chat messages`,
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
    `1️⃣ Send a photo or multiple photos at once\n` +
    `2️⃣ Tell me where it was taken (or /skip)\n` +
    `3️⃣ Get detailed identification!\n\n` +
    `💡 *Tips:*\n` +
    `• Send multiple photos together for batch analysis\n` +
    `• Same species photos will be grouped\n` +
    `• Use /limit to check your weekly quota`,
    { parse_mode: 'Markdown' }
  );
});

// Limit command - check weekly usage
bot.command('limit', async (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`📩 /limit command received from chat ${chatId}`);
  
  const stats = rateLimiter.getStats(chatId);
  const limitCheck = rateLimiter.checkLimit(chatId);
  const progressBar = generateProgressBar(stats.used, stats.limit);
  
  // Build status message based on whether limit is exceeded
  let statusLine;
  if (!limitCheck.allowed) {
    statusLine = `🚫 *LIMIT EXCEEDED*\n❌ Used: ${stats.used}/${stats.limit}`;
  } else if (stats.remaining <= 5) {
    statusLine = `⚠️ *Running low!*\n✅ Used: ${stats.used}/${stats.limit}`;
  } else {
    statusLine = `✅ Used: ${stats.used}/${stats.limit}`;
  }
  
  await ctx.reply(
    `📊 *Weekly Usage Limit*\n\n` +
    `${progressBar}\n\n` +
    `${statusLine}\n` +
    `📦 Remaining: ${stats.remaining}\n\n` +
    `🔄 *Resets:* ${rateLimiter.getResetTimeFormatted(chatId)}\n` +
    `⏳ *Time left:* ${stats.resetIn}`,
    { parse_mode: 'Markdown' }
  );
});

/**
 * Generate a visual progress bar
 * @param {number} used
 * @param {number} limit
 * @returns {string}
 */
function generateProgressBar(used, limit) {
  const percentage = Math.min(100, Math.round((used / limit) * 100));
  const filled = Math.round(percentage / 10);
  const empty = 10 - filled;
  const exceeded = used >= limit;
  
  let bar = '';
  const fillChar = exceeded ? '🟥' : '🟩';  // Red when exceeded, green otherwise
  for (let i = 0; i < filled; i++) bar += fillChar;
  for (let i = 0; i < empty; i++) bar += '⬜';
  
  return `${bar} ${percentage}%`;
}

// Menu command - show clickable buttons (for forum/topic groups)
bot.command('menu', async (ctx) => {
  console.log(`📩 /menu command received from user ${ctx.from.id}`);
  const menuKeyboard = new InlineKeyboard()
    .text('🦁 Start', 'menu_start')
    .text('📖 Help', 'menu_help').row()
    .text('📷 How to Identify', 'menu_identify')
    .text('📊 Usage Limit', 'menu_limit').row()
    .text('🗑️ Clear Chat', 'menu_clear');
  
  await ctx.reply(
    `📋 *Menu*\n\nTap a button below or just send a photo to identify an animal!`,
    { parse_mode: 'Markdown', reply_markup: menuKeyboard }
  );
});

// Handle menu button clicks
bot.callbackQuery('menu_start', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🦁 *Wildlife ID Bot*\n\n` +
    `Send me a photo of any animal and I'll identify it!\n\n` +
    `📷 Just send a photo - no commands needed!`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('menu_help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `📖 *How to use:*\n\n` +
    `1. Send a photo of an animal\n` +
    `2. Tell me where it was taken\n` +
    `3. Get detailed identification!`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('menu_identify', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `📷 *How to Identify Animals:*\n\n` +
    `1️⃣ Send a photo or multiple photos at once\n` +
    `2️⃣ Tell me the location (or /skip)\n` +
    `3️⃣ Get detailed identification!\n\n` +
    `💡 Multiple photos are grouped by species!\n\n` +
    `_Just send a photo to get started!_`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('menu_clear', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Type /clear to clear chat messages', show_alert: true });
});

bot.callbackQuery('menu_limit', async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.callbackQuery.message?.chat?.id;
  
  if (chatId) {
    const stats = rateLimiter.getStats(chatId);
    const limitCheck = rateLimiter.checkLimit(chatId);
    const progressBar = generateProgressBar(stats.used, stats.limit);
    
    // Build status message based on whether limit is exceeded
    let statusLine;
    if (!limitCheck.allowed) {
      statusLine = `🚫 *LIMIT EXCEEDED*\n❌ Used: ${stats.used}/${stats.limit}`;
    } else if (stats.remaining <= 5) {
      statusLine = `⚠️ *Running low!*\n✅ Used: ${stats.used}/${stats.limit}`;
    } else {
      statusLine = `✅ Used: ${stats.used}/${stats.limit}`;
    }
    
    await ctx.reply(
      `📊 *Weekly Usage Limit*\n\n` +
      `${progressBar}\n\n` +
      `${statusLine}\n` +
      `📦 Remaining: ${stats.remaining}\n\n` +
      `🔄 *Resets:* ${rateLimiter.getResetTimeFormatted(chatId)}\n` +
      `⏳ *Time left:* ${stats.resetIn}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Clear command - delete ALL messages in chat (parallel deletion)
bot.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const currentMsgId = ctx.message.message_id;
  
  // Delete the /clear command message
  try {
    await ctx.api.deleteMessage(chatId, currentMsgId);
  } catch (e) {}
  
  // Clear all pending requests for this user using RequestManager
  requestManager.clearUserRequests(userId);
  
  // Clear identification cache for this chat
  identificationCache.clearChat(chatId);
  userImageCache.clearChat(chatId);
  console.log(`🗑️ Cleared caches for chat ${chatId}`);
  
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

// Skip location command - process without location
bot.command('skip', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  // Find pending request for this user in THIS chat
  const pendingRequest = requestManager.findPendingRequest(userId, chatId);
  
  if (!pendingRequest) {
    await ctx.reply('❌ No pending identification request to skip.');
    return;
  }
  
  const requestId = pendingRequest.requestId;
  const pendingBuffer = pendingRequest.buffer;
  const pendingPromptMsgId = pendingRequest.promptMsgId;
  const isMediaGroup = pendingRequest.isMediaGroup;
  const processedPhotos = pendingRequest.processedPhotos;
  const statusMsgId = pendingRequest.statusMsgId;
  
  console.log(`⏭️ [${requestId}] Skip location in chat ${chatId}${isMediaGroup ? ' (media group)' : ''}`);
  
  // Update status to processing
  requestManager.updateStatus(requestId, 'processing');
  
  // Delete the location prompt message
  try {
    await ctx.api.deleteMessage(chatId, pendingPromptMsgId);
  } catch (e) {}
  // Delete the /skip command
  try {
    await ctx.api.deleteMessage(chatId, ctx.message.message_id);
  } catch (e) {}
  // Delete status message for media groups
  if (statusMsgId) {
    try {
      await ctx.api.deleteMessage(chatId, statusMsgId);
    } catch (e) {}
  }
  
  // Process without location
  const noLocation = 'Unknown location';
  
  if (isMediaGroup && processedPhotos) {
    // Process media group without location
    try {
      await processMediaGroupPhotos(ctx, processedPhotos, noLocation, requestId);
    } catch (error) {
      requestManager.updateStatus(requestId, 'failed', { error });
      requestManager._removeRequest(requestId);
      await ctx.reply(`❌ Error processing photos: ${error.message}`);
    }
  } else if (pendingBuffer) {
    // Process single photo without location
    try {
      await processIdentification(ctx, pendingBuffer, noLocation, requestId);
      // Consume rate limit on successful completion
      const consumed = rateLimiter.consume(chatId);
      console.log(`📊 [${requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
      // Immediately remove request after completion
      requestManager.completeAndRemove(requestId);
    } catch (error) {
      requestManager.updateStatus(requestId, 'failed', { error });
      requestManager._removeRequest(requestId);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  } else {
    await ctx.reply('❌ No photo data found. Please try again.');
    requestManager._removeRequest(requestId);
  }
});

// Handle text messages (for location input)
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  // Find pending request for this user in THIS chat (multi-group support)
  const pendingRequest = requestManager.findPendingRequest(userId, chatId);
  
  if (pendingRequest) {
    const requestId = pendingRequest.requestId;
    const location = ctx.message.text.trim();
    
    // Capture values locally to ensure correct context
    const pendingBuffer = pendingRequest.buffer;
    const pendingPromptMsgId = pendingRequest.promptMsgId;
    const isMediaGroup = pendingRequest.isMediaGroup;
    const processedPhotos = pendingRequest.processedPhotos;
    const statusMsgId = pendingRequest.statusMsgId;
    
    console.log(`📍 [${requestId}] Location received in chat ${chatId}: "${location}"${isMediaGroup ? ' (media group)' : ''}`);
    
    // Update status to processing BEFORE any async operations
    requestManager.updateStatus(requestId, 'processing');
    
    // Delete the location prompt message
    try {
      await ctx.api.deleteMessage(chatId, pendingPromptMsgId);
    } catch (e) {}
    // Delete user's location reply
    try {
      await ctx.api.deleteMessage(chatId, ctx.message.message_id);
    } catch (e) {}
    // Delete status message for media groups
    if (statusMsgId) {
      try {
        await ctx.api.deleteMessage(chatId, statusMsgId);
      } catch (e) {}
    }
    
    // Handle media group vs single photo
    if (isMediaGroup && processedPhotos) {
      // Process media group with location
      try {
        await processMediaGroupPhotos(ctx, processedPhotos, location, requestId);
      } catch (error) {
        requestManager.updateStatus(requestId, 'failed', { error });
        requestManager._removeRequest(requestId);
        await ctx.reply(`❌ Error processing photos: ${error.message}`);
      }
    } else {
      // Process single photo with captured context
      try {
        await processIdentification(ctx, pendingBuffer, location, requestId);
        // Consume rate limit on successful completion
        const consumed = rateLimiter.consume(chatId);
        console.log(`📊 [${requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
        // Immediately remove request after completion
        requestManager.completeAndRemove(requestId);
      } catch (error) {
        requestManager.updateStatus(requestId, 'failed', { error });
        requestManager._removeRequest(requestId);
        throw error;
      }
    }
  }
});

// Handle callback queries (button clicks) - non-blocking
bot.on('callback_query:data', (ctx) => {
  // Fire and forget - process callbacks independently
  handleCallbackQuery(ctx).catch(err => {
    console.error('Callback error:', err.message);
    ctx.answerCallbackQuery({ text: '❌ Error occurred' }).catch(() => {});
  });
});

// Async callback handler
async function handleCallbackQuery(ctx) {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.callbackQuery.message?.chat?.id;  // Get chat ID from callback message
  
  if (data.startsWith('details_')) {
    const scientificName = data.replace('details_', '').replace(/_/g, ' ');
    const tappedByUserId = ctx.from.id;  // The user who tapped the button
    
    // Look up by chat-scoped key for multi-group support
    const cacheKey = ResultCache.makeKey(chatId, scientificName);
    const lastResult = identificationCache.get(cacheKey);
    
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
      const alreadyReceivedImage = userImageCache.get(imageKey);
      
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
            userImageCache.set(imageKey, true);
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
    
    // Look up by chat-scoped key for multi-group support
    const cacheKey = ResultCache.makeKey(chatId, scientificName);
    const lastResult = identificationCache.get(cacheKey);
    
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
        const alreadyReceivedImage = userImageCache.get(imageKey);
        
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
              userImageCache.set(imageKey, true);
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
}

// ============================================
// MEDIA GROUP HANDLER
// Collects multiple photos sent together and processes them
// ============================================

/**
 * @typedef {Object} MediaGroupPhoto
 * @property {Object} ctx - Grammy context
 * @property {Object} photo - Largest photo object
 * @property {number} messageId - Message ID
 */

class MediaGroupCollector {
  constructor() {
    /** @type {Map<string, {photos: MediaGroupPhoto[], timer: NodeJS.Timeout, chatId: number, userId: number}>} */
    this.groups = new Map();
    this.collectTimeout = 1000; // Wait 1 second to collect all photos in group
  }

  /**
   * Add a photo to a media group
   * @param {string} mediaGroupId
   * @param {Object} ctx - Grammy context
   * @returns {Promise<MediaGroupPhoto[]|null>} Returns array of photos when collection is complete, null otherwise
   */
  addPhoto(mediaGroupId, ctx) {
    return new Promise((resolve) => {
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      
      const photoData = {
        ctx,
        photo: largestPhoto,
        messageId: ctx.message.message_id,
      };

      if (!this.groups.has(mediaGroupId)) {
        // First photo in group - start collecting
        this.groups.set(mediaGroupId, {
          photos: [photoData],
          chatId: ctx.chat.id,
          userId: ctx.from.id,
          timer: setTimeout(() => {
            // Collection complete - return all photos
            const group = this.groups.get(mediaGroupId);
            this.groups.delete(mediaGroupId);
            if (group) {
              console.log(`📸 Media group ${mediaGroupId} collected: ${group.photos.length} photos`);
              resolve(group.photos);
            }
          }, this.collectTimeout),
          resolve, // Store resolve function for first photo
        });
      } else {
        // Additional photo in group
        const group = this.groups.get(mediaGroupId);
        group.photos.push(photoData);
        resolve(null); // Not the first photo, will be handled by the timer
      }
    });
  }
}

const mediaGroupCollector = new MediaGroupCollector();

// ============================================
// PHOTO MESSAGE HANDLER
// Creates isolated request context for each photo
// Supports both single photos and media groups
// ============================================

bot.on('message:photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const mediaGroupId = ctx.message.media_group_id;
  
  // Check rate limit BEFORE processing
  const limitCheck = rateLimiter.checkLimit(chatId);
  
  if (!limitCheck.allowed) {
    // Only show message once per media group or for single photos
    if (!mediaGroupId) {
      console.log(`⚠️ Rate limit exceeded for chat ${chatId} (${limitCheck.used}/${limitCheck.limit})`);
      await ctx.reply(
        `⚠️ *Weekly limit reached*\n\n` +
        `This group has used all ${limitCheck.limit} identifications for this week.\n\n` +
        `🔄 Resets: ${rateLimiter.getResetTimeFormatted(chatId)}\n` +
        `⏳ Time remaining: ${limitCheck.resetIn}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  // Handle media group (multiple photos)
  if (mediaGroupId) {
    const collectedPhotos = await mediaGroupCollector.addPhoto(mediaGroupId, ctx);
    
    if (collectedPhotos) {
      // This is the callback after all photos are collected
      // Check if we have enough quota for all photos
      const photoCount = collectedPhotos.length;
      
      if (limitCheck.remaining < photoCount) {
        await ctx.reply(
          `⚠️ *Not enough quota*\n\n` +
          `You sent ${photoCount} photos but only have ${limitCheck.remaining} identifications remaining.\n\n` +
          `Please send fewer photos or wait for reset.\n` +
          `🔄 Resets: ${rateLimiter.getResetTimeFormatted(chatId)}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      console.log(`📸 Processing media group with ${photoCount} photos (${limitCheck.remaining} remaining)`);
      
      // Process all photos in the group
      await processMediaGroup(collectedPhotos, chatId);
    }
    // If null, this photo was added to existing group and will be processed later
    return;
  }
  
  // Single photo - process normally
  const request = requestManager.createRequest(ctx);
  
  console.log(`📸 [${request.requestId}] New photo from user ${ctx.from.id} (${limitCheck.remaining} requests remaining this week)`);
  
  // Fire and forget - process independently
  processPhotoWithContext(ctx, request)
    .catch(err => {
      requestManager.updateStatus(request.requestId, 'failed', { error: err });
      ctx.reply(`❌ Error: ${err.message}`).catch(() => {});
    });
});

/**
 * Process a media group (multiple photos)
 * @param {MediaGroupPhoto[]} photos - Array of collected photos
 * @param {number} chatId - Chat ID
 */
async function processMediaGroup(photos, chatId) {
  const firstCtx = photos[0].ctx;
  const photoCount = photos.length;
  
  // Send initial status message
  const statusMsg = await firstCtx.reply(
    `📸 *Processing ${photoCount} photo${photoCount > 1 ? 's' : ''}...*\n\n` +
    `Each photo will be identified separately.`,
    { parse_mode: 'Markdown' }
  );
  
  // Ask for location (use first photo's context)
  const promptMsg = await firstCtx.reply(
    `🌍 *Where were these photos taken?*\n\n` +
    `Reply with location or /skip`,
    { parse_mode: 'Markdown' }
  );
  
  // Store all photos as a pending media group
  const groupRequest = requestManager.createRequest(firstCtx, {
    isMediaGroup: true,
    photoCount,
  });
  
  // Download and process all images in parallel
  const processedPhotos = await Promise.all(photos.map(async (photoData, index) => {
    try {
      const file = await firstCtx.api.getFile(photoData.photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      
      const response = await fetch(fileUrl);
      let buffer = Buffer.from(await response.arrayBuffer());
      
      // Extract EXIF GPS if available
      let exifLocation = null;
      try {
        const parser = ExifParser.create(buffer);
        const exifData = parser.parse();
        if (exifData.tags?.GPSLatitude && exifData.tags?.GPSLongitude) {
          const lat = exifData.tags.GPSLatitude;
          const lng = exifData.tags.GPSLongitude;
          exifLocation = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }
      } catch (e) {}
      
      // Process image
      buffer = await sharp(buffer)
        .rotate()
        .withMetadata()
        .png({ compressionLevel: 0, effort: 1 })
        .toBuffer();
      
      return { buffer, exifLocation, index };
    } catch (error) {
      console.error(`Error processing photo ${index + 1}:`, error.message);
      return { error: error.message, index };
    }
  }));
  
  // Check if any photo has EXIF location
  const exifLocation = processedPhotos.find(p => p.exifLocation)?.exifLocation;
  
  if (exifLocation) {
    // Has EXIF location - process immediately
    console.log(`📍 Using EXIF location for media group: ${exifLocation}`);
    
    // Delete prompts
    try {
      await firstCtx.api.deleteMessage(chatId, statusMsg.message_id);
      await firstCtx.api.deleteMessage(chatId, promptMsg.message_id);
    } catch (e) {}
    
    // Process all photos with the location
    await processMediaGroupPhotos(firstCtx, processedPhotos, exifLocation, groupRequest.requestId);
  } else {
    // No EXIF - wait for location input
    const req = requestManager.getRequest(groupRequest.requestId);
    if (req) {
      req.processedPhotos = processedPhotos;
      req.promptMsgId = promptMsg.message_id;
      req.statusMsgId = statusMsg.message_id;
      req.isMediaGroup = true;
      req.buffer = true; // Flag that we have data waiting
      req.status = 'pending';
    }
  }
}

/**
 * Process all photos in a media group with a location
 * @param {Object} ctx - Grammy context
 * @param {Array} processedPhotos - Array of processed photo data
 * @param {string} location - Location string
 * @param {string} requestId - Request ID
 */
async function processMediaGroupPhotos(ctx, processedPhotos, location, requestId) {
  const chatId = ctx.chat.id;
  const validPhotos = processedPhotos.filter(p => !p.error);
  
  if (validPhotos.length === 0) {
    await ctx.reply('❌ Failed to process all photos. Please try again.');
    requestManager._removeRequest(requestId);
    return;
  }
  
  // Show processing status
  const processingMsg = await ctx.reply(
    `🔬 *Analyzing ${validPhotos.length} photo${validPhotos.length > 1 ? 's' : ''}...*`,
    { parse_mode: 'Markdown' }
  );
  
  // Process each photo and collect results
  const results = [];
  
  for (let i = 0; i < validPhotos.length; i++) {
    const photo = validPhotos[i];
    
    try {
      // Update status
      await ctx.api.editMessageText(
        chatId,
        processingMsg.message_id,
        `🔬 *Analyzing photo ${i + 1}/${validPhotos.length}...*`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      
      // Identify the animal
      const result = await identifyAnimal(photo.buffer, 'image/jpeg', { location });
      
      if (result.success && result.data.identified) {
        results.push({
          index: photo.index,
          success: true,
          data: result.data,
          buffer: photo.buffer,
        });
        
        // Consume rate limit for successful identification
        rateLimiter.consume(chatId);
      } else {
        // Handle quality issues with specific reasons
        const qualityReason = result.data?.reason || result.error || 'Could not identify';
        const qualityIssue = result.data?.qualityIssue;
        const suggestion = result.data?.suggestion;
        
        results.push({
          index: photo.index,
          success: false,
          reason: qualityReason,
          qualityIssue,
          suggestion,
        });
      }
    } catch (error) {
      results.push({
        index: photo.index,
        success: false,
        reason: error.message,
      });
    }
  }
  
  // Delete processing message
  try {
    await ctx.api.deleteMessage(chatId, processingMsg.message_id);
  } catch (e) {}
  
  // Group results by species
  const speciesGroups = new Map();
  const failed = [];
  
  for (const result of results) {
    if (result.success) {
      const species = result.data.scientificName;
      if (!speciesGroups.has(species)) {
        speciesGroups.set(species, {
          data: result.data,
          count: 1,
          buffers: [result.buffer],
        });
      } else {
        const group = speciesGroups.get(species);
        group.count++;
        group.buffers.push(result.buffer);
      }
    } else {
      failed.push(result);
    }
  }
  
  // Send results
  if (speciesGroups.size > 0) {
    // Send summary first
    let summaryMsg = `📊 *Identification Results*\n\n`;
    summaryMsg += `📸 Photos analyzed: ${validPhotos.length}\n`;
    summaryMsg += `✅ Identified: ${results.filter(r => r.success).length}\n`;
    if (failed.length > 0) {
      summaryMsg += `❌ Failed: ${failed.length}\n`;
    }
    summaryMsg += `\n🦁 *Species found: ${speciesGroups.size}*\n`;
    
    for (const [species, group] of speciesGroups) {
      summaryMsg += `\n• _${species}_ (${group.data.commonName})`;
      if (group.count > 1) {
        summaryMsg += ` — ${group.count} photos`;
      }
    }
    
    await ctx.reply(summaryMsg, { parse_mode: 'Markdown' });
    
    // Send detailed result for each unique species
    for (const [species, group] of speciesGroups) {
      const d = group.data;
      d._originalImageBuffer = group.buffers[0]; // Use first photo for HD
      
      // Cache result
      const cacheKey = ResultCache.makeKey(chatId, d.scientificName);
      identificationCache.set(cacheKey, d);
      
      // Get reference photo and links
      const iNatPhoto = await getSpeciesPhoto(d.scientificName);
      
      // Generate links
      const nameParts = d.scientificName.split(' ');
      const genusSpecies = `${nameParts[0]} ${nameParts[1] || ''}`.trim();
      const scientificNameUnderscore = genusSpecies.replace(/\s+/g, '_');
      const wikipediaUrl = `https://en.wikipedia.org/wiki/${scientificNameUnderscore}`;
      
      const linkChecks = [
        isValidUrl(wikipediaUrl).then(valid => valid ? `[Wikipedia](${wikipediaUrl})` : null),
      ];
      
      if (iNatPhoto.found) {
        const iNatNameHyphen = iNatPhoto.taxonName.replace(/\s+/g, '-');
        const iNaturalistUrl = `https://www.inaturalist.org/taxa/${iNatPhoto.taxonId}-${iNatNameHyphen}`;
        linkChecks.push(isValidUrl(iNaturalistUrl).then(valid => valid ? `[iNaturalist](${iNaturalistUrl})` : null));
      }
      
      const validLinks = (await Promise.all(linkChecks)).filter(link => link !== null);
      const linksText = validLinks.join(' • ');
      
      // Build buttons
      const followUpButtons = [[
        { text: '📚 More Details', callback_data: `details_${d.scientificName.replace(/\s+/g, '_')}` }
      ]];
      
      if (d.similarSpeciesRuledOut?.length > 0 && d.taxonomy?.class?.toLowerCase() === 'aves') {
        followUpButtons[0].push({ 
          text: '🔍 Similar Species', 
          callback_data: `similar_${d.scientificName.replace(/\s+/g, '_')}` 
        });
      }
      
      // Send result
      const countText = group.count > 1 ? `\n📸 _${group.count} photos of this species_` : '';
      
      if (iNatPhoto.found && iNatPhoto.photoUrl) {
        try {
          const compositeBuffer = await createCompositeImage(iNatPhoto.photoUrl, d);
          if (compositeBuffer) {
            await ctx.api.sendPhoto(chatId, new InputFile(compositeBuffer, 'identification.jpg'), {
              caption: `${linksText}${countText}`,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: followUpButtons }
            });
          } else {
            await ctx.api.sendPhoto(chatId, iNatPhoto.photoUrl, {
              caption: `*${d.commonName}*\n_${d.scientificName}_${countText}\n\n${linksText}`,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: followUpButtons }
            });
          }
        } catch (e) {
          await ctx.api.sendMessage(chatId, 
            `*${d.commonName}*\n_${d.scientificName}_${countText}\n\n${linksText}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: followUpButtons } }
          );
        }
      } else {
        await ctx.api.sendMessage(chatId,
          `*${d.commonName}*\n_${d.scientificName}_${countText}\n\n${linksText}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: followUpButtons } }
        );
      }
    }
  }
  
  // Report failures with detailed quality issues
  if (failed.length > 0) {
    // Group failures by reason type
    const qualityIssues = failed.filter(f => ['low_resolution', 'obstructed', 'too_distant', 'poor_quality'].includes(f.reason));
    const noAnimal = failed.filter(f => f.reason === 'no_animal');
    const otherFails = failed.filter(f => !['low_resolution', 'obstructed', 'too_distant', 'poor_quality', 'no_animal'].includes(f.reason));
    
    let failMsg = '';
    
    if (qualityIssues.length > 0) {
      const issueIcons = {
        'low_resolution': '📉',
        'obstructed': '🌿',
        'too_distant': '🔭',
        'poor_quality': '📷'
      };
      
      failMsg += `⚠️ *Image Quality Issues (${qualityIssues.length} photo${qualityIssues.length > 1 ? 's' : ''})*\n\n`;
      
      for (const fail of qualityIssues) {
        const icon = issueIcons[fail.reason] || '❌';
        failMsg += `${icon} Photo ${fail.index + 1}: `;
        if (fail.qualityIssue) {
          failMsg += `${fail.qualityIssue}`;
        } else {
          failMsg += fail.reason.replace(/_/g, ' ');
        }
        failMsg += '\n';
      }
      
      // Add suggestion from first quality issue
      const suggestion = qualityIssues.find(f => f.suggestion)?.suggestion;
      if (suggestion) {
        failMsg += `\n💡 *Tip:* ${suggestion}`;
      }
    }
    
    if (noAnimal.length > 0) {
      if (failMsg) failMsg += '\n\n';
      failMsg += `🚫 ${noAnimal.length} photo${noAnimal.length > 1 ? 's' : ''} did not contain identifiable animals.`;
    }
    
    if (otherFails.length > 0 && failed.length === validPhotos.length) {
      // Only show generic message if everything failed and no quality issues detected
      if (!failMsg) {
        failMsg = '❌ Could not identify any animals in the photos.';
      }
    }
    
    if (failMsg) {
      await ctx.reply(failMsg, { parse_mode: 'Markdown' });
    }
  }
  
  // Complete the request
  requestManager.completeAndRemove(requestId);
}

/**
 * Process photo with request context and timeout
 * @param {Object} ctx - Grammy context
 * @param {RequestContext} request - Request context
 */
async function processPhotoWithContext(ctx, request) {
  const { requestId } = request;
  
  try {
    // Update status to processing
    requestManager.updateStatus(requestId, 'processing');
    
    // Get the largest photo (highest resolution)
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];
    
    // Download image from Telegram
    console.log(`📥 [${requestId}] Downloading image...`);
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
        console.log(`📍 [${requestId}] Found EXIF GPS: ${exifLocation}`);
      }
    } catch (e) {
      // No EXIF data or parsing failed - ignore
    }
    
    // Process image for analysis: Full size, natural orientation, HD/HQ, no quality loss
    console.log(`🖼️ [${requestId}] Processing image...`);
    buffer = await sharp(buffer)
      .rotate()  // Auto-rotate to natural orientation based on EXIF
      .withMetadata()  // Preserve all metadata
      .png({  // Use PNG for lossless quality
        compressionLevel: 0,  // No compression for fastest processing
        effort: 1  // Minimal effort for speed
      })
      .toBuffer();
    
    if (exifLocation) {
      // Image has GPS coordinates - ask what to identify, then process
      console.log(`📍 [${requestId}] Has EXIF location, asking what to identify...`);
      const promptMsg = await ctx.reply(
        `🎯 *What would you like me to identify?*\n\n` +
        `Reply with a description (e.g., "the bird on the left", "the butterfly", "all animals")\n` +
        `Or /auto to identify automatically`,
        { parse_mode: 'Markdown' }
      );
      
      // Update request with pending photo data
      const req = requestManager.getRequest(requestId);
      if (req) {
        req.buffer = buffer;
        req.promptMsgId = promptMsg.message_id;
        req.exifLocation = exifLocation;
        req.status = 'pending';
        req.waitingFor = 'target'; // Waiting for what to identify
        console.log(`⏳ [${requestId}] Waiting for identification target...`);
      }
    } else {
      // No EXIF GPS - ask what to identify first, then location
      console.log(`📍 [${requestId}] No EXIF GPS, asking what to identify...`);
      const promptMsg = await ctx.reply(
        `🎯 *What would you like me to identify?*\n\n` +
        `Reply with a description (e.g., "the bird on the left", "the butterfly", "all animals")\n` +
        `Or /auto to identify automatically`,
        { parse_mode: 'Markdown' }
      );
      
      // Update request with pending photo data
      const req = requestManager.getRequest(requestId);
      if (req) {
        req.buffer = buffer;
        req.promptMsgId = promptMsg.message_id;
        req.status = 'pending';
        req.waitingFor = 'target'; // Waiting for what to identify
        console.log(`⏳ [${requestId}] Waiting for identification target...`);
      }
    }
  } catch (error) {
    requestManager.updateStatus(requestId, 'failed', { error });
    requestManager._removeRequest(requestId);
    throw error;
  }
}

// ============================================
// IDENTIFICATION PROCESSOR
// Core identification logic with full request isolation
// ============================================

/**
 * Process animal identification
 * @param {Object} ctx - Grammy context (bound to specific user/chat)
 * @param {Buffer} buffer - Image buffer
 * @param {string} location - Location string
 * @param {string} [requestId] - Request ID for logging
 */
async function processIdentification(ctx, buffer, location, requestId = 'unknown') {
  let statusMsg;
  const logPrefix = `[${requestId}]`;
  
  // Capture user/chat context at start to ensure correct delivery
  const targetChatId = ctx.chat.id;
  const targetUserId = ctx.from.id;
  
  try {
    // Simple status message
    statusMsg = await ctx.reply('🔬 *Analyzing...*', { parse_mode: 'Markdown' });

    // Step 1: Identify with Gemini 2.5 Pro
    console.log(`\n🤖 ${logPrefix} Starting Gemini 2.5 Pro analysis...`);
    const result = await identifyAnimal(buffer, 'image/jpeg', { location });
    
    if (!result.success || !result.data.identified) {
      await ctx.api.deleteMessage(targetChatId, statusMsg.message_id);
      
      // Handle quality issues with specific messages
      const reason = result.data?.reason || result.error || 'unknown';
      const qualityIssue = result.data?.qualityIssue;
      const suggestion = result.data?.suggestion;
      
      // Build user-friendly error message based on reason
      let errorMsg = '';
      const issueIcons = {
        'low_resolution': '📉',
        'obstructed': '🌿',
        'too_distant': '🔭',
        'poor_quality': '📷',
        'no_animal': '🚫'
      };
      
      const icon = issueIcons[reason] || '❌';
      
      if (qualityIssue) {
        errorMsg = `${icon} *Image Quality Issue*\n\n${qualityIssue}`;
      } else if (reason === 'low_resolution') {
        errorMsg = `${icon} *Low Resolution*\n\nThe image resolution is too low to identify distinguishing features.`;
      } else if (reason === 'obstructed') {
        errorMsg = `${icon} *Animal Obstructed*\n\nThe animal is partially hidden or obstructed, making identification difficult.`;
      } else if (reason === 'too_distant') {
        errorMsg = `${icon} *Subject Too Far*\n\nThe animal is too distant to see identifying features clearly.`;
      } else if (reason === 'poor_quality') {
        errorMsg = `${icon} *Poor Image Quality*\n\nThe image is too dark, blurry, or overexposed for identification.`;
      } else if (reason === 'no_animal') {
        errorMsg = `${icon} *No Animal Detected*\n\nNo identifiable animal was found in this image.`;
      } else {
        errorMsg = `❌ *Could not identify animal*\n\n${reason}`;
      }
      
      // Add suggestion if available
      if (suggestion) {
        errorMsg += `\n\n💡 *Tip:* ${suggestion}`;
      } else if (['low_resolution', 'obstructed', 'too_distant', 'poor_quality'].includes(reason)) {
        errorMsg += `\n\n💡 *Tip:* Try sending a clearer, higher resolution photo with an unobstructed view of the animal.`;
      }
      
      await ctx.api.sendMessage(targetChatId, errorMsg, { parse_mode: 'Markdown' });
      return;
    }
    
    const d = result.data;
    
    // Store original image buffer for later PM
    d._originalImageBuffer = buffer;
    
    // Check if it's a bird (class Aves)
    const isBird = d.taxonomy?.class?.toLowerCase() === 'aves';
    
    // Step 2: Verify with GBIF using location
    console.log(`\n🌍 ${logPrefix} Verifying with GBIF...`);
    console.log(`   📍 Location from user: "${location}"`);
    const gbifResult = await verifyWithGBIF(d, location);
    
    // Use GBIF species name if different from Gemini (GBIF takes priority)
    // This handles taxonomic revisions and synonym updates
    if (gbifResult.verified) {
      if (gbifResult.species?.isSynonym && gbifResult.species?.acceptedName) {
        console.log(`   🔄 ${logPrefix} Name updated (was synonym): ${d.scientificName} → ${gbifResult.species.acceptedName}`);
        d.scientificName = gbifResult.species.canonicalName || gbifResult.species.acceptedName;
        if (gbifResult.species.commonName) {
          d.commonName = gbifResult.species.commonName;
          console.log(`   🔄 ${logPrefix} Common name updated: ${d.commonName}`);
        }
      } else if (!gbifResult.matches && gbifResult.gbifName) {
        console.log(`   📝 ${logPrefix} Using GBIF species: ${gbifResult.gbifName} (Gemini said: ${d.scientificName})`);
        d.scientificName = gbifResult.species?.canonicalName || gbifResult.gbifName;
      }
    }
    
    // Step 3: If bird, also verify with eBird (eBird has most current bird taxonomy)
    if (isBird) {
      console.log(`\n🐦 ${logPrefix} Verifying bird with eBird...`);
      // Pass both scientific name and common name for better synonym resolution
      const eBirdResult = await verifyWithEBird(d.scientificName, d.commonName);
      
      // Use eBird species name - eBird taxonomy is authoritative for birds
      if (eBirdResult.verified && eBirdResult.found) {
        if (!eBirdResult.matches || eBirdResult.scientificName !== d.scientificName) {
          console.log(`   🔄 ${logPrefix} eBird name update: ${d.scientificName} → ${eBirdResult.scientificName}`);
          if (eBirdResult.nameUpdatedReason) {
            console.log(`   📝 Reason: ${eBirdResult.nameUpdatedReason}`);
          }
        }
        d.scientificName = eBirdResult.scientificName;
        d.commonName = eBirdResult.commonName;
        console.log(`   ✅ ${logPrefix} Using eBird taxonomy: ${d.scientificName} (${d.commonName})`);
      }
    }
    
    // Store identification result AFTER all name updates using chat-scoped cache
    const cacheKey = ResultCache.makeKey(targetChatId, d.scientificName);
    console.log(`   💾 ${logPrefix} Caching result with key: ${cacheKey}`);
    identificationCache.set(cacheKey, d);
    
    // Get iNaturalist reference photo (uses species only)
    console.log(`\n📷 ${logPrefix} Getting iNaturalist reference photo...`);
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
      await ctx.api.deleteMessage(targetChatId, statusMsg.message_id);
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
    // Use ctx.api.sendPhoto with targetChatId to ensure correct delivery
    console.log(`📤 ${logPrefix} Sending result to chat ${targetChatId}...`);
    
    if (iNatPhoto.found && iNatPhoto.photoUrl) {
      try {
        const compositeBuffer = await createCompositeImage(iNatPhoto.photoUrl, d);
        
        if (compositeBuffer) {
          const caption = linksText || '';
          await ctx.api.sendPhoto(targetChatId, new InputFile(compositeBuffer, 'identification.jpg'), {
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
          await ctx.api.sendPhoto(targetChatId, iNatPhoto.photoUrl, { 
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: followUpButtons }
          });
        }
      } catch (e) {
        console.log(`${logPrefix} Could not send composite image:`, e.message);
        const subspecies = d.taxonomy?.subspecies;
        const hasValidSubspecies = subspecies && 
          subspecies !== 'Not determined' && 
          subspecies !== 'Unable to determine from image' &&
          subspecies !== 'monotypic' &&
          !subspecies.toLowerCase().includes('unknown');
        const subspeciesText = hasValidSubspecies ? `\n\nSubspecies: _${subspecies}_` : '';
        await ctx.api.sendMessage(targetChatId, `*${d.commonName}*\n_${d.scientificName}_${subspeciesText}${linksText ? `\n\n${linksText}` : ''}`, { 
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
      await ctx.api.sendMessage(targetChatId, `*${d.commonName}*\n_${d.scientificName}_${subspeciesText}${linksText ? `\n\n${linksText}` : ''}`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: followUpButtons }
      });
    }
    
    console.log(`✅ ${logPrefix} Result sent to user ${targetUserId} in chat ${targetChatId}`);
    
  } catch (error) {
    console.error(`❌ ${logPrefix} Error:`, error);
    try {
      if (statusMsg) await ctx.api.deleteMessage(targetChatId, statusMsg.message_id);
    } catch (e) {}
    await ctx.api.sendMessage(targetChatId, `❌ Error: ${error.message}`);
  }
}

// ============================================
// ERROR HANDLERS
// Global error handling to prevent crashes
// ============================================

bot.catch((err) => {
  console.error('Bot error (handled, not crashing):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection (not crashing):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception (not crashing):', err.message);
});

// Graceful shutdown - cleanup all managers and caches
function gracefulShutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  requestManager.shutdown();
  rateLimiter.shutdown();
  identificationCache.shutdown();
  userImageCache.shutdown();
  console.log('All managers and caches cleaned up');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = bot;
