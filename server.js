require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { bech32 } = require('bech32');
const Queue = require('express-queue');
const winston = require('winston');
require('winston-daily-rotate-file');
const { BotPlayer, getRandomBotSpawnDelay, generateBotLightningAddress } = require('./botLogic');

// Configure Winston logging with Sea Battle style loggers
const transactionLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/transactions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '90d',
      maxSize: '20m',
      archiveCompressed: true
    })
  ]
});

const gameLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/games-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
      archiveCompressed: true
    })
  ]
});

const errorLogger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
      archiveCompressed: true
    })
  ]
});

const playerSessionLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/player-sessions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '90d',
      maxSize: '50m',
      archiveCompressed: true
    })
  ]
});

// Helper function to log player sessions
function logPlayerSession(lightningAddress, sessionData) {
  playerSessionLogger.info({
    lightningAddress,
    ...sessionData,
    timestamp: new Date().toISOString()
  });
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Prefer IPv4 DNS resolution to avoid IPv6-related DNS/socket issues
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
const ipv4Lookup = (hostname, options, cb) => dns.lookup(hostname, { family: 4, all: false }, cb);
const httpAgent = new http.Agent({ keepAlive: true, lookup: ipv4Lookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: ipv4Lookup, rejectUnauthorized: true });
const httpClient = axios.create({ 
  httpAgent, 
  httpsAgent,
  timeout: 10000,
  headers: {
    'User-Agent': 'TicTacToe/1.0'
  }
});

const SPEED_API_BASE = process.env.SPEED_API_BASE || 'https://api.tryspeed.com';
const AUTH_HEADER = Buffer.from(`${process.env.SPEED_WALLET_SECRET_KEY}:`).toString('base64');
const PUB_AUTH_HEADER = process.env.SPEED_WALLET_PUBLISHABLE_KEY ? Buffer.from(`${process.env.SPEED_WALLET_PUBLISHABLE_KEY}:`).toString('base64') : null;
const SPEED_INVOICE_AUTH_MODE = (process.env.SPEED_INVOICE_AUTH_MODE || 'auto').toLowerCase();

const app = express();
// Trust the first proxy hop (common for cloud platforms like Render/Heroku)
// This allows express-rate-limit to correctly read client IPs via X-Forwarded-For
app.set('trust proxy', 1);
const server = http.createServer(app);
// CORS origin from env (must be defined before using in Socket.IO)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const io = socketIo(server, {
  cors: {
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN,
    methods: ['GET', 'POST']
  }
});

// CORS
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));
app.use(express.json({
  verify: (req, res, buf) => {
    // Keep a copy of the raw body for webhook signature verification
    req.rawBody = buf.toString('utf8');
  }
}));


if (!process.env.SPEED_WALLET_SECRET_KEY || !process.env.SPEED_WALLET_WEBHOOK_SECRET) {
  console.error('Missing Speed Wallet secrets. Set SPEED_WALLET_SECRET_KEY and SPEED_WALLET_WEBHOOK_SECRET.');
  process.exit(1);
}

// Webhook protections
const webhookLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const webhookQueue = require('express-queue')({ activeLimit: 1, queuedLimit: -1 });


// Speed wallet payout mappings - EXACTLY matching bet amounts to winnings
const PAYOUTS = {
  50: { winner: 80, platformFee: 20 },
  300: { winner: 500, platformFee: 100 },
  500: { winner: 800, platformFee: 200 },
  1000: { winner: 1700, platformFee: 300 },
  5000: { winner: 8000, platformFee: 2000 },
  10000: { winner: 17000, platformFee: 3000 }
};

// Note: Removed any outcome pattern logic to ensure fair gameplay

const ALLOWED_BETS = [50, 300, 500, 1000, 5000, 10000];

// --- In-memory stores ---
const players = {}; // socketId -> { lightningAddress, acctId, betAmount, paid, gameId }
const invoiceToSocket = {}; // invoiceId -> socketId
const invoiceMeta = {}; // invoiceId -> { betAmount, lightningAddress }
const userSessions = {}; // Maps acct_id to Lightning address
const playerAcctIds = {}; // Maps playerId to acct_id
const processedWebhooks = new Set();

// Bot management
const activeBots = new Map(); // gameId -> BotPlayer instance

// Function to store or retrieve acct_id for Lightning address
function mapUserAcctId(acctId, lightningAddress) {
  userSessions[acctId] = lightningAddress;
  console.log(`Mapped acct_id ${acctId} to Lightning address: ${lightningAddress}`);
}

// Function to get Lightning address by acct_id
function getLightningAddressByAcctId(acctId) {
  return userSessions[acctId];
}

// Removed betting pattern storage/loading to ensure fair gameplay

// Real Speed wallet payment functions from Sea Battle
// Function to get current BTC to USD rate
async function getCurrentBTCRate() {
  try {
    const response = await httpClient.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
      timeout: 5000
    });
    const btcPrice = response.data.bitcoin.usd;
    console.log('Current BTC price:', btcPrice, 'USD');
    return btcPrice;
  } catch (error) {
    console.error('Failed to fetch BTC rate, using fallback:', error.message);
    return 45000; // Fallback price
  }
}

// Function to convert SATS to USD
async function convertSatsToUSD(amountSats) {
  try {
    const btcPrice = await getCurrentBTCRate();
    const btcAmount = amountSats / 100000000; // SATS -> BTC
    const usdAmount = btcAmount * btcPrice;
    console.log(`Converted ${amountSats} SATS to ${usdAmount.toFixed(2)} USD (BTC rate: $${btcPrice})`);
    return parseFloat(usdAmount.toFixed(2));
  } catch (error) {
    console.error('Error converting SATS to USD:', error.message);
    return parseFloat(((amountSats / 100000000) * 45000).toFixed(2));
  }
}

