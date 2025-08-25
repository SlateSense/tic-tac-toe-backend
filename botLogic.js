// Bot logic for Tic-Tac-Toe with human-like behavior
const winston = require('winston');
require('winston-daily-rotate-file');

// Bot logger for tracking bot behavior
const botLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
      archiveCompressed: true
    })
  ]
});

// Game history tracking per Lightning address
const gameHistory = new Map(); // Map<lightningAddress, GameHistoryEntry>

class GameHistoryEntry {
  constructor(lightningAddress) {
    this.lightningAddress = lightningAddress;
    this.games = []; // Array of game results
    this.pattern50Index = 0; // Index in the 50 sats pattern
    this.pattern300Index = 0; // Index in the 300+ sats pattern
    this.lastBetAmount = 0;
    this.lastGameResult = null; // 'win' or 'lose'
    this.consecutiveGames = 0;
  }

  addGame(betAmount, result, gameId) {
    this.games.push({
      gameId,
      betAmount,
      result,
      timestamp: Date.now()
    });
    this.lastBetAmount = betAmount;
    this.lastGameResult = result;
    this.consecutiveGames++;
    
    // Update pattern indices
    if (betAmount === 50) {
      this.pattern50Index = (this.pattern50Index + 1) % 9;
    } else if (betAmount >= 300) {
      this.pattern300Index = (this.pattern300Index + 1) % 9;
    }
    
    botLogger.info({
      event: 'game_history_updated',
      lightningAddress: this.lightningAddress,
      gameId,
      betAmount,
      result,
      pattern50Index: this.pattern50Index,
      pattern300Index: this.pattern300Index
    });
  }

  shouldPlayerWin(betAmount) {
    // Pattern for 50 sats: W-L-W-W-L-L-L-W-L
    const pattern50 = [true, false, true, true, false, false, false, true, false];
    
    // Pattern for 300+ sats: L-W-L-W-L-L-W-L-W
    const pattern300 = [false, true, false, true, false, false, true, false, true];
    
    if (betAmount === 50) {
      return pattern50[this.pattern50Index];
    } else if (betAmount >= 300) {
      // Special logic: player wins on second try with same bet amount
      if (this.lastGameResult === 'lose' && this.lastBetAmount === betAmount) {
        // Check if this is truly the second game with same bet
        const recentGames = this.games.slice(-2);
        if (recentGames.length >= 1 && 
            recentGames[recentGames.length - 1].betAmount === betAmount &&
            recentGames[recentGames.length - 1].result === 'lose') {
          return true; // Give them the win on retry
        }
      }
      return pattern300[this.pattern300Index];
    }
    
    // Default: 50% chance
    return Math.random() < 0.5;
  }
}

// Get or create game history for a Lightning address
function getGameHistory(lightningAddress) {
  if (!gameHistory.has(lightningAddress)) {
    gameHistory.set(lightningAddress, new GameHistoryEntry(lightningAddress));
  }
  return gameHistory.get(lightningAddress);
}

// Bot AI for making moves
class BotAI {
  constructor(game, difficulty = 'adaptive') {
    this.game = game;
    this.difficulty = difficulty; // 'easy', 'medium', 'hard', 'adaptive'
    this.drawCount = 0;
    this.shouldWin = true; // Will be set based on pattern
  }

  setShouldWin(shouldWin) {
    this.shouldWin = shouldWin;
    botLogger.info({
      event: 'bot_difficulty_set',
      gameId: this.game.id,
      shouldWin: shouldWin,
      betAmount: this.game.betAmount
    });
  }

  // Get the best move using minimax
  minimax(board, depth, isMaximizing, alpha, beta) {
    const result = this.evaluateBoard(board);
    
    if (result !== null || depth === 0) {
      return result || 0;
    }
    
    const botSymbol = this.getBotSymbol();
    const playerSymbol = this.getPlayerSymbol();
    const currentSymbol = isMaximizing ? botSymbol : playerSymbol;
    
    if (isMaximizing) {
      let maxEval = -Infinity;
      for (let i = 0; i < 9; i++) {
        if (board[i] === null) {
          board[i] = currentSymbol;
          const score = this.minimax(board, depth - 1, false, alpha, beta);
          board[i] = null;
          maxEval = Math.max(maxEval, score);
          alpha = Math.max(alpha, score);
          if (beta <= alpha) break;
        }
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (let i = 0; i < 9; i++) {
        if (board[i] === null) {
          board[i] = currentSymbol;
          const score = this.minimax(board, depth - 1, true, alpha, beta);
          board[i] = null;
          minEval = Math.min(minEval, score);
          beta = Math.min(beta, score);
          if (beta <= alpha) break;
        }
      }
      return minEval;
    }
  }

  evaluateBoard(board) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];
    
    const botSymbol = this.getBotSymbol();
    const playerSymbol = this.getPlayerSymbol();
    
