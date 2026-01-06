/**
 * BTC Up/Down 15-Minute Arbitrage Bot
 * 
 * LIVE TRADING - $5 per trade
 * 
 * Strategy: Buy BOTH Up + Down when combined cost < $0.98
 * Hold to expiry, collect $1 guaranteed
 */

import * as dotenv from 'dotenv';
import { scanBTCUpDownMarkets, getMarketSummary } from './crypto/scanner';
import { fetchMarketPrices, checkArbitrage, updateArbTracking, getActiveArbs } from './crypto/arbitrage';
import { recordClosedArb, createActiveArbEntry, getPersistenceStats } from './crypto/persistence';
import {
  initializeLogFiles,
  logArbitrage,
  incrementScanCount,
  incrementArbCount,
  getScanStats,
  getLoggedArbs,
  resetStats,
} from './crypto/arb-logger';
import { startDashboardServer, pushLog, updateStats } from './dashboard/server';
import { initializeTrader, executeTrade, getExecutionStats, isTraderReady, canTradeMarket } from './execution/trader';
import { UpDownMarket } from './types/arbitrage';
import { SCAN_INTERVAL_MS, MIN_EDGE, EXPIRY_CUTOFF_SECONDS } from './config/constants';

// Load environment variables
dotenv.config();

// Trade size
const TRADE_SIZE_USD = 5;

// Dashboard logging helper
function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  pushLog(message);
}

/**
 * Main bot class
 */
class BTCUpDownArbBot {
  private isRunning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private markets: UpDownMarket[] = [];
  private scanCount: number = 0;
  private startTime: number = Date.now();
  private isExecutingTrade: boolean = false; // GLOBAL LOCK - only one trade at a time

  /**
   * Initialize the bot
   */
  async initialize(): Promise<boolean> {
    log('Initializing BTC Up/Down Arbitrage Bot...');
    
    this.startTime = Date.now();

    // Reset stats for new session
    resetStats();
    initializeLogFiles();

    // Initialize trader with wallet
    log('Connecting to Polymarket...');
    const traderReady = await initializeTrader();
    if (!traderReady) {
      log('ERROR: Failed to initialize trader - check POLYMARKET_PRIVATE_KEY');
      return false;
    }
    log('✓ Wallet connected');

    // Initial market scan
    log('Scanning for BTC Up/Down 15-minute markets...');
    this.markets = await scanBTCUpDownMarkets();

    if (this.markets.length === 0) {
      log('⚠️ No BTC Up/Down markets found - will keep scanning');
    } else {
      const summary = getMarketSummary(this.markets);
      log(`✓ Found ${summary.total} BTC Up/Down markets`);
      log(`  Time to expiry: ${Math.round(summary.avg_time_to_expiry / 60)} minutes`);
      
      updateStats({
        marketsCount: summary.total,
      });
    }

    log(`Mode: LIVE TRADING - $${TRADE_SIZE_USD} per trade`);
    log(`Min edge: ${(MIN_EDGE * 100).toFixed(1)}%`);
    log(`Expiry cutoff: ${EXPIRY_CUTOFF_SECONDS}s`);
    log(`Scan interval: ${SCAN_INTERVAL_MS}ms`);

    return true;
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log('Bot already running');
      return;
    }

    log('🚀 Starting arbitrage scanner...');
    this.isRunning = true;
    
    updateStats({
      status: 'running',
      startTime: this.startTime,
    });

    // Run initial scan
    await this.runScanCycle();

    // Start periodic scanning
    this.scanInterval = setInterval(
      () => this.runScanCycle(),
      SCAN_INTERVAL_MS
    );

    // Refresh markets every 30 seconds
    setInterval(async () => {
      this.markets = await scanBTCUpDownMarkets();
      updateStats({ marketsCount: this.markets.length });
    }, 30 * 1000);