async function resolveLightningAddress(address, amountSats) {
  try {
    console.log('Resolving Lightning address:', address, 'with amount:', amountSats, 'SATS');
    const [username, domain] = address.split('@');
    if (!username || !domain) {
      throw new Error('Invalid Lightning address');
    }

    const lnurl = `https://${domain}/.well-known/lnurlp/${username}`;
    console.log('Fetching LNURL metadata from:', lnurl);

    const metadataResponse = await httpClient.get(lnurl, { timeout: 5000 });
    const metadata = metadataResponse.data;
    console.log('Received LNURL metadata:', metadata);

    if (metadata.tag !== 'payRequest') {
      throw new Error('Invalid LNURL metadata: not a payRequest');
    }

    const amountMsats = amountSats * 1000;
    console.log(`Attempting to send ${amountSats} SATS (${amountMsats} msats)`);

    if (amountMsats < metadata.minSendable || amountMsats > metadata.maxSendable) {
      const errorMsg = `Invalid amount: ${amountSats} SATS is not within the sendable range`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    const callback = metadata.callback;
    const invoiceResponse = await httpClient.get(`${callback}?amount=${amountMsats}`, { timeout: 5000 });
    const invoice = invoiceResponse.data.pr;

    if (!invoice) {
      throw new Error('No invoice in response');
    }

    return invoice;
  } catch (error) {
    const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
    const errorStatus = error.response?.status || 'No status';
    const errorDetails = error.response?.data || error.message;
    console.error('Create Invoice Error:', {
      message: errorMessage,
      status: errorStatus,
      details: errorDetails,
    });
    throw new Error(`Failed to create invoice: ${errorMessage} (Status: ${errorStatus})`);
  }
}

// Create a Lightning invoice via Speed Wallet
async function createLightningInvoice(amountSats, customerId, orderId) {
  const mode = (SPEED_INVOICE_AUTH_MODE || 'auto').toLowerCase();
  const tryPublishable = mode !== 'secret';
  const trySecret = mode !== 'publishable';

  const amountUSD = await convertSatsToUSD(amountSats);

  const payload = {
    currency: 'SATS',
    amount: amountSats,
    target_currency: 'SATS',
    ttl: 600, // 10 minutes for payment
    description: `Tic-Tac-Toe Game - ${amountSats} SATS`,
    metadata: {
      Order_ID: orderId,
      Customer_ID: customerId,
      Game_Type: 'Tic_Tac_Toe',
      Amount_SATS: amountSats.toString()
    }
  };

  async function attemptCreate(header, label, extraHeaders = {}) {
    console.log(`Creating Lightning invoice via Speed (${label})`, { amountSats, orderId, mode });
    const resp = await axios.post(`${SPEED_API_BASE}/payments`, payload, {
      headers: {
        Authorization: `Basic ${header}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      timeout: 10000,
    });

    const data = resp.data;
    const invoiceId = data.id;
    const hostedInvoiceUrl = data.hosted_invoice_url || data.hosted_checkout_url || data.checkout_url || null;

    let lightningInvoice =
      data.payment_method_options?.lightning?.payment_request ||
      data.lightning_invoice ||
      data.invoice ||
      data.payment_request ||
      data.bolt11 ||
      null;

    if (!lightningInvoice && hostedInvoiceUrl) {
      console.log(`[${label}] No direct Lightning invoice found; using hosted URL`);
      lightningInvoice = hostedInvoiceUrl;
    }

    if (!invoiceId) {
      throw new Error(`[${label}] No invoice ID returned from Speed API`);
    }

    return {
      invoiceId,
      hostedInvoiceUrl,
      lightningInvoice,
      amountUSD,
      amountSats,
      speedInterfaceUrl: hostedInvoiceUrl,
    };
  }

  // Try publishable mode first if configured
  if (tryPublishable && PUB_AUTH_HEADER) {
    try {
      return await attemptCreate(PUB_AUTH_HEADER, 'publishable');
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.errors?.[0]?.message || error.message;
      console.error(`Publishable invoice failed:`, error.response?.data || error.message);
      
      // Check if we should fallback to secret mode
      const shouldFallback = trySecret && [401, 403, 422].includes(Number(status));
      if (!shouldFallback) {
        throw new Error(`Failed to create invoice (publishable): ${msg} (Status: ${status || 'n/a'})`);
      }
      console.log('Falling back to secret mode due to publishable failure');
    }
  }

  // Try secret mode if configured
  if (trySecret && AUTH_HEADER) {
    try {
      return await attemptCreate(AUTH_HEADER, 'secret', { 'speed-version': '2022-04-15' });
    } catch (error) {
      const status = error.response?.status;
      const msg = error.response?.data?.errors?.[0]?.message || error.message;
      throw new Error(`Failed to create invoice (secret): ${msg} (Status: ${status || 'n/a'})`);
    }
  }

  throw new Error('No valid invoice auth mode available. Set SPEED_INVOICE_AUTH_MODE to publishable|secret|auto.');
}

// New Speed Wallet payment via /payments (BOLT11 or Lightning address)
async function sendPayment(destination, amount, note = '') {
  try {
    let invoice = destination;

    if (typeof destination === 'string') {
      const lower = destination.toLowerCase();
      if (lower.startsWith('lnurl')) {
        invoice = await decodeAndFetchLnUrl(destination);
      } else if (destination.includes('@')) {
        if (!amount || Number(amount) <= 0) {
          throw new Error('amountSats required for Lightning address payments');
        }
        invoice = await resolveLightningAddress(destination, Number(amount));
      }
    }

    if (!invoice || typeof invoice !== 'string' || !invoice.toLowerCase().startsWith('ln')) {
      throw new Error('Invalid or malformed invoice');
    }

    const paymentPayload = { payment_request: invoice };

    const response = await httpClient.post(
      `${SPEED_API_BASE}/payments`,
      paymentPayload,
      {
        headers: {
          Authorization: `Basic ${AUTH_HEADER}`,
          'Content-Type': 'application/json',
          'speed-version': '2022-04-15',
        },
        timeout: 10000,
      }
    );

    console.log('Payment response:', response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
    const errorStatus = error.response?.status || 'No status';
    const errorDetails = error.response?.data || error.message;
    console.error('Send Payment Error:', {
      message: errorMessage,
      status: errorStatus,
      details: errorDetails,
    });
    throw new Error(`Failed to send payment: ${errorMessage} (Status: ${errorStatus})`);
  }
}

// Decode bech32 LNURL and fetch a minimal BOLT11 invoice
async function decodeAndFetchLnUrl(lnUrl) {
  try {
    console.log('Decoding LN-URL:', lnUrl);
    const { words } = bech32.decode(lnUrl, 2000);
    const decoded = bech32.fromWords(words);
    const url = Buffer.from(decoded).toString('utf8');
    console.log('Decoded LN-URL to URL:', url);

    const response = await httpClient.get(url, { timeout: 5000 });
    if (response.data.tag !== 'payRequest') {
      throw new Error('LN-URL response is not a payRequest');
    }

    const callbackUrl = response.data.callback;
    const amountMsats = response.data.minSendable;

    const callbackResponse = await httpClient.get(`${callbackUrl}?amount=${amountMsats}`, { timeout: 5000 });
    if (!callbackResponse.data.pr) {
      throw new Error('No BOLT11 invoice in callback response');
    }

    return callbackResponse.data.pr;
  } catch (error) {
    console.error('LN-URL processing error:', error.message);
    throw new Error(`Failed to process LN-URL: ${error.message}`);
  }
}

// Send instant payment using Speed wallet API - Sea Battle implementation
async function sendInstantPayment(withdrawRequest, amount, currency = 'USD', targetCurrency = 'SATS', note = '') {
  try {
    console.log('Sending instant payment via Speed Wallet instant-send API:', {
      withdrawRequest,
      amount,
      currency,
      targetCurrency,
      note
    });

    const instantSendPayload = {
      amount: parseFloat(amount),
      currency: currency,
      target_currency: targetCurrency,
      withdraw_method: 'lightning',
      withdraw_request: withdrawRequest,
      note: note
    };

    console.log('Instant send payload:', JSON.stringify(instantSendPayload, null, 2));

    const response = await httpClient.post(
      `${SPEED_API_BASE}/send`,
      instantSendPayload,
      {
        headers: {
          Authorization: `Basic ${AUTH_HEADER}`,
          'Content-Type': 'application/json',
          'speed-version': '2022-04-15',
        },
        timeout: 10000,
      }
    );

    console.log('Instant send response:', response.data);
    transactionLogger.info({
      event: 'payment_sent',
      recipient: withdrawRequest,
      amount: amount,
      currency: currency,
      targetCurrency: targetCurrency,
      note: note,
      response: response.data
    });
    return response.data;
  } catch (error) {
    const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
    const errorStatus = error.response?.status || 'No status';
    const errorDetails = error.response?.data || error.message;
    console.error('Instant Send Payment Error:', {
      message: errorMessage,
      status: errorStatus,
      details: errorDetails,
    });
    errorLogger.error({
      event: 'payment_send_failed',
      recipient: withdrawRequest,
      amount: amount,
      error: errorMessage,
      status: errorStatus
    });
    throw new Error(`Failed to send instant payment: ${errorMessage} (Status: ${errorStatus})`);
  }
}

// Fetch Speed wallet transactions (mock/demo friendly)
async function fetchSpeedWalletTransactions(lightningAddress) {
  try {
    // Placeholder for real API call if/when Speed exposes this
    // Returning empty list to avoid misleading data
    return [];
  } catch (e) {
    console.error('fetchSpeedWalletTransactions error:', e.message);
    return [];
  }
}

// Fetch user's Lightning address from Speed wallet
async function fetchLightningAddress(authToken) {
  try {
    if (!authToken) {
      throw new Error('No auth token provided');
    }

    console.log('Fetching Lightning address with token:', authToken.substring(0, 10) + '...');
    
    // Use Speed wallet user endpoint
    const response = await httpClient.get(
      `${SPEED_API_BASE}/user`,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'speed-version': '2022-04-15',
        },
        timeout: 5000,
      }
    );

    const lightningAddress = response.data.lightning_address || response.data.ln_address;
    console.log('Fetched Lightning address:', lightningAddress);
    return lightningAddress;
  } catch (error) {
    console.error('Error fetching Lightning address:', error.message);
    throw error;
  }
}

// Process payout for winner with platform fee - Sea Battle implementation
async function processPayout(winnerId, betAmount, gameId) {
  try {
    const winner = players[winnerId];
    if (!winner || !winner.lightningAddress) {
      throw new Error('Winner data not found');
    }

    const totalPot = betAmount * 2;
    const platformFee = Math.floor(totalPot * 0.05); // 5% platform fee
    const winnerPayout = totalPot - platformFee;

    console.log(`Processing payout for game ${gameId}:`);
    console.log(`  Winner: ${winner.lightningAddress}`);
    console.log(`  Total pot: ${totalPot} SATS`);
    console.log(`  Platform fee: ${platformFee} SATS`);
    console.log(`  Winner payout: ${winnerPayout} SATS`);

    // Send winner payout
    const winnerResult = await sendInstantPayment(
      winner.lightningAddress,
      winnerPayout,
      `Tic-Tac-Toe winnings from game ${gameId}`
    );

    if (winnerResult.success) {
      console.log(`✅ Winner payout sent: ${winnerPayout} SATS to ${winner.lightningAddress}`);
      
      // Log successful payout
      transactionLogger.info({
        event: 'winner_payout_sent',
        gameId: gameId,
        winnerId: winnerId,
        winnerAddress: winner.lightningAddress,
        winnerPayout: winnerPayout,
        platformFee: platformFee,
        totalPot: totalPot,
        timestamp: new Date().toISOString()
      });
      
      // Log player session with payout sent
      logPlayerSession(winner.lightningAddress, {
        event: 'payout_sent',
        playerId: winnerId,
        gameId: gameId,
        amount: winnerPayout
      });
      
      // Notify winner
      const sock = io.sockets.sockets.get ? io.sockets.sockets.get(winnerId) : io.sockets.sockets[winnerId];
      sock?.emit('payoutSent', {
        amount: winnerPayout,
        paymentId: winnerResult.paymentId
      });
    } else {
      throw new Error(winnerResult.error || 'Winner payout failed');
    }

    // Send platform fee to totodile@speed.app (matching Sea Battle)
    const platformResult = await sendInstantPayment(
      'totodile@speed.app', // Platform Lightning address from Sea Battle
      platformFee,
      `Platform fee from game ${gameId}`
    );

    if (platformResult.success) {
      console.log(`✅ Platform fee sent: ${platformFee} SATS to totodile@speed.app`);
      
      // Log successful platform fee
      transactionLogger.info({
        event: 'platform_fee_sent',
        gameId: gameId,
        recipient: 'totodile@speed.app',
        amount: platformFee,
        paymentId: platformResult.paymentId,
        timestamp: new Date().toISOString()
      });
    } else {
      throw new Error(platformResult.error || 'Platform fee failed');
    }
    
    console.log('Payout processed successfully with platform fee');
    gameLogger.info({
      event: 'game_payout_complete',
      gameId: gameId,
      winnerId: winnerId,
      winnerAddress: winner.lightningAddress,
      winnerPayout: winnerPayout,
      platformFee: platformFee,
      totalPot: totalPot,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Payout processing error:', error);
    errorLogger.error({
      event: 'payout_failed',
      gameId: gameId,
      winnerId: winnerId,
      error: error.message
    });
    io.to(winnerId).emit('payment_error', {
      error: error.message
    });
  }
}

// Game class with full logic
class Game {
  constructor(id, betAmount) {
    this.id = id;
    this.betAmount = betAmount;
    this.players = {};
    this.board = Array(9).fill(null);
    this.turn = null;
    this.status = 'waiting'; // waiting, playing, finished
    this.winner = null;
    this.winLine = [];
    this.turnTimer = null;
    this.isFirstTurn = true;
    this.moveCount = 0;
    this.startingPlayer = null; // Track who starts for draw handling
    this.turnDeadlineAt = null; // epoch ms when current turn ends
  }
  
  addPlayer(socketId, lightningAddress, isBot = false) {
    const symbol = Object.keys(this.players).length === 0 ? 'X' : 'O';
    this.players[socketId] = {
      socketId,
      lightningAddress,
      isBot,
      symbol,
      ready: false
    };
    
    if (Object.keys(this.players).length === 2) {
      this.status = 'ready';
      // Randomly decide who starts
      const playerIds = Object.keys(this.players);
      this.turn = playerIds[Math.random() < 0.5 ? 0 : 1];
      this.startingPlayer = this.turn;
    }
    
    return symbol;
  }
  
  currentPlayerSymbol() {
    return this.players[this.turn]?.symbol;
  }
  
  checkWinner() {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
      [0, 4, 8], [2, 4, 6] // diagonals
    ];
    
    for (const line of lines) {
      const [a, b, c] = line;
      if (this.board[a] && this.board[a] === this.board[b] && this.board[a] === this.board[c]) {
        return { winner: this.board[a], winLine: line };
      }
    }
    
    if (this.board.every(cell => cell !== null)) {
      return { winner: 'draw', winLine: [] };
    }
    
    return { winner: null, winLine: [] };
  }
  
  makeMove(socketId, position) {
    if (this.status !== 'playing') return { ok: false, reason: 'not_playing' };
    if (this.turn !== socketId) return { ok: false, reason: 'not_your_turn' };
    if (position < 0 || position > 8) return { ok: false, reason: 'bad_pos' };
    if (this.board[position] !== null) return { ok: false, reason: 'occupied' };
    
    this.board[position] = this.currentPlayerSymbol();
    this.isFirstTurn = false;
    this.moveCount++;
    const { winner, winLine } = this.checkWinner();
    
    if (winner) {
      this.status = 'finished';
      this.clearTurnTimer();
      
      if (winner === 'draw') {
        this.winner = 'draw';
        // Switch starting player for next game
        const playerIds = Object.keys(this.players);
        const otherPlayer = playerIds.find(id => id !== this.startingPlayer);
        this.startingPlayer = otherPlayer;
        return { ok: true, draw: true, nextStarter: otherPlayer };
      } else {
        const winnerId = Object.keys(this.players).find(
          id => this.players[id].symbol === winner
        );
        this.winner = winnerId;
        this.winLine = winLine;
        return { ok: true, winner: winnerId, winLine };
      }
    }
    
    // Switch turn
    const playerIds = Object.keys(this.players);
    this.turn = playerIds.find(id => id !== this.turn);
    
    // Start timer for next player
    this.startTurnTimer();
    
    return { ok: true };
  }
  
  startTurnTimer() {
    this.clearTurnTimer();
    const timeout = this.isFirstTurn ? 8000 : 5000;
    
    this.turnTimer = setTimeout(() => {
      this.handleTimeout();
    }, timeout);

    // Expose deadline and announce next turn
    this.turnDeadlineAt = Date.now() + timeout;
    io.to(this.id).emit('nextTurn', {
      turn: this.turn,
      turnDeadline: this.turnDeadlineAt
    });
  }
  
  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }
  
  handleTimeout() {
    if (this.status !== 'playing') return;
    
    const currentPlayer = this.players[this.turn];
    if (currentPlayer?.isBot) {
      // Bot should have moved, force a random move
      const availableMoves = this.board
        .map((cell, i) => cell === null ? i : -1)
        .filter(i => i !== -1);
      
      if (availableMoves.length > 0) {
        const move = availableMoves[Math.floor(Math.random() * availableMoves.length)];
        this.makeMove(this.turn, move);
      }
    } else {
      // Human timeout - opponent wins
      const playerIds = Object.keys(this.players);
      const otherPlayer = playerIds.find(id => id !== this.turn);
      handleGameEnd(this.id, otherPlayer);
    }
  }
}

// Game management
const games = {};
const waitingQueue = []; // Players waiting for match
const botSpawnTimers = {}; // Track bot spawn timers

// Speed wallet routes
app.get('/api/speed-wallet/lightning-address', async (req, res) => {
  const { authToken } = req.query;
  
  if (!authToken) {
    return res.status(400).json({ error: 'Auth token required' });
  }
  
  try {
    const lightningAddress = await fetchLightningAddress(authToken);
    res.json({ lightningAddress });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get payout info
app.get('/api/payouts', (req, res) => {
  res.json(PAYOUTS);
});

// Sea Battle compatible payout-info endpoint
app.get('/api/payout-info', (req, res) => {
  res.json({
    api: {
      name: 'Speed Wallet API',
      endpoint: SPEED_API_BASE,
      method: 'Lightning Network instant payments',
      description: "Winners are paid instantly via Lightning Network using Speed Wallet's send API"
    },
    payouts: PAYOUTS,
    fees: 'Platform fees are automatically deducted from the total pot',
    currency: 'SATS (Bitcoin Satoshis)',
    paymentMethod: 'Lightning Address (@speed.app)'
  });
});

// Proxy endpoint to fetch Speed wallet transactions (mock/demo compatible)
app.get('/api/speed-transactions/:lightning_address', async (req, res) => {
  try {
    const { lightning_address } = req.params;
    if (!lightning_address) return res.status(400).json({ error: 'Lightning address is required' });

    const transactions = await fetchSpeedWalletTransactions(lightning_address);
    res.json({ lightning_address, transactions, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Speed transactions error:', e.message);
    res.status(500).json({ error: 'Failed to fetch Speed wallet transactions' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Resolve LN input (Lightning address, LNURL, or BOLT11) to a BOLT11 invoice
app.post('/api/resolve-ln', async (req, res) => {
  try {
    const { input, amountSats } = req.body || {};
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input required' });
    }

    let invoice = null;
    const lower = input.toLowerCase();

    if (lower.startsWith('lnurl')) {
      invoice = await decodeAndFetchLnUrl(input);
    } else if (input.includes('@')) {
      if (!amountSats || Number(amountSats) <= 0) {
        return res.status(400).json({ error: 'amountSats required for Lightning address' });
      }
      invoice = await resolveLightningAddress(input, Number(amountSats));
    } else if (lower.startsWith('ln')) {
      invoice = input;
    } else {
      return res.status(400).json({ error: 'Unknown input format' });
    }

    res.json({ invoice });
  } catch (e) {
    console.error('resolve-ln error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Send payment to a BOLT11 invoice or Lightning address (@speed.app)
app.post('/api/send-payment', async (req, res) => {
  try {
    const { destination, amountSats, note } = req.body || {};
    if (!destination) return res.status(400).json({ error: 'destination required' });

    const result = await sendPayment(destination, amountSats, note);
    res.json(result);
  } catch (e) {
    console.error('send-payment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// API endpoint to get Lightning address from Speed
app.post('/api/get-lightning-address', async (req, res) => {
  try {
    const { authToken } = req.body;
    
    if (!authToken) {
      return res.status(400).json({ error: 'Auth token required' });
    }

    // Decode the auth token to get user info
    const userInfo = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64').toString());
    const acctId = userInfo.acct_id;
    
    // Check if we already have this user's Lightning address
    const cached = getLightningAddressByAcctId(acctId);
    if (cached) {
      return res.json({ lightningAddress: cached, acctId });
    }
    
    // Fetch from Speed API
    const response = await httpClient.get(`${SPEED_API_BASE}/user/lightning-address`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    const lightningAddress = response.data.lightningAddress || response.data.address;
    if (lightningAddress) {
      mapUserAcctId(acctId, lightningAddress);
    }
    
    res.json({ lightningAddress, acctId });
  } catch (error) {
    console.error('Error fetching Lightning address:', error.message);
    res.status(500).json({ error: 'Failed to fetch Lightning address' });
  }
});

// API endpoint to generate LNURL
app.post('/api/generate-lnurl', async (req, res) => {
  try {
    const { amountSats, description } = req.body;
    
    const response = await httpClient.post(`${SPEED_API_BASE}/lnurl/generate`, {
      amount: amountSats,
      description: description || `Tic-Tac-Toe Game - ${amountSats} SATS`,
      currency: 'SATS'
    }, {
      headers: {
        'Authorization': `Basic ${AUTH_HEADER}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    res.json({
      lnurl: response.data.lnurl,
      qr: response.data.qr
    });
  } catch (error) {
    console.error('Error generating LNURL:', error.message);
    res.status(500).json({ error: 'Failed to generate LNURL' });
  }
});

// API endpoint to generate Lightning QR code
app.post('/api/generate-qr', async (req, res) => {
  try {
    const { invoice } = req.body;
    
    if (!invoice) {
      return res.status(400).json({ error: 'Invoice required' });
    }
    
    // Generate QR code as data URL
    const qrCode = await QRCode.toDataURL(invoice, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256
    });
    
    res.json({ qr: qrCode });
  } catch (error) {
    console.error('Error generating QR code:', error.message);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Manual payment verification endpoint for testing
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) {
      return res.status(400).json({ error: 'Invoice ID required' });
    }
    
    console.log('Manual payment verification requested for invoice:', invoiceId);
    
    // Check invoice status with Speed Wallet API
    const response = await axios.get(
      `${SPEED_API_BASE}/merchant/invoices/${invoiceId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SPEED_WALLET_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const invoice = response.data;
    console.log('Invoice status:', invoice.status, 'Invoice data:', invoice);
    
    if (invoice.status === 'paid' || invoice.status === 'completed') {
      // Manually trigger payment verification
      handleInvoicePaid(invoiceId, { 
        event_type: 'manual_verification',
        data: { object: invoice }
      });
      return res.json({ success: true, status: invoice.status });
    } else {
      return res.json({ success: false, status: invoice.status });
    }
  } catch (error) {
    console.error('Manual payment verification error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Speed Wallet Webhook - Complete Sea Battle implementation
app.post('/webhook', (req, res) => {
  logger.debug('Webhook received', { headers: req.headers });
  // Verify webhook signature per Speed docs
  try {
    const webhookId = req.headers['webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'];
    const signatureHeader = req.headers['webhook-signature'];
    if (!webhookId || !webhookTimestamp || !signatureHeader || !req.rawBody) {
      logger.warn('Missing signature headers or raw body', {
        hasId: !!webhookId, hasTs: !!webhookTimestamp, hasSig: !!signatureHeader, hasRaw: !!req.rawBody
      });
      return res.status(400).send('Missing signature headers');
    }

    const secretRaw = process.env.SPEED_WALLET_WEBHOOK_SECRET;
    if (!secretRaw) {
      logger.error('SPEED_WALLET_WEBHOOK_SECRET not configured');
      return res.status(500).send('Server not configured');
    }
    const base64Part = secretRaw.startsWith('wsec_') ? secretRaw.slice(5) : secretRaw;
    let secretBytes;
    try {
      secretBytes = Buffer.from(base64Part, 'base64');
    } catch (e) {
      logger.error('Invalid webhook secret format');
      return res.status(500).send('Server not configured');
    }

    const signedPayload = `${webhookId}.${webhookTimestamp}.${req.rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', secretBytes)
      .update(signedPayload, 'utf8')
      .digest('base64');

    // Signature header may contain multiple values and a version prefix (e.g., "v1,BASE64")
    const candidates = String(signatureHeader)
      .trim()
      .split(/\s+/)
      .map(s => {
        if (s.includes(',')) return s.split(',')[1] || '';
        if (s.includes('=')) return s.split('=')[1] || '';
        return s;
      })
      .filter(Boolean);

    const match = candidates.some(sig => {
      const a = Buffer.from(expectedSig);
      const b = Buffer.from(sig);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });

    if (!match) {
      logger.warn('Invalid webhook signature', { webhookId, webhookTimestamp });
      return res.status(400).send('Invalid signature');
    }

    // Idempotency: ignore duplicate webhook-id
    if (processedWebhooks.has(webhookId)) {
      logger.info('Duplicate webhook ignored', { webhookId });
      return res.status(200).send('Duplicate');
    }
    processedWebhooks.add(webhookId);
  } catch (e) {
    logger.error('Webhook verification error', { error: e.message });
    return res.status(400).send('Invalid signature');
  }

  const event = req.body;
  logger.info('Processing webhook event', { event: event.event_type, data: event.data });

  try {
    const eventType = event.event_type;
    logger.debug('Processing event type', { eventType });

    switch (eventType) {
      case 'invoice.paid':
      case 'payment.paid':
      case 'payment.confirmed':
        const invoiceId = event.data?.object?.id || event.data?.id;
        if (!invoiceId) {
          logger.error('Webhook error: No invoiceId in webhook payload');
          return res.status(400).send('No invoiceId in webhook payload');
        }

        const socketId = invoiceToSocket[invoiceId];
        if (!socketId) {
          logger.warn(`Webhook warning: No socketId found for invoice ${invoiceId}. Player may have disconnected before mapping was stored.`);
          return res.status(200).send('Webhook received but no socketId found');
        }
        const sock = (io.sockets && io.sockets.sockets && (io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId])) || null;

        // Log payment verification
        const paymentData = {
          event: 'payment_verified',
          playerId: socketId,
          invoiceId: invoiceId,
          amount: players[socketId]?.betAmount || 'unknown',
          lightningAddress: players[socketId]?.lightningAddress || 'unknown',
          timestamp: new Date().toISOString(),
          eventType: eventType
        };
        
        transactionLogger.info(paymentData);

        if (sock) {
          sock.emit('paymentVerified');
        }
        if (!players[socketId]) {
          logger.warn(`Players record missing for ${socketId} on webhook for invoice ${invoiceId}`);
          return res.status(200).send('Webhook processed but player not found');
        }
        players[socketId].paid = true;
        logger.info('Payment verified for player', { playerId: socketId, invoiceId });

        // Log player session with payment received status
        console.log('💳 PAYMENT VERIFIED for:', players[socketId].lightningAddress);
        console.log('💰 Amount:', players[socketId].betAmount, 'SATS');
        if (players[socketId].lightningAddress) {
          logPlayerSession(players[socketId].lightningAddress, {
            event: 'payment_received',
            playerId: socketId,
            betAmount: players[socketId].betAmount,
            invoiceId: invoiceId
          });
        }

        // Find or create game immediately after payment
        let game = Object.values(games).find(g => 
          Object.keys(g.players).length === 1 && g.betAmount === players[socketId].betAmount
        );
        
        if (!game) {
          // Create new game if no waiting game found
          const gameId = `game_${Date.now()}`;
          game = new Game(gameId, players[socketId].betAmount);
          games[gameId] = game;
          
          // Log game creation
          gameLogger.info({
            event: 'game_created',
            gameId: gameId,
            betAmount: players[socketId].betAmount,
            playerId: socketId,
            timestamp: new Date().toISOString()
          });
        }
        
        // Add player to game
        game.addPlayer(socketId, players[socketId].lightningAddress);
        if (sock) {
          sock.join(game.id);
        }
        
        // Check if game is ready to start (2 players)
        if (Object.keys(game.players).length === 2) {
          // Both players are ready, start the game
          const playerIds = Object.keys(game.players);
          const startsIn = 5;
          const startAt = Date.now() + startsIn * 1000;
          
          // Notify both players
          playerIds.forEach(pid => {
            const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
            playerSock?.emit('matchFound', { opponent: { type: 'player' }, startsIn, startAt });
          });
          
          // Start game after countdown
          setTimeout(() => {
            game.status = 'playing';
            game.startTurnTimer();
            const turnDeadline = game.turnDeadlineAt || null;
            
            playerIds.forEach(pid => {
              const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
              playerSock?.emit('startGame', {
                gameId: game.id,
                symbol: game.players[pid].symbol,
                turn: game.turn,
                message: game.turn === pid ? 'Your move' : "Opponent's move",
                turnDeadline
              });
            });
            
            gameLogger.info({
              event: 'game_started',
              gameId: game.id,
              players: playerIds,
              betAmount: game.betAmount,
              timestamp: new Date().toISOString()
            });
          }, startsIn * 1000);
        } else {
          // Waiting for another player - schedule bot spawn
          if (sock) {
            const delay = getRandomBotSpawnDelay();
            const estWaitSeconds = Math.floor(delay / 1000);
            
            sock.emit('waitingForOpponent', {
              message: 'Finding opponent...',
              estimatedWait: `${13}-${25} seconds`,
              playersInGame: Object.keys(game.players).length
            });
            
            // Schedule bot to join if no real player joins
            botSpawnTimers[socketId] = setTimeout(() => {
              // Check if still waiting
              const currentGame = Object.values(games).find(g => 
                g.players[socketId] && Object.keys(g.players).length === 1
              );
              
              if (currentGame) {
                // Add bot to game
                const botId = `bot_${uuidv4()}`;
                const botAddress = generateBotLightningAddress();
                const bot = new BotPlayer(currentGame.id, currentGame.betAmount, players[socketId].lightningAddress);
                activeBots.set(currentGame.id, bot);
                
                currentGame.addPlayer(botId, botAddress, true);
                players[botId] = {
                  lightningAddress: botAddress,
                  betAmount: currentGame.betAmount,
                  paid: true,
                  isBot: true,
                  gameId: currentGame.id
                };
                
                // Notify players that match is found
                const playerIds = Object.keys(currentGame.players);
                const startsIn = 5;
                const startAt = Date.now() + startsIn * 1000;
                
                playerIds.forEach(pid => {
                  if (!currentGame.players[pid].isBot) {
                    const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
                    playerSock?.emit('matchFound', { 
                      opponent: { type: 'player' }, // Don't reveal it's a bot
                      startsIn, 
                      startAt 
                    });
                  }
                });
                
                // Start game after countdown
                setTimeout(() => {
                  currentGame.status = 'playing';
                  currentGame.startTurnTimer();
                  const turnDeadline = currentGame.turnDeadlineAt || null;
                  
                  playerIds.forEach(pid => {
                    if (!currentGame.players[pid].isBot) {
                      const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
                      playerSock?.emit('startGame', {
                        gameId: currentGame.id,
                        symbol: currentGame.players[pid].symbol,
                        turn: currentGame.turn,
                        message: currentGame.turn === pid ? 'Your move' : "Opponent's move",
                        turnDeadline
                      });
                    }
                  });
                  
                  // If bot starts, make first move
                  if (currentGame.players[currentGame.turn]?.isBot) {
                    makeBotMove(currentGame.id, currentGame.turn);
                  }
                  
                  gameLogger.info({
                    event: 'game_started_with_bot',
                    gameId: currentGame.id,
                    humanPlayer: socketId,
                    botPlayer: botId,
                    betAmount: currentGame.betAmount,
                    timestamp: new Date().toISOString()
                  });
                }, startsIn * 1000);
                
                delete botSpawnTimers[socketId];
              }
            }, delay);
          }
        }
        
        delete invoiceToSocket[invoiceId];
        delete invoiceMeta[invoiceId];
        break;

      case 'payment.failed':
        const failedInvoiceId = event.data?.object?.id || event.data?.id;
        if (!failedInvoiceId) {
          logger.error('Webhook error: No invoiceId in webhook payload for payment.failed');
          return res.status(400).send('No invoiceId in webhook payload');
        }

        const failedSocketId = invoiceToSocket[failedInvoiceId];
        const failedSock = (io.sockets && io.sockets.sockets && (io.sockets.sockets.get ? io.sockets.sockets.get(failedSocketId) : io.sockets.sockets[failedSocketId])) || null;
        if (failedSocketId) {
          // Log payment failure
          transactionLogger.info({
            event: 'payment_failed',
            playerId: failedSocketId,
            invoiceId: failedInvoiceId,
            amount: players[failedSocketId]?.betAmount || 'unknown',
            lightningAddress: players[failedSocketId]?.lightningAddress || 'unknown',
            timestamp: new Date().toISOString(),
            eventType: eventType
          });
          
          if (failedSock) {
            failedSock.emit('error', { message: 'Payment failed. Please try again.' });
          }
          logger.warn('Payment failed for player', { playerId: failedSocketId, invoiceId: failedInvoiceId });
          delete players[failedSocketId];
          delete invoiceToSocket[failedInvoiceId];
          delete invoiceMeta[failedInvoiceId];
        } else {
          logger.warn(`Webhook warning: No socket mapping found for failed invoice ${failedInvoiceId}. Player may have disconnected.`);
        }
        break;

      default:
        console.log(`Unhandled event type: ${eventType}`);
    }

    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Webhook processing failed');
  }
});

function handleInvoicePaid(invoiceId, event) {
  console.log('handleInvoicePaid called for invoice:', invoiceId);
  console.log('Current invoice mappings:', {
    invoiceToSocket,
    invoiceMeta
  });
  
  const socketId = invoiceToSocket[invoiceId];
  if (!socketId) {
    console.error('No socket found for invoice:', invoiceId);
    return;
  }
  
  const meta = invoiceMeta[invoiceId] || {};
  console.log('Payment meta data:', meta);

  players[socketId] = players[socketId] || {};
  players[socketId].paid = true;
  if (meta.betAmount) players[socketId].betAmount = meta.betAmount;
  if (meta.lightningAddress) players[socketId].lightningAddress = meta.lightningAddress;

  console.log('Updated player data:', players[socketId]);

  const sock = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
  if (sock) {
    sock.emit('paymentVerified');
    console.log('Emitted paymentVerified to socket:', socketId);
  } else {
    console.error('Socket not found for emission:', socketId);
  }
  
  // Log payment verification
  transactionLogger.info({
    event: 'payment_verified',
    invoiceId: invoiceId,
    socketId: socketId,
    betAmount: meta.betAmount,
    lightningAddress: meta.lightningAddress,
    webhookEvent: event
  });
  
  if (meta.lightningAddress) {
    logPlayerSession(meta.lightningAddress, {
      event: 'payment_received',
      playerId: socketId,
      betAmount: meta.betAmount,
      invoiceId: invoiceId
    });
  }

  delete invoiceToSocket[invoiceId];
  delete invoiceMeta[invoiceId];

  attemptMatchOrEnqueue(socketId);
}

// This function is no longer needed as game matching is handled directly in webhook
// Keeping for backward compatibility but redirecting to webhook logic
function attemptMatchOrEnqueue(socketId) {
  console.log('attemptMatchOrEnqueue called for socket:', socketId);
  const player = players[socketId];
  console.log('Player data:', player);
  
  if (!player || !player.betAmount || !player.paid) {
    console.log('Player not ready for matching:', {
      exists: !!player,
      betAmount: player?.betAmount,
      paid: player?.paid
    });
    return;
  }

  // Check if player is already in a game
  const existingGame = Object.values(games).find(g => g.players[socketId]);
  if (existingGame) {
    console.log('Player already in game:', existingGame.id);
    return;
  }

  // Try to find a waiting game with same bet amount
  let game = Object.values(games).find(g => 
    Object.keys(g.players).length === 1 && g.betAmount === player.betAmount
  );
  
  if (!game) {
    // Create new game
    const gameId = `game_${Date.now()}`;
    game = new Game(gameId, player.betAmount);
    games[gameId] = game;
    gameLogger.info({
      event: 'game_created',
      gameId: gameId,
      betAmount: player.betAmount,
      playerId: socketId,
      timestamp: new Date().toISOString()
    });
  }
  
  // Add player to game
  game.addPlayer(socketId, player.lightningAddress);
  const sock = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
  if (sock) {
    sock.join(game.id);
  }
  
  // Check if game is ready (2 players)
  if (Object.keys(game.players).length === 2) {
    const playerIds = Object.keys(game.players);
    const startsIn = 5;
    const startAt = Date.now() + startsIn * 1000;
    
    playerIds.forEach(pid => {
      const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
      playerSock?.emit('matchFound', { opponent: { type: 'player' }, startsIn, startAt });
    });
    
    setTimeout(() => {
      game.status = 'playing';
      game.startTurnTimer();
      const turnDeadline = game.turnDeadlineAt || null;
      
      playerIds.forEach(pid => {
        const playerSock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
        playerSock?.emit('startGame', {
          gameId: game.id,
          symbol: game.players[pid].symbol,
          turn: game.turn,
          message: game.turn === pid ? 'Your move' : "Opponent's move",
          turnDeadline
        });
      });
    }, startsIn * 1000);
  } else {
    // Waiting for another player or schedule bot spawn
    const sock = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
    // Avoid duplicates
    if (!waitingQueue.find(p => p.socketId === socketId)) {
      waitingQueue.push({ socketId, lightningAddress: player.lightningAddress, betAmount: player.betAmount });
    }
    const delay = BOT_SPAWN_DELAY.min + Math.random() * (BOT_SPAWN_DELAY.max - BOT_SPAWN_DELAY.min);
    const spawnAt = Date.now() + delay;
    const estWaitSeconds = Math.floor(delay / 1000);
    sock?.emit('waitingForOpponent', {
      minWait: Math.floor(BOT_SPAWN_DELAY.min / 1000),
      maxWait: Math.floor(BOT_SPAWN_DELAY.max / 1000),
      estWaitSeconds,
      spawnAt
    });

    botSpawnTimers[socketId] = setTimeout(() => {
      const stillWaiting = waitingQueue.findIndex(p => p.socketId === socketId);
      if (stillWaiting === -1) return;
      waitingQueue.splice(stillWaiting, 1);

      const botId = `bot_${uuidv4()}`;
      const botAddress = 'developer@tryspeed.com';

      const gameId = uuidv4();
      const game = new Game(gameId, player.betAmount);
      game.addPlayer(socketId, player.lightningAddress);
      game.addPlayer(botId, botAddress, true);
      games[gameId] = game;

      const s = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
      s?.join(gameId);

      const startsIn = 5;
      const startAt = Date.now() + startsIn * 1000;
      s?.emit('matchFound', { opponent: { type: 'bot' }, startsIn, startAt });

      setTimeout(() => {
        game.status = 'playing';
        game.startTurnTimer();
        const turnDeadline = game.turnDeadlineAt || null;
        s?.emit('startGame', {
          gameId,
          symbol: game.players[socketId].symbol,
          turn: game.turn,
          message: game.turn === socketId ? 'Your move' : "Opponent's move",
          turnDeadline
        });

        if (game.turn === botId) {
          setTimeout(() => {
            const move = getBotMove(game, botId);
            if (move !== null) {
              const result = game.makeMove(botId, move);
              io.to(gameId).emit('boardUpdate', { board: game.board, lastMove: move });
              if (result.winner) {
                handleGameEnd(gameId, result.winner);
              } else if (result.draw) {
                handleDraw(gameId);
              }
            }
          }, BOT_THINK_TIME.min + Math.random() * (BOT_THINK_TIME.max - BOT_THINK_TIME.min));
        }
      }, startsIn * 1000);

      delete botSpawnTimers[socketId];
    }, delay);
  }
}

// Make bot move with human-like delay
function makeBotMove(gameId, botId) {
  const game = games[gameId];
  if (!game || game.status !== 'playing') return;
  
  const bot = activeBots.get(gameId);
  if (!bot) return;
  
  // Get move from bot logic
  const move = bot.getMove(game.board);
  if (move === null || move === undefined) return;
  
  // Apply human-like delay
  const delay = bot.getThinkingTime();
  
  setTimeout(() => {
    // Double-check game still exists and it's bot's turn
    if (!games[gameId] || games[gameId].status !== 'playing' || games[gameId].turn !== botId) {
      return;
    }
    
    // Make the move
    const result = game.makeMove(move, botId);
    
    if (result.success) {
      // Emit move to all players
      Object.keys(game.players).forEach(pid => {
        if (!game.players[pid].isBot) {
          const sock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
          sock?.emit('moveMade', {
            position: move,
            symbol: game.players[botId].symbol,
            nextTurn: result.nextTurn,
            board: game.board,
            turnDeadline: game.turnDeadlineAt
          });
        }
      });
      
      // Check for game end
      if (result.winner || result.draw) {
        handleGameEnd(gameId, result.winner);
      } else if (game.players[game.turn]?.isBot) {
        // If it's still bot's turn (shouldn't happen in tic-tac-toe), make another move
        makeBotMove(gameId, game.turn);
      }
    }
  }, delay);
}

// Handle game end with bot cleanup
function handleGameEnd(gameId, winnerId) {
  const game = games[gameId];
  if (!game) return;
  
  game.status = 'finished';
  game.clearTurnTimer();
  
  // Clean up bot
  const bot = activeBots.get(gameId);
  if (bot) {
    // Update player history if human player
    const humanId = Object.keys(game.players).find(id => !game.players[id].isBot);
    if (humanId) {
      const humanPlayer = game.players[humanId];
      const playerWon = winnerId === humanId;
      bot.recordGameResult(playerWon);
    }
    activeBots.delete(gameId);
  }
  
  // Handle payouts for real games (not bot games)
  const botInGame = Object.values(game.players).some(p => p.isBot);
  if (!botInGame && winnerId && game.betAmount > 0) {
    const winner = game.players[winnerId];
    if (winner && winner.lightningAddress) {
      processPayout(winner.lightningAddress, game.betAmount, gameId);
    }
  }
  
  // Clean up players
  Object.keys(game.players).forEach(pid => {
    delete players[pid];
  });
  
  // Remove game after a delay
  setTimeout(() => {
    delete games[gameId];
  }, 5000);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Set auth token for fetching LN address
  socket.on('set_auth_token', async (data) => {
    const { authToken } = data;
    if (!authToken) return;
    
    try {
      const lightningAddress = await fetchLightningAddress(authToken);
      players[socket.id] = { 
        ...players[socket.id], 
        lightningAddress,
        authToken
      };
      
      socket.emit('lightning_address', { lightningAddress });
      console.log(`Player ${socket.id} authenticated with LN address: ${lightningAddress}`);
    } catch (error) {
      console.error('Auth token error:', error);
      socket.emit('auth_error', { error: error.message });
    }
  });
  
  // Sea Battle implementation - payment verified only via webhooks
  
  socket.on('joinGame', async (data) => {
    try {
      const { betAmount, lightningAddress, acctId } = data || {};
      if (!ALLOWED_BETS.includes(betAmount)) return socket.emit('error', { message: 'Invalid bet amount' });

      // Resolve and format Lightning address (allow persistence via acctId)
      let resolvedAddress = lightningAddress && lightningAddress.trim() !== '' ? lightningAddress : null;
      if (!resolvedAddress && acctId) {
        const stored = getLightningAddressByAcctId(acctId);
        if (stored) {
          resolvedAddress = stored;
        }
      }
      if (!resolvedAddress) {
        throw new Error('Lightning address is required');
      }
      
      // Only add @speed.app if not already present
      let formattedAddress = resolvedAddress;
      if (!formattedAddress.includes('@')) {
        formattedAddress = `${formattedAddress}@speed.app`;
      }
      console.log(`Player ${socket.id} joining game: ${betAmount} SATS with Lightning address ${formattedAddress}`);
      
      // Map acctId to Lightning address if provided
      if (acctId) {
        mapUserAcctId(acctId, formattedAddress);
        playerAcctIds[socket.id] = acctId;
        console.log(`Mapped player ${socket.id} to acct_id: ${acctId}`);
      }

      players[socket.id] = { lightningAddress: formattedAddress, paid: false, betAmount };

      // Create invoice and map to socket
      const invoiceData = await createLightningInvoice(
        betAmount,
        null, // Customer ID not needed for new merchant account
        `order_${socket.id}_${Date.now()}`
      );
      
      console.log('Created invoice:', {
        invoiceId: invoiceData.invoiceId,
        socketId: socket.id,
        betAmount: betAmount
      });
      
      const lightningInvoice = invoiceData.lightningInvoice;
      const hostedInvoiceUrl = invoiceData.hostedInvoiceUrl;

      console.log('Payment Request created:', { 
        invoiceId: invoiceData.invoiceId,
        lightningInvoice: lightningInvoice?.substring(0, 50) + '...', 
        hostedInvoiceUrl,
        speedInterfaceUrl: invoiceData.speedInterfaceUrl 
      });
      
      socket.emit('paymentRequest', {
        lightningInvoice: lightningInvoice,
        hostedInvoiceUrl: hostedInvoiceUrl,
        speedInterfaceUrl: invoiceData.speedInterfaceUrl,
        invoiceId: invoiceData.invoiceId,
        amountSats: betAmount,
        amountUSD: invoiceData.amountUSD
      });
      
      invoiceToSocket[invoiceData.invoiceId] = socket.id;
      invoiceMeta[invoiceData.invoiceId] = {
        socketId: socket.id,
        betAmount,
        lightningAddress: formattedAddress,
        createdAt: Date.now()
      };
      
      console.log('Mapped invoice to socket:', {
        invoiceId: invoiceData.invoiceId,
        socketId: socket.id,
        mappings: { invoiceToSocket, invoiceMeta }
      });
      
      // Log player session start
      logPlayerSession(formattedAddress, {
        event: 'session_started',
        playerId: socket.id,
        betAmount: betAmount,
        invoiceId: invoiceData.invoiceId
      });
      
      // Set payment verification timeout (5 minutes)
      setTimeout(() => {
        const player = players[socket.id];
        if (player && !player.paid) {
          console.log(`Payment timeout for player ${socket.id}`);
          socket.emit('paymentTimeout', {
            message: 'Payment verification timed out. Please try again.'
          });
          
          // Clean up
          delete invoiceToSocket[invoiceData.invoiceId];
          delete invoiceMeta[invoiceData.invoiceId];
          delete players[socket.id];
          
          logPlayerSession(formattedAddress, {
            event: 'payment_timeout',
            playerId: socket.id,
            betAmount: betAmount,
            invoiceId: invoiceData.invoiceId
          });
        }
      }, 5 * 60 * 1000); // 5 minutes
      
      console.log(`Mapped invoice ${invoiceData.invoiceId} to socket ${socket.id}`);
    } catch (err) {
      console.error('joinGame error:', err.message);
      errorLogger.error({
        event: 'join_game_failed',
        socketId: socket.id,
        error: err.message
      });
      socket.emit('error', { message: err.message || 'Could not create payment request' });
    }
  });
  
  // Also keep old event name for compatibility
  socket.on('join_game', async (data) => {
    socket.emit('joinGame', data);
  });
  
  // Handle moves
  socket.on('makeMove', (data) => {
    const { gameId, position } = data || {};
    const game = games[gameId];
    if (!game || game.turn !== socket.id) return socket.emit('error', { message: 'Invalid move' });

    const result = game.makeMove(position, socket.id);
    if (!result.success) return socket.emit('error', { message: result.message || 'Invalid move' });

    // Emit move to all players
    Object.keys(game.players).forEach(pid => {
      if (!game.players[pid].isBot) {
        const sock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
        sock?.emit('moveMade', {
          position: position,
          symbol: game.players[socket.id].symbol,
          nextTurn: result.nextTurn,
          board: game.board,
          turnDeadline: game.turnDeadlineAt
        });
      }
    });

    if (result.winner) {
      handleGameEnd(gameId, result.winner);
    } else if (result.draw) {
      handleDraw(gameId);
    } else {
      // Check if it's bot's turn
      const botId = Object.keys(game.players).find(id => game.players[id].isBot);
      if (botId && game.turn === botId) {
        makeBotMove(gameId, botId);
      }
    }
  });

  // Resign
  socket.on('resign', ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.status !== 'playing') return;
    const winnerId = Object.keys(game.players).find(id => id !== socket.id);
    handleGameEnd(gameId, winnerId);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    
    // Remove from waiting queue
    const waitingIndex = waitingQueue.findIndex(p => p.socketId === socket.id);
    if (waitingIndex !== -1) {
      waitingQueue.splice(waitingIndex, 1);
    }
    
    // Clear bot spawn timer
    if (botSpawnTimers[socket.id]) {
      clearTimeout(botSpawnTimers[socket.id]);
      delete botSpawnTimers[socket.id];
    }
    
    // Handle game disconnect
    const game = Object.values(games).find(g => g.players[socket.id]);
    if (game && game.status === 'playing') {
      // Other player wins by default
      const winnerId = Object.keys(game.players).find(id => id !== socket.id);
      handleGameEnd(game.id, winnerId);
    }
    
    delete players[socket.id];
  });
});

