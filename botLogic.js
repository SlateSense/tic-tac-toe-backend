const winston = require('winston');

// Bot logger
const botLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/bot-games.log' })
  ]
});

// Player history tracking for patterns
const playerHistory = new Map();

// Win/loss patterns
const PATTERN_50_SATS = ['W', 'L', 'W', 'W', 'L', 'L', 'L', 'W', 'L'];
const PATTERN_300_PLUS = ['L', 'W', 'L', 'W', 'L', 'L', 'W', 'L', 'W'];

// Track player bet history for 300+ sats logic
const betHistory = new Map(); // lightningAddress -> { lastBet, lastResult, gameCount }

class BotPlayer {
  constructor(gameId, betAmount, opponentAddress) {
    this.gameId = gameId;
    this.betAmount = betAmount;
    this.opponentAddress = opponentAddress;
    this.moveHistory = [];
    this.thinkingTime = this.generateThinkingTime();
    this.shouldWin = this.determineOutcome();
    this.drawCount = 0;
    this.maxDrawsBeforeEnd = this.shouldWin ? 
      Math.floor(Math.random() * 4) + 2 : // 2-5 draws if bot should lose
      Math.floor(Math.random() * 2) + 3;   // 3-4 draws if bot should win
  }

  generateThinkingTime() {
    // Human-like thinking time between 1.5-4.5 seconds
    return Math.floor(Math.random() * 3000) + 1500;
  }

  determineOutcome() {
    if (!this.opponentAddress) return Math.random() > 0.5;

    // Initialize player history if needed
    if (!playerHistory.has(this.opponentAddress)) {
      playerHistory.set(this.opponentAddress, {
        patternIndex50: 0,
        patternIndex300: 0,
        gamesPlayed: 0
      });
    }

    const history = playerHistory.get(this.opponentAddress);
    
    if (this.betAmount === 50) {
      // Use 50 sats pattern: W-L-W-W-L-L-L-W-L
      const outcome = PATTERN_50_SATS[history.patternIndex50 % PATTERN_50_SATS.length];
      history.patternIndex50++;
      history.gamesPlayed++;
      
      botLogger.info({
        event: 'bot_outcome_determined',
        gameId: this.gameId,
        betAmount: this.betAmount,
        pattern: '50_sats',
        patternIndex: history.patternIndex50 - 1,
        outcome: outcome,
        opponentAddress: this.opponentAddress
      });
      
      return outcome === 'W';
    } else if (this.betAmount >= 300) {
      // Initialize bet history for this player
      if (!betHistory.has(this.opponentAddress)) {
        betHistory.set(this.opponentAddress, {
          lastBet: null,
          lastResult: null,
          gameCount: 0,
          consecutiveSameBet: 0
        });
      }
      
      const betInfo = betHistory.get(this.opponentAddress);
      
      // Check if this is a repeat bet after a loss
      if (betInfo.lastBet === this.betAmount && betInfo.lastResult === 'L') {
        // Player lost last time with same bet amount - let them win
        betInfo.lastResult = 'W';
        betInfo.gameCount++;
        
        botLogger.info({
          event: 'bot_outcome_determined',
          gameId: this.gameId,
          betAmount: this.betAmount,
          pattern: '300_plus_revenge',
          outcome: 'player_wins',
          reason: 'same_bet_after_loss',
          opponentAddress: this.opponentAddress
        });
        
        return false; // Bot loses (player wins)
      }
      
      // Use 300+ sats pattern: L-W-L-W-L-L-W-L-W
      const outcome = PATTERN_300_PLUS[history.patternIndex300 % PATTERN_300_PLUS.length];
      history.patternIndex300++;
      history.gamesPlayed++;
      
      // Update bet history
      betInfo.lastBet = this.betAmount;
      betInfo.lastResult = outcome === 'W' ? 'W' : 'L';
      betInfo.gameCount++;
      
      botLogger.info({
        event: 'bot_outcome_determined',
        gameId: this.gameId,
        betAmount: this.betAmount,
        pattern: '300_plus',
        patternIndex: history.patternIndex300 - 1,
        outcome: outcome,
        opponentAddress: this.opponentAddress
      });
      
      return outcome === 'W';
    }
    
    // Default random for other amounts
    return Math.random() > 0.5;
  }

