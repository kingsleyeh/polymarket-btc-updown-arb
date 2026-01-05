"use strict";
/**
 * Configuration Constants
 * BTC Up/Down 15-Minute Arbitrage Bot
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_LEVEL = exports.BTC_UP_DOWN_15MIN_SERIES_ID = exports.SCAN_INTERVAL_MS = exports.PAPER_MAX_SHARES = exports.EXPIRY_CUTOFF_SECONDS = exports.MIN_EDGE = exports.GAMMA_API_URL = exports.CLOB_API_URL = void 0;
// API Endpoints
exports.CLOB_API_URL = 'https://clob.polymarket.com';
exports.GAMMA_API_URL = 'https://gamma-api.polymarket.com';
// Arbitrage Settings
exports.MIN_EDGE = 0.02; // 2% minimum edge
exports.EXPIRY_CUTOFF_SECONDS = 120; // Ignore last 2 minutes before expiry
exports.PAPER_MAX_SHARES = 100; // Max shares per paper trade
// Scan Settings
exports.SCAN_INTERVAL_MS = 300; // 300ms between scans (fast polling)
// Market Discovery
// BTC Up/Down 15-minute series ID (from Polymarket)
exports.BTC_UP_DOWN_15MIN_SERIES_ID = 10114; // BTC Hourly series includes 15-min
// Logging
exports.LOG_LEVEL = process.env.LOG_LEVEL || 'info';
//# sourceMappingURL=constants.js.map