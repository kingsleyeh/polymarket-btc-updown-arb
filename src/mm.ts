/**
 * MARKET MAKER ENTRY POINT - Dual Strategy
 * 
 * Continuously monitors two markets:
 *   - LIVE (≤15 min to expiry): 3% edge target
 *   - PREMARKET (15-30 min to expiry): 2% edge target
 * 
 * Run with: npm run mm
 */

import * as dotenv from 'dotenv';
import { 
  initializeMarketMaker, 
  startMarketMakerForMarket, 
  stopMarketMaker,
  getMarketState,
  isHolding,
  printStats
} from './execution/market-maker';
import { scanMarketsWithStrategy, CategorizedMarket } from './crypto/scanner';
import { connectOrderBookWebSocket, disconnectOrderBookWebSocket } from './execution/orderbook-ws';

dotenv.config();

// Track active markets
interface ActiveMarket {
  market: CategorizedMarket;
  status: 'WATCHING' | 'TRADING' | 'HOLDING' | 'EXPIRED';
}

const activeMarkets: Map<string, ActiveMarket> = new Map();
let isRunning = true;

async function scanAndUpdateMarkets(): Promise<CategorizedMarket[]> {
  try {
    const markets = await scanMarketsWithStrategy();
    return markets;
  } catch (error: any) {
    console.log(`   ⚠️ Market scan error: ${error.message}`);
    return [];
  }
}

function formatTimeToExpiry(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
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

  console.log('🔍 Starting continuous market scan...\n');

  // Main loop - continuously scan and trade
  while (isRunning) {
    try {
      const now = Date.now();
      
      // Scan for markets
      const markets = await scanAndUpdateMarkets();
      
      if (markets.length === 0) {
        console.log(`[${new Date().toISOString()}] No markets found (waiting for 15-30 min window)`);
        await new Promise(r => setTimeout(r, 10000)); // Wait 10s before next scan
        continue;
      }

      // Process each market
      for (const market of markets) {
        const timeToExpiry = market.expiry_timestamp - now;
        const marketKey = market.id;
        
        // Skip if market expired or too close
        if (timeToExpiry <= 60000) { // Less than 1 minute
          activeMarkets.delete(marketKey);
          continue;
        }

        // Check if we're already tracking this market
        const existing = activeMarkets.get(marketKey);
        
        if (existing) {
          // Already tracking - check status
          if (existing.status === 'HOLDING') {
            // Still holding, wait for expiry
            if (timeToExpiry <= 0) {
              console.log(`   ✅ Market expired - position settled`);
              activeMarkets.delete(marketKey);
            }
            continue;
          }
          
          if (existing.status === 'TRADING') {
            // Check if trade completed
            const state = getMarketState();
            if (state && state.status === 'HOLDING') {
              existing.status = 'HOLDING';
              console.log(`   📦 Now holding position in ${market.question.slice(0, 40)}...`);
            }
            continue; // Don't start new trade while one is active
          }
        }

        // Check if we're already trading any market
        const state = getMarketState();
        if (state && (state.status === 'QUOTING' || state.status === 'AGGRESSIVE_COMPLETE' || state.status === 'ONE_SIDED_UP' || state.status === 'ONE_SIDED_DOWN')) {
          // Already actively trading, don't start another
          continue;
        }

        // Check if we're holding a position in any market
        if (state && state.status === 'HOLDING') {
          // We're holding - don't trade until expiry
          continue;
        }

        // New market or not yet trading - start trading
        console.log(`\n[${new Date().toISOString()}] Found ${market.strategy} market:`);
        console.log(`   ${market.question}`);
        console.log(`   Time to expiry: ${formatTimeToExpiry(timeToExpiry)}`);
        
        activeMarkets.set(marketKey, {
          market,
          status: 'TRADING',
        });

        // Start trading this market (non-blocking - runs in background)
        startMarketMakerForMarket(market).then(() => {
          const m = activeMarkets.get(marketKey);
          if (m) {
            const finalState = getMarketState();
            if (finalState && finalState.status === 'HOLDING') {
              m.status = 'HOLDING';
            } else {
              m.status = 'EXPIRED';
            }
          }
        }).catch((error) => {
          console.error(`Error in market maker: ${error.message}`);
          activeMarkets.delete(marketKey);
        });

        // Only trade one market at a time
        break;
      }

      // Brief pause between scans
      await new Promise(r => setTimeout(r, 5000));
      
    } catch (error: any) {
      console.error(`Main loop error: ${error.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