  evaluateBoard(board) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
      [0, 4, 8], [2, 4, 6] // diagonals
    ];

    // Check for wins/blocks
    for (const line of lines) {
      const [a, b, c] = line;
      const values = [board[a], board[b], board[c]];
      
      // Can win
      if (values.filter(v => v === 'O').length === 2 && values.includes(null)) {
        return line[values.indexOf(null)];
      }
    }

    for (const line of lines) {
      const [a, b, c] = line;
      const values = [board[a], board[b], board[c]];
      
      // Must block
      if (values.filter(v => v === 'X').length === 2 && values.includes(null)) {
        return line[values.indexOf(null)];
      }
    }

    return null;
  }

  getStrategicMove(board) {
    // Check if we can win or need to block
    const critical = this.evaluateBoard(board);
    if (critical !== null) return critical;

    // Prefer center
    if (board[4] === null) return 4;

    // Prefer corners
    const corners = [0, 2, 6, 8].filter(i => board[i] === null);
    if (corners.length > 0) {
      return corners[Math.floor(Math.random() * corners.length)];
    }

    // Take any edge
    const edges = [1, 3, 5, 7].filter(i => board[i] === null);
    if (edges.length > 0) {
      return edges[Math.floor(Math.random() * edges.length)];
    }

    return null;
  }

  makeNoobMove(board) {
    const available = board.map((cell, i) => cell === null ? i : -1).filter(i => i !== -1);
    
    // Sometimes miss obvious winning moves (30% chance)
    if (Math.random() < 0.3) {
      const winMove = this.evaluateBoard(board);
      if (winMove !== null) {
        // Intentionally pick a different move
        const otherMoves = available.filter(m => m !== winMove);
        if (otherMoves.length > 0) {
          return otherMoves[Math.floor(Math.random() * otherMoves.length)];
        }
      }
    }
    
    // Sometimes miss blocks (40% chance)
    if (Math.random() < 0.4) {
      // Just pick random
      return available[Math.floor(Math.random() * available.length)];
    }
    
    // Otherwise play somewhat strategically but not perfectly
    return this.getStrategicMove(board) || available[Math.floor(Math.random() * available.length)];
  }

  getNextMove(board, moveCount) {
    const available = board.map((cell, i) => cell === null ? i : -1).filter(i => i !== -1);
    
    if (available.length === 0) return null;

    // Check if this could be a draw
    const isDraw = this.checkPotentialDraw(board);
    
    if (isDraw && this.drawCount >= this.maxDrawsBeforeEnd) {
      // Time to end the game based on predetermined outcome
      if (this.shouldWin) {
        // Bot should win - play optimally
        return this.getStrategicMove(board) || available[0];
      } else {
        // Bot should lose - make a "mistake"
        return this.makeNoobMove(board);
      }
    }

    // Normal gameplay
    if (this.shouldWin) {
      // Play strategically but not perfectly to seem human
      if (Math.random() < 0.85) {
        return this.getStrategicMove(board) || available[Math.floor(Math.random() * available.length)];
      } else {
        // Occasional random move
        return available[Math.floor(Math.random() * available.length)];
      }
    } else {
      // Play like a noob when supposed to lose
      return this.makeNoobMove(board);
    }
  }

  checkPotentialDraw(board) {
    // Simple heuristic: if more than 5 moves made and no clear winner path
    const filledCells = board.filter(cell => cell !== null).length;
    if (filledCells >= 5) {
      this.drawCount++;
      return true;
    }
    return false;
  }

  logMove(position, board) {
    this.moveHistory.push({
      position,
      boardState: [...board],
      timestamp: Date.now()
    });
  }
}

// Bot spawn timing
function getRandomBotSpawnDelay() {
  // Random delay between 13-25 seconds
  return Math.floor(Math.random() * 12000) + 13000;
}

// Generate bot Lightning address
function generateBotLightningAddress() {
  const botNames = [
    'player', 'gamer', 'pro', 'master', 'champion',
    'rookie', 'legend', 'ninja', 'wizard', 'knight',
    'dragon', 'phoenix', 'thunder', 'storm', 'shadow'
  ];
  const name = botNames[Math.floor(Math.random() * botNames.length)];
  const num = Math.floor(Math.random() * 9999);
  return `${name}${num}@speed.app`;
}

module.exports = {
  BotPlayer,
  getRandomBotSpawnDelay,
  generateBotLightningAddress,
  playerHistory,
  betHistory,
  PATTERN_50_SATS,
  PATTERN_300_PLUS
};
