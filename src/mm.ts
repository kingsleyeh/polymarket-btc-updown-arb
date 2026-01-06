/**
 * MARKET MAKER - Multi-Market
 * 
 * Watches and trades BOTH markets simultaneously:
 *   - LIVE (≤15 min to expiry): 3% edge
 *   - PREMARKET (15-30 min to expiry): 2% edge
 * 
 * Run with: npm run mm
 */

import * as dotenv from 'dotenv';
import { 
  initializeMarketMaker, 
  addMarket,
  removeExpiredMarkets,
  runMarketMakerLoop,
  getActiveMarkets,
  stopMarketMaker,
  printStats
} from './execution/market-maker';
import { scanMarketsWithStrategy, CategorizedMarket } from './crypto/scanner';
import { connectOrderBookWebSocket, disconnectOrderBookWebSocket } from './execution/orderbook-ws';

dotenv.config();

let isRunning = true;

async function scanAndAddMarkets(): Promise<void> {
  try {
    const markets = await scanMarketsWithStrategy();
    const activeMarkets = getActiveMarkets();
    
    for (const market of markets) {
      // Don't add if already tracking
      if (activeMarkets.has(market.id)) continue;
      
      // Don't add if we're already holding a position in this strategy type
      let hasHoldingInStrategy = false;
      for (const state of activeMarkets.values()) {
        if (state.strategy === market.strategy && state.status === 'HOLDING') {
          hasHoldingInStrategy = true;
          break;
        }
      }
      
      if (!hasHoldingInStrategy) {
        await addMarket(market);
      }
    }
  } catch (error: any) {
    console.log(`   ⚠️ Scan error: ${error.message}`);
  }
}

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('   BTC UP/DOWN MARKET MAKER - Multi-Market');
  console.log('='.repeat(70));
  console.log('\nWatches BOTH markets simultaneously:');
  console.log('   📈 LIVE (≤15 min to expiry): Target 3% edge');
  console.log('   📊 PREMARKET (15-30 min to expiry): Target 2% edge');
  console.log('\nFilters:');
  console.log('   ⚠️ Skip if UP or DOWN >= 80¢ (high volatility)');
  console.log('\nBehavior:');
  console.log('   ✅ Trade both markets in parallel');
  console.log('   ✅ Hold positions until expiry');
  console.log('   ✅ Continuously scan for new markets');
  console.log('='.repeat(70) + '\n');

  // Initialize
  const initialized = await initializeMarketMaker();
  if (!initialized) {
    console.error('Failed to initialize');
    process.exit(1);
  }

  // Connect WebSocket
  await connectOrderBookWebSocket();

  // Handle shutdown
  const shutdown = () => {
    console.log('\n\nShutting down...');
    isRunning = false;
    stopMarketMaker();
    disconnectOrderBookWebSocket();
    printStats();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('🔍 Starting multi-market mode...\n');

  // Initial scan
  await scanAndAddMarkets();

  // Wait for order book data
  console.log('   ⏳ Waiting for order book data...');
  await new Promise(r => setTimeout(r, 3000));

  // Start market maker loop in background
  const loopPromise = runMarketMakerLoop();

  // Periodically scan for new markets
  while (isRunning) {
    await new Promise(r => setTimeout(r, 15000)); // Scan every 15s
    
    if (!isRunning) break;
    
    console.log(`\n[${new Date().toISOString()}] Scanning for markets...`);
    await scanAndAddMarkets();
    removeExpiredMarkets();
    
    // Log active markets
    const active = getActiveMarkets();
    if (active.size > 0) {
      console.log(`   Active markets: ${active.size}`);
      for (const state of active.values()) {
        const timeLeft = Math.round((state.expiryTimestamp - Date.now()) / 60000);
        console.log(`   - [${state.strategy}] ${state.status} | ${timeLeft}m left | ${state.upPosition} UP, ${state.downPosition} DOWN`);
      }
    }
  }

  await loopPromise;
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