    for (const line of lines) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a] === botSymbol ? 10 : -10;
      }
    }
    
    if (board.every(cell => cell !== null)) {
      return 0; // Draw
    }
    
    return null; // Game not over
  }

  getBotSymbol() {
    const botId = Object.keys(this.game.players).find(id => this.game.players[id].isBot);
    return this.game.players[botId]?.symbol;
  }

  getPlayerSymbol() {
    const playerId = Object.keys(this.game.players).find(id => !this.game.players[id].isBot);
    return this.game.players[playerId]?.symbol;
  }

  // Get available moves
  getAvailableMoves() {
    return this.game.board
      .map((cell, i) => cell === null ? i : -1)
      .filter(i => i !== -1);
  }

  // Make a strategic mistake (for when bot should lose)
  makeStrategicMistake() {
    const availableMoves = this.getAvailableMoves();
    if (availableMoves.length === 0) return -1;
    
    // Avoid winning moves if we should lose
    const goodMoves = [];
    const badMoves = [];
    
    for (const move of availableMoves) {
      const testBoard = [...this.game.board];
      testBoard[move] = this.getBotSymbol();
      const score = this.evaluateBoard(testBoard);
      
      if (score === 10) {
        badMoves.push(move); // Winning move - avoid it
      } else {
        // Check if this move blocks player from winning
        testBoard[move] = null;
        testBoard[move] = this.getPlayerSymbol();
        const playerScore = this.evaluateBoard(testBoard);
        if (playerScore === -10) {
          // This blocks player win - maybe skip it sometimes
          if (Math.random() < 0.3) { // 30% chance to miss the block
            badMoves.push(move);
          } else {
            goodMoves.push(move);
          }
        } else {
          goodMoves.push(move);
        }
      }
    }
    
    // Prefer moves that don't win but still look reasonable
    const movesToConsider = goodMoves.length > 0 ? goodMoves : availableMoves;
    
    // After several draws, make an obvious mistake
    if (this.drawCount >= 2 && this.drawCount <= 5 && Math.random() < 0.6) {
      // Make a bad move that lets player win
      const losingMoves = this.findLosingMoves();
      if (losingMoves.length > 0) {
        return losingMoves[Math.floor(Math.random() * losingMoves.length)];
      }
    }
    
    return movesToConsider[Math.floor(Math.random() * movesToConsider.length)];
  }

  // Find moves that would let the player win
  findLosingMoves() {
    const availableMoves = this.getAvailableMoves();
    const losingMoves = [];
    
    for (const move of availableMoves) {
      const testBoard = [...this.game.board];
      testBoard[move] = this.getBotSymbol();
      
      // Check if after this move, player can win
      for (let i = 0; i < 9; i++) {
        if (testBoard[i] === null) {
          testBoard[i] = this.getPlayerSymbol();
          const score = this.evaluateBoard(testBoard);
          if (score === -10) {
            losingMoves.push(move);
            break;
          }
          testBoard[i] = null;
        }
      }
    }
    
    return losingMoves;
  }

  // Get the next move based on difficulty and game state
  getNextMove() {
    const availableMoves = this.getAvailableMoves();
    if (availableMoves.length === 0) return -1;
    
    // Check for draws
    if (this.game.moveCount >= 5) {
      const result = this.game.checkWinner();
      if (!result.winner && availableMoves.length <= 4) {
        this.drawCount++;
      }
    }
    
    // If bot should lose (based on pattern)
    if (!this.shouldWin) {
      // Make it look competitive but ultimately lose
      if (this.game.moveCount < 3) {
        // Play normally at start
        return this.getStrategicMove(0.7); // 70% optimal
      } else {
        // Start making "mistakes"
        return this.makeStrategicMistake();
      }
    }
    
    // If bot should win
    if (this.shouldWin) {
      // After 3-4 draws in cheating mode, win decisively
      if (this.drawCount >= 3 && this.drawCount <= 4) {
        return this.getBestMove(); // Play perfectly to win
      }
      // Otherwise play strong but not perfect
      return this.getStrategicMove(0.85); // 85% optimal
    }
    
    // Default: balanced play
    return this.getStrategicMove(0.6);
  }

  // Get best move using minimax
  getBestMove() {
    const availableMoves = this.getAvailableMoves();
    let bestMove = availableMoves[0];
    let bestScore = -Infinity;
    
    for (const move of availableMoves) {
      const testBoard = [...this.game.board];
      testBoard[move] = this.getBotSymbol();
      const score = this.minimax(testBoard, 6, false, -Infinity, Infinity);
      
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }
    
    return bestMove;
  }

  // Get a strategic move with some randomness
  getStrategicMove(optimalChance = 0.7) {
    if (Math.random() < optimalChance) {
      return this.getBestMove();
    } else {
      // Make a random but not terrible move
      const availableMoves = this.getAvailableMoves();
      
      // Prefer center and corners
      const preferredMoves = availableMoves.filter(m => 
        m === 4 || m === 0 || m === 2 || m === 6 || m === 8
      );
      
      if (preferredMoves.length > 0) {
        return preferredMoves[Math.floor(Math.random() * preferredMoves.length)];
      }
      
      return availableMoves[Math.floor(Math.random() * availableMoves.length)];
    }
  }
}

// Generate human-like thinking time
function getHumanLikeDelay(moveCount, isFirstMove) {
  if (isFirstMove) {
    // First move: 2-4 seconds
    return 2000 + Math.random() * 2000;
  }
  
  // Later moves: 1.5-4.5 seconds with variation
  const baseTime = 1500;
  const variableTime = Math.random() * 3000;
  
  // Sometimes think longer on complex positions
  if (moveCount >= 4 && Math.random() < 0.3) {
    return baseTime + variableTime + 1000;
  }
  
  return baseTime + variableTime;
}

// Export functions
module.exports = {
  BotAI,
  getGameHistory,
  GameHistoryEntry,
  getHumanLikeDelay,
  botLogger
};
