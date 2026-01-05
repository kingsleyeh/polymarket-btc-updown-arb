"use strict";
/**
 * Arbitrage Logger
 *
 * Writes arb data to CSV and JSON files for offline analysis
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeLogFiles = initializeLogFiles;
exports.logArbitrage = logArbitrage;
exports.logPaperTrade = logPaperTrade;
exports.incrementScanCount = incrementScanCount;
exports.incrementArbCount = incrementArbCount;
exports.getScanStats = getScanStats;
exports.getLoggedArbs = getLoggedArbs;
exports.resetStats = resetStats;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// File paths
const DATA_DIR = path.join(process.cwd(), 'data');
const ARB_LOG_CSV = path.join(DATA_DIR, 'arbitrage_log.csv');
const ARB_LOG_JSON = path.join(DATA_DIR, 'arbitrage_log.json');
const PAPER_TRADES_JSON = path.join(DATA_DIR, 'paper_trades.json');
const SCAN_STATS_JSON = path.join(DATA_DIR, 'scan_stats.json');
// CSV header
const CSV_HEADER = [
    'timestamp',
    'market_id',
    'market_title',
    'expiry_timestamp',
    'up_price',
    'down_price',
    'combined_cost',
    'simulated_shares',
    'guaranteed_profit',
    'up_liquidity',
    'down_liquidity',
    'time_to_expiry_at_entry',
    'persistence_duration_sec',
    'scan_cycles_observed',
    'disappearance_reason',
].join(',');
/**
 * Ensure data directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}
/**
 * Initialize log files
 */
function initializeLogFiles() {
    ensureDataDir();
    // Initialize CSV with header if not exists
    if (!fs.existsSync(ARB_LOG_CSV)) {
        fs.writeFileSync(ARB_LOG_CSV, CSV_HEADER + '\n');
    }
    // Initialize JSON arrays if not exists
    if (!fs.existsSync(ARB_LOG_JSON)) {
        fs.writeFileSync(ARB_LOG_JSON, '[]');
    }
    if (!fs.existsSync(PAPER_TRADES_JSON)) {
        fs.writeFileSync(PAPER_TRADES_JSON, '[]');
    }
    // Initialize scan stats
    if (!fs.existsSync(SCAN_STATS_JSON)) {
        const initialStats = {
            total_scans: 0,
            markets_scanned: 0,
            arbs_found: 0,
            arbs_per_hour: 0,
            start_time: Date.now(),
        };
        fs.writeFileSync(SCAN_STATS_JSON, JSON.stringify(initialStats, null, 2));
    }
}
/**
 * Log an arbitrage entry
 */
function logArbitrage(entry) {
    ensureDataDir();
    // Append to CSV
    const csvLine = [
        entry.timestamp,
        entry.market_id,
        `"${entry.market_title.replace(/"/g, '""')}"`,
        entry.expiry_timestamp,
        entry.up_price.toFixed(4),
        entry.down_price.toFixed(4),
        entry.combined_cost.toFixed(4),
        entry.simulated_shares.toFixed(2),
        entry.guaranteed_profit.toFixed(4),
        entry.up_liquidity.toFixed(2),
        entry.down_liquidity.toFixed(2),
        entry.time_to_expiry_at_entry.toFixed(0),
        entry.persistence_duration_sec.toFixed(1),
        entry.scan_cycles_observed,
        entry.disappearance_reason || '',
    ].join(',');
    fs.appendFileSync(ARB_LOG_CSV, csvLine + '\n');
    // Append to JSON
    try {
        const existing = JSON.parse(fs.readFileSync(ARB_LOG_JSON, 'utf-8'));
        existing.push(entry);
        fs.writeFileSync(ARB_LOG_JSON, JSON.stringify(existing, null, 2));
    }
    catch {
        fs.writeFileSync(ARB_LOG_JSON, JSON.stringify([entry], null, 2));
    }
}
/**
 * Log a paper trade
 */
function logPaperTrade(trade) {
    ensureDataDir();
    try {
        const existing = JSON.parse(fs.readFileSync(PAPER_TRADES_JSON, 'utf-8'));
        existing.push(trade);
        fs.writeFileSync(PAPER_TRADES_JSON, JSON.stringify(existing, null, 2));
    }
    catch {
        fs.writeFileSync(PAPER_TRADES_JSON, JSON.stringify([trade], null, 2));
    }
}
/**
 * Increment scan count
 */
function incrementScanCount(marketsScanned) {
    ensureDataDir();
    try {
        const stats = getScanStats();
        const hoursRunning = (Date.now() - stats.start_time) / (1000 * 60 * 60);
        stats.total_scans++;
        stats.markets_scanned += marketsScanned;
        stats.arbs_per_hour = hoursRunning > 0 ? stats.arbs_found / hoursRunning : 0;
        fs.writeFileSync(SCAN_STATS_JSON, JSON.stringify(stats, null, 2));
    }
    catch {
        // Ignore errors
    }
}
/**
 * Increment arb count
 */
function incrementArbCount() {
    ensureDataDir();
    try {
        const stats = getScanStats();
        const hoursRunning = (Date.now() - stats.start_time) / (1000 * 60 * 60);
        stats.arbs_found++;
        stats.arbs_per_hour = hoursRunning > 0 ? stats.arbs_found / hoursRunning : 0;
        fs.writeFileSync(SCAN_STATS_JSON, JSON.stringify(stats, null, 2));
    }
    catch {
        // Ignore errors
    }
}
/**
 * Get current scan stats
 */
function getScanStats() {
    ensureDataDir();
    try {
        if (fs.existsSync(SCAN_STATS_JSON)) {
            return JSON.parse(fs.readFileSync(SCAN_STATS_JSON, 'utf-8'));
        }
    }
    catch {
        // Ignore errors
    }
    return {
        total_scans: 0,
        markets_scanned: 0,
        arbs_found: 0,
        arbs_per_hour: 0,
        start_time: Date.now(),
    };
}
/**
 * Get all logged arbs
 */
function getLoggedArbs() {
    try {
        if (fs.existsSync(ARB_LOG_JSON)) {
            return JSON.parse(fs.readFileSync(ARB_LOG_JSON, 'utf-8'));
        }
    }
    catch {
        // Ignore errors
    }
    return [];
}
/**
 * Reset stats for new session
 */
function resetStats() {
    ensureDataDir();
    const stats = {
        total_scans: 0,
        markets_scanned: 0,
        arbs_found: 0,
        arbs_per_hour: 0,
        start_time: Date.now(),
    };
    fs.writeFileSync(SCAN_STATS_JSON, JSON.stringify(stats, null, 2));
}
//# sourceMappingURL=arb-logger.js.map