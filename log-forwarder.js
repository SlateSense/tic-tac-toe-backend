const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration for log forwarding
const LOG_FORWARDING_CONFIG = {
  enabled: process.env.LOG_FORWARDING_ENABLED === 'true' || false,
  localEndpoint: process.env.LOCAL_LOG_ENDPOINT || 'http://localhost:3001/logs',
  fallbackToFile: true,
  maxRetries: 3,
  retryDelay: 1000
};

class LogForwarder {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.localLogsDir = path.join(__dirname, 'forwarded-logs');
    this.ensureLogsDirectory();
  }

  ensureLogsDirectory() {
    if (!fs.existsSync(this.localLogsDir)) {
      fs.mkdirSync(this.localLogsDir, { recursive: true });
    }
  }

  async forwardLog(logType, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      logType,
      data,
      source: 'tic-tac-toe-server'
    };

    // Add to queue
    this.queue.push(logEntry);

    // Process queue if not already processing
    if (!this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    this.processing = true;

    while (this.queue.length > 0) {
      const logEntry = this.queue.shift();

      try {
        // Try to send to local endpoint first
        if (LOG_FORWARDING_CONFIG.enabled) {
          await this.sendToLocalEndpoint(logEntry);
        }
      } catch (error) {
        // Fallback to saving to file
        if (LOG_FORWARDING_CONFIG.fallbackToFile) {
          try {
            await this.saveToFile(logEntry);
          } catch (e) {
            // swallow error
          }
        }
      }
    }

    this.processing = false;
  }

  async sendToLocalEndpoint(logEntry) {
    const response = await axios.post(LOG_FORWARDING_CONFIG.localEndpoint, logEntry, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'tic-tac-toe'
      }
    });
    return response.data;
  }

  async saveToFile(logEntry) {
    const today = new Date().toISOString().split('T')[0];
    const filename = `${logEntry.logType}-${today}.json`;
    const filepath = path.join(this.localLogsDir, filename);

    // Append to file
    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(filepath, logLine);
  }

  async logPlayerSession(lightningAddress, sessionData) {
    await this.forwardLog('player-session', {
      lightningAddress,
      sessionData,
      event: sessionData.event || 'session_update'
    });
  }

  async logPayment(playerId, paymentData) {
    await this.forwardLog('payment', {
      playerId,
      paymentData,
      event: paymentData.event || 'payment_event'
    });
  }

  async logGameEvent(gameId, eventData) {
    await this.forwardLog('game-event', {
      gameId,
      eventData,
      event: eventData.event || 'game_event'
    });
  }

  async logError(errorData) {
    await this.forwardLog('error', {
      errorData,
      event: 'error'
    });
  }
}

const logForwarder = new LogForwarder();
module.exports = logForwarder;
