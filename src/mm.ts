/**
 * MARKET MAKER ENTRY POINT - Dual Strategy
 * 
 * Runs ONE market at a time:
 *   - LIVE (≤15 min to expiry): 3% edge target
 *   - PREMARKET (15-30 min to expiry): 2% edge target
 * 
 * After completing a trade → hold until expiry → scan for next market
 * 
 * Run with: npm run mm
 */

import * as dotenv from 'dotenv';
import { 
  initializeMarketMaker, 
  startMarketMakerForMarket, 
  stopMarketMaker,
  printStats
} from './execution/market-maker';
import { scanMarketsWithStrategy, CategorizedMarket } from './crypto/scanner';
import { connectOrderBookWebSocket, disconnectOrderBookWebSocket } from './execution/orderbook-ws';

dotenv.config();

let isRunning = true;

function formatTimeToExpiry(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}m ${seconds}s`;
}

async function findBestMarket(): Promise<CategorizedMarket | null> {
  try {
    const markets = await scanMarketsWithStrategy();
    
    if (markets.length === 0) {
      return null;
    }
    
    // Prefer LIVE markets (more urgency), then PREMARKET
    const liveMarket = markets.find(m => m.strategy === 'LIVE');
    if (liveMarket) return liveMarket;
    
    const premarketMarket = markets.find(m => m.strategy === 'PREMARKET');
    if (premarketMarket) return premarketMarket;
    
    return null;
  } catch (error: any) {
    console.log(`   ⚠️ Market scan error: ${error.message}`);
    return null;
  }
}

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('   BTC UP/DOWN MARKET MAKER - Dual Strategy');
  console.log('='.repeat(70));
  console.log('\nStrategies:');
  console.log('   📈 LIVE (≤15 min to expiry): Target 3% edge');
  console.log('   📊 PREMARKET (15-30 min to expiry): Target 2% edge');
  console.log('\nFilters:');
  console.log('   ⚠️ Skip if UP or DOWN >= 80¢ (high volatility)');
  console.log('\nBehavior:');
  console.log('   ✅ One market at a time');
  console.log('   ✅ Hold position until expiry');
  console.log('   ✅ Then scan for next market');
  console.log('='.repeat(70) + '\n');

  // Initialize
  const initialized = await initializeMarketMaker();
  if (!initialized) {
    console.error('Failed to initialize market maker');
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

  console.log('🔍 Starting market scan loop...\n');

  // Main loop - find market, trade it, wait for expiry, repeat
  while (isRunning) {
    try {
      // Find a market to trade
      console.log(`[${new Date().toISOString()}] Scanning for markets...`);
      const market = await findBestMarket();
      
      if (!market) {
        console.log(`   No tradeable markets found. Waiting 30s...`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      
      console.log(`\n[${new Date().toISOString()}] Found ${market.strategy} market:`);
      console.log(`   ${market.question}`);
      console.log(`   Time to expiry: ${formatTimeToExpiry(market.timeToExpirySec)}`);
      console.log(`   UP token: ${market.up_token_id.slice(0, 20)}...`);
      console.log(`   DOWN token: ${market.down_token_id.slice(0, 20)}...`);
      
      // Trade this market (BLOCKING - waits until HOLDING or BLOCKED)
      await startMarketMakerForMarket(market);
      
      // After market maker returns, we're either HOLDING or done
      console.log(`\n[${new Date().toISOString()}] Market maker finished for ${market.question.slice(0, 40)}...`);
      
      // Brief pause before scanning for next market
      console.log(`   Waiting 5s before scanning for next market...`);
      await new Promise(r => setTimeout(r, 5000));
      
    } catch (error: any) {
      console.error(`Main loop error: ${error.message}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