    log('✓ Bot is running - monitoring for arbitrage');
  }

  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    if (!isTraderReady()) {
      return;
    }

    this.scanCount++;
    let pricesChecked = 0;
    let arbsThisCycle = 0;

    // Refresh markets if empty
    if (this.markets.length === 0) {
      if (this.scanCount % 5 === 0) {
        this.markets = await scanBTCUpDownMarkets();
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
      // Skip if market is blocked (has exposure or completed)
      if (!canTradeMarket(market.id)) {
        continue;
      }
      // GLOBAL LOCK: Only one trade execution at a time across ALL scan cycles
      if (this.isExecutingTrade) {
        continue;
      }

      try {
        // Fetch current prices
        const prices = await fetchMarketPrices(market);
        
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
        const arb = checkArbitrage(market, prices);

        if (arb) {
          // DOUBLE CHECK after price fetch (another cycle might have started trading)
          if (!canTradeMarket(market.id)) {
            continue;
          }
          if (this.isExecutingTrade) {
            continue;
          }

          arbsThisCycle++;
          incrementArbCount();

          const profit = (arb.edge * 100).toFixed(2);
          const timeToExpiry = Math.round(arb.time_to_expiry_seconds / 60);
          
          log(`🎯 ARB FOUND! ${market.question}`);
          log(`   Up=$${prices.up_price.toFixed(3)} + Down=$${prices.down_price.toFixed(3)} = $${arb.combined_cost.toFixed(4)}`);
          log(`   Edge: ${profit}% | Expiry in: ${timeToExpiry} minutes`);

          // ACQUIRE GLOBAL LOCK
          this.isExecutingTrade = true;

          // EXECUTE TRADE (market gets locked inside executeTrade)
          const trade = await executeTrade(arb);
          
          // RELEASE GLOBAL LOCK
          this.isExecutingTrade = false;
          
          // Log result
          if (trade) {
            if (trade.status === 'filled') {
              log(`✅ SUCCESS - ${trade.shares} UP = ${trade.shares} DOWN`);
              log(`   💰 Profit locked!`);
            } else if (trade.has_exposure) {
              log(`🚨 EXPOSURE: ${trade.error}`);
              log(`   👉 Go to polymarket.com NOW`);
              log(`   ⛔ Market BLOCKED - no more attempts`);
            } else if (trade.can_retry) {
              log(`⚠️ Trade failed: ${trade.error || 'Unknown'}`);
              log(`   ✓ Can retry on next arb opportunity`);
            } else {
              log(`⚠️ Trade failed: ${trade.error || 'Unknown'}`);
            }
            
            // Update dashboard
            const execStats = getExecutionStats();
            updateStats({
              arbsFound: execStats.total_trades,
              totalProfit: execStats.total_profit,
              totalCost: execStats.total_cost,
              pendingPayout: execStats.pending_payout,
            });
          }
        }

        // Update tracking for data collection
        updateArbTracking(market.id, arb, prices);

      } catch (error: any) {
        // ALWAYS release global lock on error
        this.isExecutingTrade = false;
        // Silent errors
      }
    }

    // Update stats
    incrementScanCount(pricesChecked);
    
    updateStats({
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
  private generateSessionReport(): string {
    const duration = (Date.now() - this.startTime) / (1000 * 60 * 60);
    const stats = getScanStats();
    const execStats = getExecutionStats();

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
  async stop(): Promise<void> {
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
async function main(): Promise<void> {
  // Start dashboard server
  const port = parseInt(process.env.PORT || '3000', 10);
  startDashboardServer(port);
  
  console.log('');
  log('═'.repeat(50));
  log('   BTC UP/DOWN 15-MIN ARBITRAGE BOT');
  log(`   LIVE TRADING - $${TRADE_SIZE_USD} per trade`);
  log('═'.repeat(50));

  updateStats({ status: 'initializing' });

  const bot = new BTCUpDownArbBot();

  // Initialize
  const initialized = await bot.initialize();
  if (!initialized) {
    log('ERROR: Failed to initialize bot');
    updateStats({ status: 'stopped' });
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal}, shutting down...`);
    updateStats({ status: 'stopped' });
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
