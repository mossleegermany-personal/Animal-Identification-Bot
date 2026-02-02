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
// Limits: 50 requests/week per group, 25 requests/week per user (PM)
// Resets every Monday 00:00 SST (UTC+8)
// ============================================

class WeeklyRateLimiter {
  constructor(options = {}) {
    /** @type {Map<string, {count: number, resetAt: number}>} key -> usage data */
    this.usage = new Map();
    
    // Configuration
    this.config = {
      maxGroupRequestsPerWeek: options.maxGroupRequestsPerWeek || 50,
      maxPmRequestsPerWeek: options.maxPmRequestsPerWeek || 25,
      timezone: options.timezone || 'Asia/Singapore',  // SST = UTC+8
    };
    
    // Schedule weekly reset check every hour
    this._resetTimer = setInterval(() => this._checkResets(), 3600000);
    
    console.log(`📊 WeeklyRateLimiter initialized: ${this.config.maxGroupRequestsPerWeek} requests/week per group, ${this.config.maxPmRequestsPerWeek} requests/week per user (PM)`);
  }

  /**
   * Check if chat is a private message (not a group)
   * @param {number} chatId
   * @returns {boolean}
   */
  _isPrivateChat(chatId) {
    // Private chats have positive IDs, groups have negative IDs
    return chatId > 0;
  }

