"use strict";
/**
 * BTC Up/Down 15-Minute Arbitrage Bot
 *
 * LIVE TRADING - $5 per trade
 *
 * Strategy: Buy BOTH Up + Down when combined cost < $0.98
 * Hold to expiry, collect $1 guaranteed
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
const dotenv = __importStar(require("dotenv"));
const scanner_1 = require("./crypto/scanner");
const arbitrage_1 = require("./crypto/arbitrage");
const arb_logger_1 = require("./crypto/arb-logger");
const server_1 = require("./dashboard/server");
const trader_1 = require("./execution/trader");
const constants_1 = require("./config/constants");
// Load environment variables
dotenv.config();
// Trade size
const TRADE_SIZE_USD = 5;
// Dashboard logging helper
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    (0, server_1.pushLog)(message);
}
/**
 * Main bot class
 */
class BTCUpDownArbBot {
    isRunning = false;
    scanInterval = null;
    markets = [];
    scanCount = 0;
    startTime = Date.now();
    executedMarkets = new Set(); // Prevent duplicate trades
    /**
     * Initialize the bot
     */
    async initialize() {
        log('Initializing BTC Up/Down Arbitrage Bot...');
        this.startTime = Date.now();
        // Reset stats for new session
        (0, arb_logger_1.resetStats)();
        (0, arb_logger_1.initializeLogFiles)();
        // Initialize trader with wallet
        log('Connecting to Polymarket...');
        const traderReady = await (0, trader_1.initializeTrader)();
        if (!traderReady) {
            log('ERROR: Failed to initialize trader - check POLYMARKET_PRIVATE_KEY');
            return false;
        }
        log('✓ Wallet connected');
        // Initial market scan
        log('Scanning for BTC Up/Down 15-minute markets...');
        this.markets = await (0, scanner_1.scanBTCUpDownMarkets)();
        if (this.markets.length === 0) {
            log('⚠️ No BTC Up/Down markets found - will keep scanning');
        }
        else {
            const summary = (0, scanner_1.getMarketSummary)(this.markets);
            log(`✓ Found ${summary.total} BTC Up/Down markets`);
            log(`  Time to expiry: ${Math.round(summary.avg_time_to_expiry / 60)} minutes`);
            (0, server_1.updateStats)({
                marketsCount: summary.total,
            });
        }
        log(`Mode: LIVE TRADING - $${TRADE_SIZE_USD} per trade`);
        log(`Min edge: ${(constants_1.MIN_EDGE * 100).toFixed(1)}%`);
        log(`Expiry cutoff: ${constants_1.EXPIRY_CUTOFF_SECONDS}s`);
        log(`Scan interval: ${constants_1.SCAN_INTERVAL_MS}ms`);
        return true;
    }
    /**
     * Start the bot
     */
    async start() {
        if (this.isRunning) {
            log('Bot already running');
            return;
        }
        log('🚀 Starting arbitrage scanner...');
        this.isRunning = true;
        (0, server_1.updateStats)({
            status: 'running',
            startTime: this.startTime,
        });
        // Run initial scan
        await this.runScanCycle();
        // Start periodic scanning
        this.scanInterval = setInterval(() => this.runScanCycle(), constants_1.SCAN_INTERVAL_MS);
        // Refresh markets every 30 seconds
        setInterval(async () => {
            this.markets = await (0, scanner_1.scanBTCUpDownMarkets)();
            // Clear executed markets when new market window starts
            if (this.markets.length > 0) {
                const currentMarketId = this.markets[0].id;
                if (!this.executedMarkets.has(currentMarketId)) {
                    this.executedMarkets.clear();
                }
            }
            (0, server_1.updateStats)({ marketsCount: this.markets.length });
        }, 30 * 1000);
        log('✓ Bot is running - monitoring for arbitrage');
    }
    /**
     * Run a single scan cycle
     */
    async runScanCycle() {
        if (!(0, trader_1.isTraderReady)()) {
            return;
        }
        this.scanCount++;
        let pricesChecked = 0;
        let arbsThisCycle = 0;
        // Refresh markets if empty
        if (this.markets.length === 0) {
            if (this.scanCount % 5 === 0) {
                this.markets = await (0, scanner_1.scanBTCUpDownMarkets)();
            }
            if (this.markets.length === 0) {
                if (this.scanCount % 20 === 0) {
                    log(`Scan #${this.scanCount}: No markets available`);
                }
                return;
            }
        }
        let bestCombined = 999;
        for (const market of this.markets) {
            // Skip if we already executed on this market
            if (this.executedMarkets.has(market.id)) {
                continue;
            }
            try {
                // Fetch current prices
                const prices = await (0, arbitrage_1.fetchMarketPrices)(market);
                if (!prices) {
                    continue;
                }
                pricesChecked++;
                // Track best combined cost
                const combined = prices.up_price + prices.down_price;
                if (combined < bestCombined) {
                    bestCombined = combined;
                }
                // Check for arbitrage
                const arb = (0, arbitrage_1.checkArbitrage)(market, prices);
                if (arb) {
                    arbsThisCycle++;
                    (0, arb_logger_1.incrementArbCount)();
                    const profit = (arb.edge * 100).toFixed(2);
                    const timeToExpiry = Math.round(arb.time_to_expiry_seconds / 60);
                    log(`🎯 ARB FOUND! ${market.question}`);
                    log(`   Up=$${prices.up_price.toFixed(3)} + Down=$${prices.down_price.toFixed(3)} = $${arb.combined_cost.toFixed(4)}`);
                    log(`   Edge: ${profit}% | Expiry in: ${timeToExpiry} minutes`);
                    // EXECUTE REAL TRADE
                    const trade = await (0, trader_1.executeTrade)(arb);
                    if (trade && trade.status === 'filled') {
                        // Mark this market as executed to prevent duplicate trades
                        this.executedMarkets.add(market.id);
                        // Update dashboard
                        const execStats = (0, trader_1.getExecutionStats)();
                        (0, server_1.updateStats)({
                            arbsFound: execStats.total_trades,
                            totalProfit: execStats.total_profit,
                            totalCost: execStats.total_cost,
                            pendingPayout: execStats.pending_payout,
                        });
                    }
                }
                // Update tracking for data collection
                (0, arbitrage_1.updateArbTracking)(market.id, arb, prices);
            }
            catch (error) {
                // Silent errors
            }
        }
        // Update stats
        (0, arb_logger_1.incrementScanCount)(pricesChecked);
        (0, server_1.updateStats)({
            scanCount: this.scanCount,
            lastScan: new Date().toISOString(),
        });
        // Only log every 20th scan or if arb found
        if (arbsThisCycle > 0 || this.scanCount % 20 === 0) {
            if (bestCombined < 999) {
                const gap = ((bestCombined - 1.0) * 100).toFixed(2);
                log(`Scan #${this.scanCount}: Best $${bestCombined.toFixed(4)} (${gap}%)`);
            }
        }
    }
    /**
     * Generate session report
     */
    generateSessionReport() {
        const duration = (Date.now() - this.startTime) / (1000 * 60 * 60);
        const stats = (0, arb_logger_1.getScanStats)();
        const execStats = (0, trader_1.getExecutionStats)();
        const lines = [
            '═══════════════════════════════════════════════════════════',
            '         BTC UP/DOWN ARBITRAGE REPORT',
            '         LIVE TRADING',
            '═══════════════════════════════════════════════════════════',
            '',
            `Runtime: ${duration.toFixed(2)} hours`,
            `Total scans: ${stats.total_scans}`,
            `Arbs found: ${stats.arbs_found}`,
            '',
            '───────────────────────────────────────────────────────────',
            'EXECUTION',
            '───────────────────────────────────────────────────────────',
            `Total trades: ${execStats.total_trades}`,
            `Successful: ${execStats.successful_trades}`,
            `Failed: ${execStats.failed_trades}`,
            `Total cost: $${execStats.total_cost.toFixed(2)}`,
            `Pending payout: $${execStats.pending_payout.toFixed(2)}`,
            `Locked profit: $${execStats.total_profit.toFixed(2)}`,
            '',
            '═══════════════════════════════════════════════════════════',
        ];
        return lines.join('\n');
    }
    /**
     * Stop the bot
     */
    async stop() {
        log('Stopping bot...');
        this.isRunning = false;
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
        // Print final report
        const report = this.generateSessionReport();
        console.log('\n' + report);
        log('Bot stopped.');
    }
}
// Main entry point
async function main() {
    // Start dashboard server
    const port = parseInt(process.env.PORT || '3000', 10);
    (0, server_1.startDashboardServer)(port);
    console.log('');
    log('═'.repeat(50));
    log('   BTC UP/DOWN 15-MIN ARBITRAGE BOT');
    log(`   LIVE TRADING - $${TRADE_SIZE_USD} per trade`);
    log('═'.repeat(50));
    (0, server_1.updateStats)({ status: 'initializing' });
    const bot = new BTCUpDownArbBot();
    // Initialize
    const initialized = await bot.initialize();
    if (!initialized) {
        log('ERROR: Failed to initialize bot');
        (0, server_1.updateStats)({ status: 'stopped' });
        process.exit(1);
    }
    // Handle graceful shutdown
    const shutdown = async (signal) => {
        log(`Received ${signal}, shutting down...`);
        (0, server_1.updateStats)({ status: 'stopped' });
        await bot.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // Start
    await bot.start();
}
// Run
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map