/**
 * Configuration Constants
 * BTC Up/Down 15-Minute Arbitrage Bot
 */
// API Endpoints
export const CLOB_API_URL = 'https://clob.polymarket.com';
export const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
// Arbitrage Settings
export const MIN_EDGE = 0.02; // 2% minimum edge
export const EXPIRY_CUTOFF_SECONDS = 180; // Ignore last 3 minutes before expiry
export const PAPER_MAX_SHARES = 100; // Max shares per paper trade
// Scan Settings
export const SCAN_INTERVAL_MS = 200; // 200ms between scans (fast but reasonable)
// Market Discovery
// BTC Up/Down 15-minute series ID (from Polymarket)
export const BTC_UP_DOWN_15MIN_SERIES_ID = 10114; // BTC Hourly series includes 15-min
// Logging
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
//# sourceMappingURL=constants.js.map