  /**
   * Get the rate limit key based on chat type
   * @param {number} chatId
   * @param {number} userId
   * @returns {{key: string, limit: number, isPrivate: boolean}}
   */
  _getKeyAndLimit(chatId, userId) {
    const isPrivate = this._isPrivateChat(chatId);
    if (isPrivate) {
      // PM: limit by userId
      return {
        key: `user_${userId}`,
        limit: this.config.maxPmRequestsPerWeek,
        isPrivate: true,
      };
    } else {
      // Group: limit by chatId
      return {
        key: `group_${chatId}`,
        limit: this.config.maxGroupRequestsPerWeek,
        isPrivate: false,
      };
    }
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
   * Get or initialize usage data
   * @param {string} key
   * @returns {{count: number, resetAt: number}}
   */
  _getUsage(key) {
    if (!this.usage.has(key)) {
      this.usage.set(key, {
        count: 0,
        resetAt: this._getNextMondayReset(),
      });
    }
    
    const data = this.usage.get(key);
    
    // Check if reset time has passed
    if (Date.now() >= data.resetAt) {
      data.count = 0;
      data.resetAt = this._getNextMondayReset();
      console.log(`🔄 Rate limit reset for ${key}. Next reset: ${new Date(data.resetAt).toISOString()}`);
    }
    
    return data;
  }

  /**
   * Check if a request can be made
   * @param {number} chatId
   * @param {number} userId
   * @returns {{allowed: boolean, remaining: number, resetAt: number, resetIn: string, isPrivate: boolean}}
   */
  checkLimit(chatId, userId) {
    const { key, limit, isPrivate } = this._getKeyAndLimit(chatId, userId);
    const data = this._getUsage(key);
    const remaining = Math.max(0, limit - data.count);
    const resetIn = this._formatTimeUntilReset(data.resetAt);
    
    return {
      allowed: data.count < limit,
      remaining,
      resetAt: data.resetAt,
      resetIn,
      used: data.count,
      limit,
      isPrivate,
    };
  }

  /**
   * Consume one request
   * @param {number} chatId
   * @param {number} userId
   * @returns {{success: boolean, remaining: number}}
   */
  consume(chatId, userId) {
    const { key, limit, isPrivate } = this._getKeyAndLimit(chatId, userId);
    const data = this._getUsage(key);
    
    if (data.count >= limit) {
      return {
        success: false,
        remaining: 0,
        resetIn: this._formatTimeUntilReset(data.resetAt),
      };
    }
    
    data.count++;
    const remaining = limit - data.count;
    
    const typeLabel = isPrivate ? `User ${userId}` : `Group ${chatId}`;
    console.log(`📊 ${typeLabel} usage: ${data.count}/${limit} (${remaining} remaining)`);
    
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
   * @param {number} userId
   * @returns {string}
   */
  getResetTimeFormatted(chatId, userId) {
    const { key } = this._getKeyAndLimit(chatId, userId);
    const data = this._getUsage(key);
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
    for (const [key, data] of this.usage.entries()) {
      if (now >= data.resetAt) {
        data.count = 0;
        data.resetAt = this._getNextMondayReset();
        console.log(`🔄 Scheduled reset for ${key}`);
      }
    }
  }

  /**
   * Get usage stats
   * @param {number} chatId
   * @param {number} userId
   * @returns {Object}
   */
  getStats(chatId, userId) {
    const { key, limit, isPrivate } = this._getKeyAndLimit(chatId, userId);
    const data = this._getUsage(key);
    return {
      key,
      isPrivate,
      used: data.count,
      limit,
      remaining: Math.max(0, limit - data.count),
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

// Initialize rate limiter (50/week for groups, 25/week for PM)
const rateLimiter = new WeeklyRateLimiter({
  maxGroupRequestsPerWeek: 50,
  maxPmRequestsPerWeek: 25,
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

// Temporary storage for photos awaiting identification decision
const pendingPhotos = new Map(); // For single photos
const pendingPhotoGroups = new Map(); // For media groups

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
    `*Option 1:* Send a photo\n` +
    `• I'll automatically identify all animals\n\n` +
    `*Option 2:* Send photo with caption\n` +
    `• Caption: /id the bird on the left\n` +
    `• Specify what to identify\n\n` +
    `*Option 3:* Reply to any photo\n` +
    `• Reply with: /identify\n` +
    `• Reply with: /identify the butterfly\n\n` +
    `*Commands:*\n` +
    `/skip - Skip location input\n` +
    `/limit - Check weekly quota\n` +
    `/clear - Clear chat messages`,
    { parse_mode: 'Markdown' }
  );
});

// Limit command - check weekly usage
bot.command('limit', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const isPrivate = chatId > 0;
  console.log(`📩 /limit command received from ${isPrivate ? 'PM' : 'group'} (chat ${chatId}, user ${userId})`);
  
  const stats = rateLimiter.getStats(chatId, userId);
  const limitCheck = rateLimiter.checkLimit(chatId, userId);
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
  
  const limitType = isPrivate ? 'Your Personal' : 'Group';
  
  await ctx.reply(
    `📊 *${limitType} Weekly Usage Limit*\n\n` +
    `${progressBar}\n\n` +
    `${statusLine}\n` +
    `📦 Remaining: ${stats.remaining}\n\n` +
    `🔄 *Resets:* ${rateLimiter.getResetTimeFormatted(chatId, userId)}\n` +
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
  const userId = ctx.from?.id;
  
  if (chatId && userId) {
    const isPrivate = chatId > 0;
    const stats = rateLimiter.getStats(chatId, userId);
    const limitCheck = rateLimiter.checkLimit(chatId, userId);
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
    
    const limitType = isPrivate ? 'Your Personal' : 'Group';
    
    await ctx.reply(
      `📊 *${limitType} Weekly Usage Limit*\n\n` +
      `${progressBar}\n\n` +
      `${statusLine}\n` +
      `📦 Remaining: ${stats.remaining}\n\n` +
      `🔄 *Resets:* ${rateLimiter.getResetTimeFormatted(chatId, userId)}\n` +
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

// Identify command - reply to a photo to identify it
bot.command('identify', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const replyToMessage = ctx.message.reply_to_message;
  
  // Get target from command arguments (e.g., "/identify the bird on the left")
  const commandText = ctx.message.text || '';
  const targetFromCommand = commandText.replace(/^\/identify\s*/i, '').trim() || null;
  
  // Check if replying to a photo
  if (!replyToMessage?.photo) {
    await ctx.reply(
      `📷 *How to use /identify:*\n\n` +
      `Reply to a photo with /identify to identify the animal.\n\n` +
      `*Examples:*\n` +
      `• Reply with: /identify\n` +
      `• Reply with: /identify the bird on the left\n` +
      `• Or send a photo with caption: /id`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Check rate limit
  const limitCheck = rateLimiter.checkLimit(chatId, userId);
  if (!limitCheck.allowed) {
    const limitType = limitCheck.isPrivate ? 'your personal' : 'this group\'s';
    await ctx.reply(
      `⚠️ *Weekly limit reached*\n\n` +
      `You have used all ${limitCheck.limit} of ${limitType} identifications for this week.\n\n` +
      `🔄 Resets: ${rateLimiter.getResetTimeFormatted(chatId, userId)}\n` +
      `⏳ Time remaining: ${limitCheck.resetIn}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Delete the /identify command
  try {
    await ctx.api.deleteMessage(chatId, ctx.message.message_id);
  } catch (e) {}
  
  console.log(`🔍 /identify command on photo in chat ${chatId} by user ${userId}${targetFromCommand ? ` (target: "${targetFromCommand}")` : ''}`);
  
  // Create request and process the replied photo
  const request = requestManager.createRequest(ctx);
  
  try {
    // Get the largest photo
    const photos = replyToMessage.photo;
    const largestPhoto = photos[photos.length - 1];
    
    // Download image
    const file = await ctx.api.getFile(largestPhoto.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    let buffer = Buffer.from(await response.arrayBuffer());
    
    // Extract EXIF GPS
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
    
    // If target provided in command, skip target question
    if (targetFromCommand) {
      if (exifLocation) {
        // Has EXIF - process immediately
        await processIdentification(ctx, buffer, exifLocation, request.requestId, targetFromCommand);
        const consumed = rateLimiter.consume(chatId, userId);
        console.log(`📊 [${request.requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
        requestManager.completeAndRemove(request.requestId);
      } else {
        // Ask for location only
        const promptMsg = await ctx.reply(
          `🌍 *Where was this photo taken?*\n\n` +
          `Reply with location or /skip`,
          { parse_mode: 'Markdown' }
        );
        
        const req = requestManager.getRequest(request.requestId);
        if (req) {
          req.buffer = buffer;
          req.promptMsgId = promptMsg.message_id;
          req.status = 'pending';
          req.waitingFor = 'location';
          req.identifyTarget = targetFromCommand;
        }
      }
    } else if (exifLocation) {
      // Has EXIF location - process immediately (auto-identify all)
      await processIdentification(ctx, buffer, exifLocation, request.requestId, null);
      const consumed = rateLimiter.consume(chatId, userId);
      console.log(`📊 [${request.requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
      requestManager.completeAndRemove(request.requestId);
    } else {
      // No EXIF - ask for location only
      const promptMsg = await ctx.reply(
        `🌍 *Where was this photo taken?*\n\n` +
        `Reply with location or /skip`,
        { parse_mode: 'Markdown' }
      );
      
      const req = requestManager.getRequest(request.requestId);
      if (req) {
        req.buffer = buffer;
        req.promptMsgId = promptMsg.message_id;
        req.status = 'pending';
        req.waitingFor = 'location';
        req.identifyTarget = null; // Auto-identify all
      }
    }
  } catch (error) {
    requestManager.updateStatus(request.requestId, 'failed', { error });
    requestManager._removeRequest(request.requestId);
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// Shortcut command /id - same as /identify
bot.command('id', async (ctx) => {
  // Reuse the same logic as /identify
  const chatId = ctx.chat.id;
  const replyToMessage = ctx.message.reply_to_message;
  
  if (!replyToMessage?.photo) {
    await ctx.reply(
      `📷 *How to use /id:*\n\n` +
      `Reply to a photo with /id to identify the animal.\n\n` +
      `Or send a photo with caption: /id`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Forward to identify command logic by creating a fake context
  ctx.message.text = ctx.message.text.replace(/^\/id/, '/identify');
  await bot.handleUpdate({ message: ctx.message, update_id: Date.now() });
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
  const waitingFor = pendingRequest.waitingFor;
  const identifyTarget = pendingRequest.identifyTarget;
  const exifLocation = pendingRequest.exifLocation;
  
  console.log(`⏭️ [${requestId}] Skip ${waitingFor || 'location'} in chat ${chatId}${isMediaGroup ? ' (media group)' : ''}`);
  
  // Delete the prompt message
  try {
    await ctx.api.deleteMessage(chatId, pendingPromptMsgId);
  } catch (e) {}
  // Delete the /skip command
  try {
    await ctx.api.deleteMessage(chatId, ctx.message.message_id);
  } catch (e) {}
  
  // Update status to processing
  requestManager.updateStatus(requestId, 'processing');
  
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
      await processMediaGroupPhotos(ctx, processedPhotos, noLocation, requestId, identifyTarget);
    } catch (error) {
      requestManager.updateStatus(requestId, 'failed', { error });
      requestManager._removeRequest(requestId);
      await ctx.reply(`❌ Error processing photos: ${error.message}`);
    }
  } else if (pendingBuffer) {
    // Process single photo without location
    try {
      await processIdentification(ctx, pendingBuffer, noLocation, requestId, identifyTarget);
      // Consume rate limit on successful completion
      const consumed = rateLimiter.consume(chatId, userId);
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
    const userInput = ctx.message.text.trim();
    
    // Delete user's message
    try {
      await ctx.api.deleteMessage(chatId, ctx.message.message_id);
    } catch (e) {}
    
    // User is providing location
    const location = userInput;
    
    // Capture values locally to ensure correct context
    const pendingBuffer = pendingRequest.buffer;
    const pendingPromptMsgId = pendingRequest.promptMsgId;
    const isMediaGroup = pendingRequest.isMediaGroup;
    const processedPhotos = pendingRequest.processedPhotos;
    const statusMsgId = pendingRequest.statusMsgId;
    const identifyTarget = pendingRequest.identifyTarget;
    
    console.log(`📍 [${requestId}] Location received in chat ${chatId}: "${location}"${isMediaGroup ? ' (media group)' : ''}`);
    
    // Update status to processing BEFORE any async operations
    requestManager.updateStatus(requestId, 'processing');
    
    // Delete the location prompt message
    try {
      await ctx.api.deleteMessage(chatId, pendingPromptMsgId);
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
        await processMediaGroupPhotos(ctx, processedPhotos, location, requestId, identifyTarget);
      } catch (error) {
        requestManager.updateStatus(requestId, 'failed', { error });
        requestManager._removeRequest(requestId);
        await ctx.reply(`❌ Error processing photos: ${error.message}`);
      }
    } else {
      // Process single photo with captured context
      try {
        await processIdentification(ctx, pendingBuffer, location, requestId, identifyTarget);
        // Consume rate limit on successful completion
        const consumed = rateLimiter.consume(chatId, userId);
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
  const userId = ctx.from.id;
  
  // Handle identification decision buttons (Yes/No)
  if (data.startsWith('id_yes_') || data.startsWith('id_no_')) {
    const match = data.match(/^id_(yes|no)_(.+)$/);
    if (!match) return;
    
    const decision = match[1]; // 'yes' or 'no'
    const key = match[2]; // photo or group key
    
    // Answer callback first to remove loading state
    await ctx.answerCallbackQuery();
    
    // Delete the prompt message (the one with buttons)
    try {
      await ctx.deleteMessage();
    } catch (e) {
      console.log(`⚠️ Could not delete prompt message: ${e.message}`);
    }
    
    if (decision === 'no') {
      // User declined identification - clean up
      pendingPhotos.delete(key);
      pendingPhotoGroups.delete(key);
      console.log(`📷 User ${userId} declined identification in chat ${chatId}`);
      return;
    }
    
    // User wants identification
    console.log(`✅ User ${userId} requested identification in chat ${chatId}`);
    
    // Check rate limit
    const limitCheck = rateLimiter.checkLimit(chatId, userId);
    if (!limitCheck.allowed) {
      const limitType = limitCheck.isPrivate ? 'your personal' : 'this group\'s';
      await ctx.reply(
        `⚠️ *Weekly limit reached*\n\n` +
        `You have used all ${limitCheck.limit} of ${limitType} identifications for this week.\n\n` +
        `🔄 Resets: ${rateLimiter.getResetTimeFormatted(chatId, userId)}\n` +
        `⏳ Time remaining: ${limitCheck.resetIn}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Check if it's a photo group or single photo
    if (key.startsWith('group_')) {
      const groupData = pendingPhotoGroups.get(key);
      if (!groupData) {
        await ctx.reply('❌ Photo data expired. Please send the photos again.');
        return;
      }
      
      pendingPhotoGroups.delete(key);
      
      // Check quota for all photos
      const photoCount = groupData.photos.length;
      if (limitCheck.remaining < photoCount) {
        await ctx.reply(
          `⚠️ *Not enough quota*\n\n` +
          `You have ${photoCount} photos but only ${limitCheck.remaining} identifications remaining.\n\n` +
          `🔄 Resets: ${rateLimiter.getResetTimeFormatted(chatId, userId)}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      
      // Process the media group
      await processMediaGroup(groupData.photos, chatId, null);
      
    } else if (key.startsWith('photo_')) {
      const photoData = pendingPhotos.get(key);
      if (!photoData) {
        await ctx.reply('❌ Photo data expired. Please send the photo again.');
        return;
      }
      
      pendingPhotos.delete(key);
      
      // Use the original chat ID and thread ID where the photo was sent (important for groups/forums)
      const targetChatId = photoData.chatId;
      const targetThreadId = photoData.threadId;
      
      // Create a request for tracking
      const request = requestManager.createRequest(ctx, { chatId: targetChatId, userId, threadId: targetThreadId });
      
      console.log(`📸 [${request.requestId}] Processing single photo from button for chat ${targetChatId}${targetThreadId ? ` thread ${targetThreadId}` : ''} (${limitCheck.remaining} requests remaining)`);
      
      // Process the photo using stored file_id, original chat ID and thread ID
      processSinglePhotoFromFileId(ctx, photoData.fileId, request, targetChatId, targetThreadId)
        .catch(err => {
          requestManager.updateStatus(request.requestId, 'failed', { error: err });
          ctx.api.sendMessage(targetChatId, `❌ Error: ${err.message}`).catch(() => {});
        });
    }
    return;
  }
  
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
// When a photo is uploaded, ask if user wants to identify it
// Also supports replying to any photo with /identify
// ============================================

bot.on('message:photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const messageId = ctx.message.message_id;
  const mediaGroupId = ctx.message.media_group_id;
  
  // For media groups, only show prompt once (on first photo)
  if (mediaGroupId) {
    const collectedPhotos = await mediaGroupCollector.addPhoto(mediaGroupId, ctx);
    
    if (collectedPhotos) {
      // All photos collected - show identification prompt
      const photoCount = collectedPhotos.length;
      
      // Check rate limit first
      const limitCheck = rateLimiter.checkLimit(chatId, userId);
      if (!limitCheck.allowed) {
        // Don't show prompt if rate limited
        console.log(`📷 ${photoCount} photos shared by user ${userId} in chat ${chatId} (rate limited)`);
        return;
      }
      
      // Store collected photos temporarily for later processing
      const groupKey = `group_${chatId}_${userId}_${Date.now()}`;
      pendingPhotoGroups.set(groupKey, {
        photos: collectedPhotos,
        chatId,
        userId,
        timestamp: Date.now(),
      });
      
      // Auto-expire after 5 minutes
      setTimeout(() => pendingPhotoGroups.delete(groupKey), 5 * 60 * 1000);
      
      // Show prompt with buttons
      await ctx.reply(
        `📸 *${photoCount} photo${photoCount > 1 ? 's' : ''} received!*\n\n` +
        `Would you like me to identify the animals?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Yes, identify', callback_data: `id_yes_${groupKey}` },
              { text: '❌ No thanks', callback_data: `id_no_${groupKey}` }
            ]]
          }
        }
      );
      
      console.log(`📷 ${photoCount} photos shared in chat ${chatId} - awaiting identification decision`);
    }
    return;
  }
  
  // Single photo - check rate limit first
  const limitCheck = rateLimiter.checkLimit(chatId, userId);
  if (!limitCheck.allowed) {
    // Don't show prompt if rate limited
    console.log(`📷 Photo shared by user ${userId} in chat ${chatId} (rate limited)`);
    return;
  }
  
  // Get the largest photo (highest resolution)
  const photos = ctx.message.photo;
  const largestPhoto = photos[photos.length - 1];
  
  // Get message_thread_id for forum topics (like Wildlife topic)
  const threadId = ctx.message.message_thread_id;
  
  // Store photo info temporarily for later processing (include photo file_id)
  const photoKey = `photo_${chatId}_${userId}_${messageId}`;
  pendingPhotos.set(photoKey, {
    messageId,
    chatId,
    userId,
    fileId: largestPhoto.file_id,
    threadId, // Forum topic thread ID
    timestamp: Date.now(),
  });
  
  // Auto-expire after 5 minutes
  setTimeout(() => pendingPhotos.delete(photoKey), 5 * 60 * 1000);
  
  // Show prompt with buttons
  await ctx.reply(
    `📸 *Photo received!*\n\n` +
    `Would you like me to identify the animal?`,
    {
      parse_mode: 'Markdown',
      reply_to_message_id: messageId,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Yes, identify', callback_data: `id_yes_${photoKey}` },
          { text: '❌ No thanks', callback_data: `id_no_${photoKey}` }
        ]]
      }
    }
  );
  
  console.log(`📷 Photo shared in chat ${chatId} by user ${userId} - awaiting identification decision`);
});

/**
 * Process a single photo from file_id (used by button callback)
 * @param {Context} ctx - grammy context
 * @param {string} fileId - Telegram file ID
 * @param {Object} request - Request object from RequestManager
 * @param {number} targetChatId - Target chat ID to send results to
 * @param {number} [targetThreadId] - Target thread ID for forum topics
 */
async function processSinglePhotoFromFileId(ctx, fileId, request, targetChatId, targetThreadId) {
  const { requestId } = request;
  const chatId = targetChatId || ctx.callbackQuery?.message?.chat?.id || ctx.chat?.id;
  const threadId = targetThreadId || ctx.callbackQuery?.message?.message_thread_id;
  console.log(`🎯 [${requestId}] Target chat for results: ${chatId}${threadId ? ` (thread ${threadId})` : ''}`);
  
  try {
    requestManager.updateStatus(requestId, 'processing');
    
    // Download image from Telegram
    console.log(`📥 [${requestId}] Downloading image...`);
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    let buffer = Buffer.from(await response.arrayBuffer());
    
    // Extract EXIF GPS coordinates BEFORE any image processing
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
    } catch (e) {}
    
    // Process image for analysis
    console.log(`🖼️ [${requestId}] Processing image...`);
    buffer = await sharp(buffer)
      .rotate()
      .withMetadata()
      .png({ compressionLevel: 0, effort: 1 })
      .toBuffer();
    
    if (exifLocation) {
      // Has EXIF location - process immediately (auto-identify all)
      console.log(`📍 [${requestId}] Has EXIF location, processing immediately...`);
      await processIdentificationWithChatId(ctx, buffer, exifLocation, requestId, null, chatId, threadId);
      const consumed = rateLimiter.consume(chatId, ctx.from.id);
      console.log(`📊 [${requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
      requestManager.completeAndRemove(requestId);
    } else {
      // No EXIF - ask for location only
      const promptMsg = await ctx.api.sendMessage(chatId,
        `🌍 *Where was this photo taken?*\n\n` +
        `Reply with location or /skip`,
        { parse_mode: 'Markdown', message_thread_id: threadId }
      );
      
      // Store request state for location input
      const req = requestManager.getRequest(requestId);
      if (req) {
        req.buffer = buffer;
        req.promptMsgId = promptMsg.message_id;
        req.waitingFor = 'location';
        req.identifyTarget = null; // Auto-identify all
        req.chatId = chatId;
        req.threadId = threadId; // Forum topic thread ID
        req.status = 'pending';
      }
      
      console.log(`⏳ [${requestId}] Waiting for location input...`);
    }
    
  } catch (error) {
    console.error(`❌ [${requestId}] Error:`, error.message);
    requestManager.completeAndRemove(requestId);
    throw error;
  }
}

/**
 * Process a media group (multiple photos)
 * @param {MediaGroupPhoto[]} photos - Array of collected photos
 * @param {number} chatId - Chat ID
 * @param {string} [captionTarget] - What to identify from caption
 */
async function processMediaGroup(photos, chatId, captionTarget = null) {
  const firstCtx = photos[0].ctx;
  const photoCount = photos.length;
  
  // If target provided in caption, skip the "what to identify" question
  if (captionTarget) {
    // Send initial status message
    const statusMsg = await firstCtx.reply(
      `📸 *Processing ${photoCount} photo${photoCount > 1 ? 's' : ''}...*\n\n` +
      `🎯 Looking for: ${captionTarget}`,
      { parse_mode: 'Markdown' }
    );
    
    // Ask for location
    const promptMsg = await firstCtx.reply(
      `🌍 *Where were these photos taken?*\n\n` +
      `Reply with location or /skip`,
      { parse_mode: 'Markdown' }
    );
    
    // Store as pending request
    const groupRequest = requestManager.createRequest(firstCtx, {
      isMediaGroup: true,
      photoCount,
    });
    
    // Download and process all images in parallel (same as before)
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
    
    // Check for EXIF location
    const exifLocation = processedPhotos.find(p => p.exifLocation)?.exifLocation;
    
    if (exifLocation) {
      // Has EXIF - delete prompts and process
      try {
        await firstCtx.api.deleteMessage(chatId, statusMsg.message_id);
        await firstCtx.api.deleteMessage(chatId, promptMsg.message_id);
      } catch (e) {}
      
      await processMediaGroupPhotos(firstCtx, processedPhotos, exifLocation, groupRequest.requestId, captionTarget);
    } else {
      // No EXIF - wait for location
      const req = requestManager.getRequest(groupRequest.requestId);
      if (req) {
        req.processedPhotos = processedPhotos;
        req.promptMsgId = promptMsg.message_id;
        req.statusMsgId = statusMsg.message_id;
        req.isMediaGroup = true;
        req.buffer = true;
        req.status = 'pending';
        req.waitingFor = 'location';
        req.identifyTarget = captionTarget;
      }
    }
    return;
  }
  
  // No caption target - auto-identify all animals
  // Create request and download all photos
  const groupRequest = requestManager.createRequest(firstCtx, {
    isMediaGroup: true,
    photoCount,
  });
  
  // Send initial status message
  const statusMsg = await firstCtx.reply(
    `📸 *Processing ${photoCount} photo${photoCount > 1 ? 's' : ''}...*\n\n` +
    `Each photo will be identified separately.`,
    { parse_mode: 'Markdown' }
  );
  
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
    // Has EXIF location - process immediately (auto-identify all)
    console.log(`📍 Using EXIF location for media group: ${exifLocation}`);
    
    // Delete status message
    try {
      await firstCtx.api.deleteMessage(chatId, statusMsg.message_id);
    } catch (e) {}
    
    // Process all photos with the location
    await processMediaGroupPhotos(firstCtx, processedPhotos, exifLocation, groupRequest.requestId, null);
  } else {
    // No EXIF - ask for location only
    const promptMsg = await firstCtx.reply(
      `🌍 *Where were these photos taken?*\n\n` +
      `Reply with location or /skip`,
      { parse_mode: 'Markdown' }
    );
    
    // Store pending data
    const req = requestManager.getRequest(groupRequest.requestId);
    if (req) {
      req.processedPhotos = processedPhotos;
      req.promptMsgId = promptMsg.message_id;
      req.statusMsgId = statusMsg.message_id;
      req.isMediaGroup = true;
      req.buffer = true; // Flag that we have data waiting
      req.status = 'pending';
      req.waitingFor = 'location';
      req.identifyTarget = null; // Auto-identify all
    }
  }
}

/**
 * Process all photos in a media group with a location
 * @param {Object} ctx - Grammy context
 * @param {Array} processedPhotos - Array of processed photo data
 * @param {string} location - Location string
 * @param {string} requestId - Request ID
 * @param {string} [identifyTarget] - What to identify in the photos
 */
async function processMediaGroupPhotos(ctx, processedPhotos, location, requestId, identifyTarget = null) {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
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
      const result = await identifyAnimal(photo.buffer, 'image/jpeg', { location, identifyTarget });
      
      if (result.success && result.data.identified) {
        results.push({
          index: photo.index,
          success: true,
          data: result.data,
          buffer: photo.buffer,
        });
        
        // Consume rate limit for successful identification
        rateLimiter.consume(chatId, userId);
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
    const targetNotFound = failed.filter(f => f.reason === 'target_not_found');
    const otherFails = failed.filter(f => !['low_resolution', 'obstructed', 'too_distant', 'poor_quality', 'no_animal', 'target_not_found'].includes(f.reason));
    
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
    
    if (targetNotFound.length > 0) {
      if (failMsg) failMsg += '\n\n';
      failMsg += `🔍 ${targetNotFound.length} photo${targetNotFound.length > 1 ? 's' : ''}: Could not find the specified subject.`;
      failMsg += `\n💡 *Tip:* Try sending photos without a caption to auto-identify all animals.`;
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
 * @param {string} [captionTarget] - What to identify from caption
 */
async function processPhotoWithContext(ctx, request, captionTarget = null) {
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
    
    // If target was provided in caption, skip the "what to identify" question
    if (captionTarget) {
      console.log(`🎯 [${requestId}] Target from caption: "${captionTarget}"`);
      
      if (exifLocation) {
        // Has EXIF location - process immediately
        console.log(`📍 [${requestId}] Using EXIF location, starting identification...`);
        await processIdentification(ctx, buffer, exifLocation, requestId, captionTarget);
        const consumed = rateLimiter.consume(ctx.chat.id, ctx.from.id);
        console.log(`📊 [${requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
        requestManager.completeAndRemove(requestId);
      } else {
        // No EXIF - ask for location only
        const promptMsg = await ctx.reply(
          `🌍 *Where was this photo taken?*\n\n` +
          `Reply with location or /skip`,
          { parse_mode: 'Markdown' }
        );
        
        const req = requestManager.getRequest(requestId);
        if (req) {
          req.buffer = buffer;
          req.promptMsgId = promptMsg.message_id;
          req.status = 'pending';
          req.waitingFor = 'location';
          req.identifyTarget = captionTarget;
          console.log(`⏳ [${requestId}] Waiting for location input...`);
        }
      }
    } else if (exifLocation) {
      // No caption target, but has GPS - process immediately (auto-identify all)
      console.log(`📍 [${requestId}] Has EXIF location, processing immediately...`);
      await processIdentification(ctx, buffer, exifLocation, requestId, null);
      const consumed = rateLimiter.consume(ctx.chat.id, ctx.from.id);
      console.log(`📊 [${requestId}] Rate limit consumed: ${consumed.used} used, ${consumed.remaining} remaining`);
      requestManager.completeAndRemove(requestId);
    } else {
      // No caption target, no EXIF - ask for location only
      console.log(`📍 [${requestId}] No EXIF GPS, asking for location...`);
      const promptMsg = await ctx.reply(
        `🌍 *Where was this photo taken?*\n\n` +
        `Reply with location or /skip`,
        { parse_mode: 'Markdown' }
      );
      
      // Update request with pending photo data
      const req = requestManager.getRequest(requestId);
      if (req) {
        req.buffer = buffer;
        req.promptMsgId = promptMsg.message_id;
        req.status = 'pending';
        req.waitingFor = 'location';
        req.identifyTarget = null; // Auto-identify all
        console.log(`⏳ [${requestId}] Waiting for location input...`);
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
 * Process animal identification with explicit chat ID
 * Wrapper that ensures results are sent to the correct chat/thread
 * @param {Object} ctx - Grammy context
 * @param {Buffer} buffer - Image buffer
 * @param {string} location - Location string
 * @param {string} requestId - Request ID for logging
 * @param {string} identifyTarget - What to identify
 * @param {number} targetChatId - Target chat ID to send results to
 * @param {number} [targetThreadId] - Target thread ID for forum topics
 */
async function processIdentificationWithChatId(ctx, buffer, location, requestId, identifyTarget, targetChatId, targetThreadId) {
  console.log(`🎯 [${requestId}] processIdentificationWithChatId targeting chat: ${targetChatId}${targetThreadId ? ` thread: ${targetThreadId}` : ''}`);
  
  // Create a proxy context that redirects all messages to the target chat/thread
  const modifiedCtx = {
    chat: { id: targetChatId },
    from: ctx.from,
    api: ctx.api,
    threadId: targetThreadId, // Store for use in processIdentification
    // Override reply to always send to target chat and thread
    reply: (text, options = {}) => {
      console.log(`📤 [${requestId}] Sending message to chat ${targetChatId}${targetThreadId ? ` thread ${targetThreadId}` : ''}`);
      return ctx.api.sendMessage(targetChatId, text, { ...options, message_thread_id: targetThreadId });
    },
  };
  
  return processIdentification(modifiedCtx, buffer, location, requestId, identifyTarget);
}

/**
 * Process animal identification
 * @param {Object} ctx - Grammy context (bound to specific user/chat)
 * @param {Buffer} buffer - Image buffer
 * @param {string} location - Location string
 * @param {string} [requestId] - Request ID for logging
 * @param {string} [identifyTarget] - What to identify in the image
 */
async function processIdentification(ctx, buffer, location, requestId = 'unknown', identifyTarget = null) {
  let statusMsg;
  const logPrefix = `[${requestId}]`;
  
  // Capture user/chat context at start to ensure correct delivery
  const targetChatId = ctx.chat.id;
  const targetUserId = ctx.from.id;
  const targetThreadId = ctx.threadId; // For forum topics
  
  console.log(`🎯 ${logPrefix} processIdentification: chat=${targetChatId}, thread=${targetThreadId || 'none'}`);
  
  try {
    // Simple status message
    statusMsg = await ctx.reply('🔬 *Analyzing...*', { parse_mode: 'Markdown' });

    // Step 1: Identify with Gemini 2.5 Pro
    console.log(`\n🤖 ${logPrefix} Starting Gemini 2.5 Pro analysis...`);
    if (identifyTarget) {
      console.log(`   🎯 Target: "${identifyTarget}"`);
    }
    const result = await identifyAnimal(buffer, 'image/jpeg', { location, identifyTarget });
    
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
        'no_animal': '🚫',
        'target_not_found': '🔍'
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
      } else if (reason === 'target_not_found') {
        errorMsg = `${icon} *Subject Not Found*\n\nCould not find the specified animal in the image.`;
      } else {
        errorMsg = `❌ *Could not identify animal*\n\n${reason}`;
      }
      
      // Add suggestion if available
      if (suggestion) {
        errorMsg += `\n\n💡 *Tip:* ${suggestion}`;
      } else if (['low_resolution', 'obstructed', 'too_distant', 'poor_quality'].includes(reason)) {
        errorMsg += `\n\n💡 *Tip:* Try sending a clearer, higher resolution photo with an unobstructed view of the animal.`;
      } else if (reason === 'target_not_found') {
        errorMsg += `\n\n💡 *Tip:* Try sending the photo without a caption to auto-identify all animals.`;
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
    console.log(`📤 ${logPrefix} Sending result to chat ${targetChatId}${targetThreadId ? ` thread ${targetThreadId}` : ''}...`);
    
    if (iNatPhoto.found && iNatPhoto.photoUrl) {
      try {
        const compositeBuffer = await createCompositeImage(iNatPhoto.photoUrl, d);
        
        if (compositeBuffer) {
          const caption = linksText || '';
          const sentMsg = await ctx.api.sendPhoto(targetChatId, new InputFile(compositeBuffer, 'identification.jpg'), {
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: followUpButtons },
            message_thread_id: targetThreadId
          });
          console.log(`✅ ${logPrefix} Photo sent, message_id: ${sentMsg.message_id}`);
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
            reply_markup: { inline_keyboard: followUpButtons },
            message_thread_id: targetThreadId
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
          reply_markup: { inline_keyboard: followUpButtons },
          message_thread_id: targetThreadId
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
        reply_markup: { inline_keyboard: followUpButtons },
        message_thread_id: targetThreadId
      });
    }
    
    console.log(`✅ ${logPrefix} Result sent to user ${targetUserId} in chat ${targetChatId}${targetThreadId ? ` thread ${targetThreadId}` : ''}`);
    
  } catch (error) {
    console.error(`❌ ${logPrefix} Error:`, error);
    try {
      if (statusMsg) await ctx.api.deleteMessage(targetChatId, statusMsg.message_id);
    } catch (e) {}
    await ctx.api.sendMessage(targetChatId, `❌ Error: ${error.message}`, { message_thread_id: targetThreadId });
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