// Handle game end with comprehensive logging
function handleGameEnd(gameId, winnerId) {
  const game = games[gameId];
  if (!game) return;

  game.status = 'finished';
  game.clearTurnTimer();

  const winnerSymbol = game.players[winnerId]?.symbol || null;
  const winningLine = Array.isArray(game.winLine) ? game.winLine : [];
  const winner = game.players[winnerId];
  const loser = Object.values(game.players).find(p => p.socketId !== winnerId);
  
  // Log game result
  gameLogger.info({
    event: 'game_ended',
    gameId: gameId,
    winnerId: winnerId,
    winnerAddress: winner?.lightningAddress,
    winnerIsBot: winner?.isBot || false,
    loserId: loser?.socketId,
    loserAddress: loser?.lightningAddress,
    loserIsBot: loser?.isBot || false,
    betAmount: game.betAmount,
    winnerSymbol: winnerSymbol,
    winningLine: winningLine
  });
  
  // Log player sessions
  if (winner?.lightningAddress) {
    logPlayerSession(winner.lightningAddress, {
      event: 'game_won',
      playerId: winnerId,
      gameId: gameId,
      betAmount: game.betAmount,
      opponentType: loser?.isBot ? 'bot' : 'human'
    });
  }
  if (loser?.lightningAddress && !loser.isBot) {
    logPlayerSession(loser.lightningAddress, {
      event: 'game_lost',
      playerId: loser.socketId,
      gameId: gameId,
      betAmount: game.betAmount,
      opponentType: winner?.isBot ? 'bot' : 'human'
    });
  }
  
  // Track game history for human player
  const humanPlayer = winner?.isBot ? loser : winner;
  if (humanPlayer && !humanPlayer.isBot) {
    const playerWon = !winner?.isBot;
    updatePlayerHistory(humanPlayer.lightningAddress, game.betAmount, playerWon);
    console.log(`Updated history for ${humanPlayer.lightningAddress}: ${playerWon ? 'Won' : 'Lost'} with ${game.betAmount} sats`);
  }
  
  // Emit personalized result to each participant
  const playerIds = Object.keys(game.players);
  for (const pid of playerIds) {
    const msg = pid === winnerId ? 'You win!' : 'You lose';
    const sock = io.sockets.sockets.get ? io.sockets.sockets.get(pid) : io.sockets.sockets[pid];
    sock?.emit('gameEnd', {
      message: msg,
      winnerSymbol,
      winningLine
    });
  }

  // Process payout for human winners
  if (!game.players[winnerId]?.isBot) {
    processPayout(winnerId, game.betAmount, gameId);
  } else {
    // Bot won - send platform fee only
    const platformFee = Math.floor(game.betAmount * 2 * 0.05);
    sendInstantPayment(
      'totodile@speed.app',
      platformFee,
      `Platform fee from game ${gameId} (bot victory)`
    ).then(result => {
      if (result.success) {
        transactionLogger.info({
          event: 'platform_fee_sent',
          gameId: gameId,
          amount: platformFee,
          recipient: 'totodile@speed.app',
          botVictory: true
        });
      }
    }).catch(err => {
      errorLogger.error({
        event: 'platform_fee_failed',
        gameId: gameId,
        error: err.message,
        botVictory: true
      });
    });
  }

  setTimeout(() => { delete games[gameId]; }, 30000);
}

function handleDraw(gameId) {
  const game = games[gameId];
  if (!game) return;
  game.status = 'finished';
  game.clearTurnTimer();
  
  // Track draw for human players (counted as loss in patterns)
  const humanPlayer = Object.values(game.players).find(p => !p.isBot);
  if (humanPlayer) {
    updatePlayerHistory(humanPlayer.lightningAddress, game.betAmount, false);
    console.log(`Updated history for ${humanPlayer.lightningAddress}: Draw (counted as loss) with ${game.betAmount} sats`);
  }
  
  io.to(gameId).emit('gameEnd', { result: 'draw' });
  delete games[gameId];
}

// Start server (Render/Railway will set PORT)
const PORT = process.env.PORT || process.env.BACKEND_PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Speed Wallet API: ${SPEED_API_BASE}`);
  console.log(`Allowed origin: ${process.env.ALLOWED_ORIGIN}`);
});
