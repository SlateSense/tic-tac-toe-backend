require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Queue = require('express-queue');
const winston = require('winston');
const { bech32 } = require('bech32');
require('winston-daily-rotate-file');

// Configure Winston logging
const logger = winston.createLogger({
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
    }),
    new winston.transports.DailyRotateFile({
      filename: 'logs/games-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
      archiveCompressed: true
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const app = express();
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

// Constants
const SPEED_WALLET_SECRET_KEY = process.env.SPEED_WALLET_SECRET_KEY || '';
const SPEED_WALLET_WEBHOOK_SECRET = process.env.SPEED_WALLET_WEBHOOK_SECRET || '';

if (!SPEED_WALLET_SECRET_KEY || !SPEED_WALLET_WEBHOOK_SECRET) {
  console.error('Missing Speed Wallet secrets. Set SPEED_WALLET_SECRET_KEY and SPEED_WALLET_WEBHOOK_SECRET.');
  process.exit(1);
}

// Webhook protections
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const webhookQueue = Queue({ activeLimit: 1, queuedLimit: -1 });

const SPEED_WALLET_API_BASE = 'https://api.speed.app/v1';
const SPEED_API_BASE = 'https://api.speed.app/2022-04-15';
const AUTH_HEADER = Buffer.from(`:${SPEED_WALLET_SECRET_KEY}`).toString('base64');

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

const ALLOWED_BETS = Object.keys(PAYOUTS).map(n => parseInt(n, 10));

// --- In-memory stores ---
const players = {}; // socketId -> { lightningAddress, acctId, betAmount, paid, gameId }
const invoiceToSocket = {}; // invoiceId -> socketId
const invoiceMeta = {}; // invoiceId -> { betAmount, lightningAddress }
const userSessions = {}; // Maps acct_id to Lightning address
const playerAcctIds = {}; // Maps playerId to acct_id
const processedWebhooks = new Set();

// Removed betting pattern storage/loading to ensure fair gameplay

// Real Speed wallet payment functions from Sea Battle
async function resolveLightningAddress(address, amountSats) {
  try {
    console.log('Resolving Lightning address:', address, 'with amount:', amountSats, 'SATS');
    const [username, domain] = address.split('@');
    if (!username || !domain) {
      throw new Error('Invalid Lightning address');
    }

    const lnurl = `https://${domain}/.well-known/lnurlp/${username}`;
    console.log('Fetching LNURL metadata from:', lnurl);

    const metadataResponse = await axios.get(lnurl, { timeout: 5000 });
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
    const invoiceResponse = await axios.get(`${callback}?amount=${amountMsats}`, { timeout: 5000 });
    const invoice = invoiceResponse.data.pr;

    if (!invoice) {
      throw new Error('No invoice in response');
    }

    return invoice;
  } catch (error) {
    console.error('Error resolving Lightning address:', error.message);
    throw error;
  }
}

// Create a Lightning invoice via Speed Wallet
async function createLightningInvoice(amountSats, customerId, orderId, metadata = {}) {
  try {
    const payload = {
      amount: parseFloat(amountSats),
      currency: 'SATS',
      payment_method: 'lightning',
      customer_id: customerId,
      order_id: orderId,
      metadata,
    };

    const response = await axios.post(
      `${SPEED_API_BASE}/payments`,
      payload,
      {
        headers: {
          Authorization: `Basic ${AUTH_HEADER}`,
          'Content-Type': 'application/json',
          'speed-version': '2022-04-15',
        },
        timeout: 10000,
      }
    );

    const data = response.data || {};
    const invoiceId = data.id || data.payment?.id || data.payment_intent_id;
    const lightningInvoice = data.payment_method_options?.lightning?.payment_request
      || data.lightning_invoice
      || data.invoice
      || data.payment_request
      || data.bolt11;
    const hostedInvoiceUrl = data.hosted_invoice_url || data.hosted_checkout_url || data.checkout_url || null;
    const amountUSD = data.amount_usd || Number((Number(amountSats) * 0.0006).toFixed(2));

    if (!invoiceId || !lightningInvoice) {
      throw new Error('Speed API did not return an invoice');
    }

    return { invoiceId, lightningInvoice, hostedInvoiceUrl, amountSats, amountUSD };
  } catch (error) {
    const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
    console.error('Create Invoice Error:', errorMessage);
    throw new Error(`Failed to create invoice: ${errorMessage}`);
  }
}

// Send instant payment using Speed wallet API
async function sendInstantPayment(withdrawRequest, amount, note = '') {
  try {
    console.log('Sending instant payment via Speed Wallet:', {
      withdrawRequest,
      amount,
      note
    });

    // If a Lightning address was provided, resolve to an invoice (BOLT11)
    let target = withdrawRequest;
    if (typeof target === 'string' && target.includes('@')) {
      try {
        target = await resolveLightningAddress(target, amount);
      } catch (e) {
        console.error('Error resolving LN address for payout:', e.message);
        throw e;
      }
    }

    const instantSendPayload = {
      amount: parseFloat(amount),
      currency: 'SATS',
      target_currency: 'SATS',
      withdraw_method: 'lightning',
      withdraw_request: target,
      note: note
    };

    const response = await axios.post(
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

    console.log('Payment sent successfully:', response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
    console.error('Send Payment Error:', errorMessage);
    throw new Error(`Failed to send payment: ${errorMessage}`);
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
    const response = await axios.get(
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

// Process payout for winner
async function processPayout(winnerId, betAmount, gameId) {
  try {
    const game = games[gameId];
    if (!game || game.status !== 'finished') return;
    
    const winner = game.players[winnerId];
    if (!winner || winner.isBot) return;
    
    const payout = PAYOUTS[betAmount];
    if (!payout) return;
    
    const winAmount = payout.winner;
    const lightningAddress = winner.lightningAddress;
    
    if (!lightningAddress) {
      console.error('No Lightning address for winner');
      return;
    }
    
    console.log(`Processing payout: ${winAmount} SATS to ${lightningAddress}`);
    
    // Send the payment
    const result = await sendInstantPayment(
      lightningAddress,
      winAmount,
      `Tic-Tac-Toe win: ${winAmount} SATS`
    );
    
    // Notify winner
    io.to(winnerId).emit('payment_sent', {
      amount: winAmount,
      status: 'success',
      txId: result.id || 'demo'
    });
    
    console.log('Payout processed successfully');
  } catch (error) {
    console.error('Payout processing error:', error);
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

// Bot thinking times
const BOT_THINK_TIME = { min: 1000, max: 5000 };
const BOT_SPAWN_DELAY = { min: 13000, max: 25000 };

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

// Speed Wallet Webhook: verify and handle payment events
app.post('/webhook', webhookLimiter, webhookQueue, (req, res) => {
  try {
    const signature = req.headers['speed-signature'] || req.headers['speed_signature'] || req.headers['speed-signature-v1'];
    const raw = req.rawBody || JSON.stringify(req.body || {});

    if (!signature) return res.status(400).send('Missing signature');
    const expected = crypto.createHmac('sha256', SPEED_WALLET_WEBHOOK_SECRET).update(raw).digest('hex');
    const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    if (!valid) return res.status(400).send('Invalid signature');

    const event = req.body || {};
    const type = event.event_type || event.type;
    const eventId = event.id || `${type}:${event.data?.object?.id || event.data?.id || 'unknown'}`;
    if (processedWebhooks.has(eventId)) return res.status(200).send('Duplicate');
    processedWebhooks.add(eventId);

    if (['invoice.paid','payment.paid','payment.confirmed'].includes(type)) {
      const invoiceId = event.data?.object?.id || event.data?.id || event.data?.object_id;
      if (invoiceId) handleInvoicePaid(invoiceId, event);
    } else if (type === 'payment.failed') {
      const invoiceId = event.data?.object?.id || event.data?.id || event.data?.object_id;
      const socketId = invoiceToSocket[invoiceId];
      if (socketId) {
        const sock = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
        sock?.emit('error', { message: 'Payment failed. Please try again.' });
      }
      delete invoiceToSocket[invoiceId];
      delete invoiceMeta[invoiceId];
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('server error');
  }
});

function handleInvoicePaid(invoiceId, event) {
  const socketId = invoiceToSocket[invoiceId];
  if (!socketId) return;
  const meta = invoiceMeta[invoiceId] || {};

  players[socketId] = players[socketId] || {};
  players[socketId].paid = true;
  if (meta.betAmount) players[socketId].betAmount = meta.betAmount;
  if (meta.lightningAddress) players[socketId].lightningAddress = meta.lightningAddress;

  const sock = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
  sock?.emit('paymentVerified');

  delete invoiceToSocket[invoiceId];
  delete invoiceMeta[invoiceId];

  attemptMatchOrEnqueue(socketId);
}

function attemptMatchOrEnqueue(socketId) {
  const player = players[socketId];
  if (!player || !player.betAmount || !player.paid) return;

  // Try to find another paid player with the same bet
  const idx = waitingQueue.findIndex(p => p.betAmount === player.betAmount && p.socketId !== socketId);
  if (idx !== -1) {
    const opponent = waitingQueue.splice(idx, 1)[0];
    if (botSpawnTimers[opponent.socketId]) {
      clearTimeout(botSpawnTimers[opponent.socketId]);
      delete botSpawnTimers[opponent.socketId];
    }

    const gameId = uuidv4();
    const game = new Game(gameId, player.betAmount);
    game.addPlayer(opponent.socketId, opponent.lightningAddress);
    game.addPlayer(socketId, player.lightningAddress);
    games[gameId] = game;

    const s1 = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
    const s2 = io.sockets.sockets.get ? io.sockets.sockets.get(opponent.socketId) : io.sockets.sockets[opponent.socketId];
    s1?.join(gameId);
    s2?.join(gameId);

    const startsIn = 5;
    const startAt = Date.now() + startsIn * 1000;
    s1?.emit('matchFound', { opponent: { type: 'player' }, startsIn, startAt });
    s2?.emit('matchFound', { opponent: { type: 'player' }, startsIn, startAt });

    setTimeout(() => {
      game.status = 'playing';
      game.startTurnTimer();
      const turnDeadline = game.turnDeadlineAt || null;
      s1?.emit('startGame', {
        gameId,
        symbol: game.players[socketId].symbol,
        turn: game.turn,
        message: game.turn === socketId ? 'Your move' : "Opponent's move",
        turnDeadline
      });
      s2?.emit('startGame', {
        gameId,
        symbol: game.players[opponent.socketId].symbol,
        turn: game.turn,
        message: game.turn === opponent.socketId ? 'Your move' : "Opponent's move",
        turnDeadline
      });
    }, startsIn * 1000);
  } else {
    // Enqueue and schedule bot spawn
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
      const botAddress = `bot_${Date.now()}@speed.app`;

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

// Bot logic functions (fair play)
function minimax(board, depth, isMaximizing, playerSymbol, opponentSymbol) {
  const winner = checkBoardWinner(board);
  
  if (winner === playerSymbol) return 10 - depth;
  if (winner === opponentSymbol) return depth - 10;
  if (board.every(cell => cell !== null)) return 0;
  
  if (isMaximizing) {
    let maxEval = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = playerSymbol;
        const eval = minimax(board, depth + 1, false, playerSymbol, opponentSymbol);
        board[i] = null;
        maxEval = Math.max(maxEval, eval);
      }
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = opponentSymbol;
        const eval = minimax(board, depth + 1, true, playerSymbol, opponentSymbol);
        board[i] = null;
        minEval = Math.min(minEval, eval);
      }
    }
    return minEval;
  }
}

function checkBoardWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

function getBotMove(game, botId) {
  const bot = game.players[botId];
  if (!bot || !bot.isBot) return null;
  
  const board = [...game.board];
  const botSymbol = bot.symbol;
  const humanSymbol = botSymbol === 'X' ? 'O' : 'X';
  const availableMoves = board.map((cell, i) => cell === null ? i : -1).filter(i => i !== -1);
  
  if (availableMoves.length === 0) return null;
  
  // 1) Take immediate win
  for (const move of availableMoves) {
    board[move] = botSymbol;
    if (checkBoardWinner(board) === botSymbol) { board[move] = null; return move; }
    board[move] = null;
  }
  // 2) Block immediate loss
  for (const move of availableMoves) {
    board[move] = humanSymbol;
    if (checkBoardWinner(board) === humanSymbol) { board[move] = null; return move; }
    board[move] = null;
  }
  // 3) Prefer center, then corners, then edges
  const preferences = [4, 0, 2, 6, 8, 1, 3, 5, 7];
  for (const pref of preferences) {
    if (availableMoves.includes(pref)) return pref;
  }
  
  // 4) Fallback to minimax (balanced)
  let bestMove = availableMoves[0];
  let bestScore = -Infinity;
  for (const move of availableMoves) {
    board[move] = botSymbol;
    const score = minimax(board, 0, false, botSymbol, humanSymbol);
    board[move] = null;
    if (score > bestScore) { bestScore = score; bestMove = move; }
  }
  return bestMove;
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
  
  // Join game queue
  socket.on('joinGame', async (data) => {
    try {
      const { betAmount, lightningAddress } = data || {};
      if (!ALLOWED_BETS.includes(betAmount)) return socket.emit('error', { message: 'Invalid bet amount' });

      const addr = (lightningAddress || '').trim();
      if (!addr || !addr.includes('@')) return socket.emit('error', { message: 'Lightning address is required' });

      players[socket.id] = { ...(players[socket.id] || {}), lightningAddress: addr, betAmount, paid: false };

      // Create invoice and map to socket
      const orderId = `ttt_${uuidv4()}`;
      const { invoiceId, lightningInvoice, hostedInvoiceUrl, amountSats, amountUSD } = await createLightningInvoice(betAmount, null, orderId, { socketId: socket.id, betAmount });
      invoiceToSocket[invoiceId] = socket.id;
      invoiceMeta[invoiceId] = { betAmount, lightningAddress: addr };

      socket.emit('paymentRequest', { invoiceId, lightningInvoice, hostedInvoiceUrl, amountSats, amountUSD });
    } catch (err) {
      console.error('joinGame error:', err.message);
      socket.emit('error', { message: 'Could not create payment request' });
    }
  });
  
  // Handle moves
  socket.on('makeMove', (data) => {
    const { gameId, position } = data || {};
    const game = games[gameId];
    if (!game || game.turn !== socket.id) return socket.emit('error', { message: 'Invalid move' });

    const result = game.makeMove(socket.id, position);
    if (!result.ok) return socket.emit('error', { message: result.reason });

    io.to(gameId).emit('boardUpdate', { board: game.board, lastMove: position });

    if (result.winner) {
      handleGameEnd(gameId, result.winner);
    } else if (result.draw) {
      handleDraw(gameId);
    } else {
      const botId = Object.keys(game.players).find(id => game.players[id].isBot);
      if (botId && game.turn === botId) {
        setTimeout(() => {
          const move = getBotMove(game, botId);
          if (move !== null) {
            const botResult = game.makeMove(botId, move);
            io.to(gameId).emit('boardUpdate', { board: game.board, lastMove: move });
            if (botResult.winner) handleGameEnd(gameId, botResult.winner);
            else if (botResult.draw) handleDraw(gameId);
          }
        }, BOT_THINK_TIME.min + Math.random() * (BOT_THINK_TIME.max - BOT_THINK_TIME.min));
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

// Handle game end
function handleGameEnd(gameId, winnerId) {
  const game = games[gameId];
  if (!game) return;

  game.status = 'finished';
  game.clearTurnTimer();

  const winnerSymbol = game.players[winnerId]?.symbol || null;
  const winningLine = Array.isArray(game.winLine) ? game.winLine : [];
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

  if (!game.players[winnerId]?.isBot) {
    processPayout(winnerId, game.betAmount, gameId);
  }

  setTimeout(() => { delete games[gameId]; }, 30000);
}

function handleDraw(gameId) {
  const game = games[gameId];
  if (!game) return;
  game.status = 'finished';
  game.clearTurnTimer();
  io.to(gameId).emit('gameEnd', {
    message: 'Draw — rematch next time',
    winnerSymbol: null,
    winningLine: []
  });
  setTimeout(() => { delete games[gameId]; }, 30000);
}

// Start server (Render/Railway will set PORT)
const PORT = process.env.PORT || process.env.BACKEND_PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tic-Tac-Toe backend running on port ${PORT}`);
});
