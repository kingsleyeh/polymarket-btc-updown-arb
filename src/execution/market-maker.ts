/**
 * MARKET MAKER STRATEGY
 * 
 * Two strategies based on market timing:
 * 
 * PREMARKET (15-30 min to expiry):
 *   - Lower volatility, liquidity trickling in
 *   - Target 2% edge
 *   - If one leg fills when market goes live (15 min mark), risk management kicks in
 * 
 * LIVE (≤15 min to expiry):
 *   - Active market
 *   - Target 3% edge
 *   - Standard risk management
 * 
 * Both strategies:
 *   1. Place bids for both UP and DOWN at prices that sum to TARGET_COMBINED
 *   2. Wait for fills
 *   3. If one side fills, aggressively complete the other side if still profitable
 *   4. If completing would be unprofitable, cut loss immediately
 *   5. Once both sides filled, HOLD until expiry - NO MORE TRADING
 * 
 * Volatility filter:
 *   - Skip if UP >= 80¢ OR DOWN >= 80¢
 */

import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { 
  connectOrderBookWebSocket, 
  subscribeToTokens,
  getBestAsk,
  getBestBid,
  disconnectOrderBookWebSocket 
} from './orderbook-ws';
import { scanMarketsWithStrategy, CategorizedMarket, MarketStrategy } from '../crypto/scanner';

// Strategy-specific configuration
const STRATEGY_CONFIG = {
  LIVE: {
    TARGET_COMBINED: 0.97,      // 3% profit target
    MIN_EDGE_TO_QUOTE: 0.02,    // 2% minimum edge
  },
  PREMARKET: {
    TARGET_COMBINED: 0.98,      // 2% profit target
    MIN_EDGE_TO_QUOTE: 0.015,   // 1.5% minimum edge
  },
};

// Shared configuration
const CONFIG = {
  MAX_COMBINED: 1.005,          // Accept up to 0.5% loss to complete (better than cutting)
  SHARES_PER_ORDER: 5,          // Small size for learning
  REQUOTE_INTERVAL_MS: 2000,    // Update quotes every 2s
  POSITION_CHECK_INTERVAL_MS: 500,
  CUT_LOSS_MAX_ATTEMPTS: 3,     // Try selling 3 times before giving up
  VOLATILITY_THRESHOLD: 0.80,   // Skip if UP or DOWN >= 80¢
  MARKET_SCAN_INTERVAL_MS: 10000, // Scan for new markets every 10s
};

const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';

let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;

// Track state per market
interface MarketMakerState {
  marketId: string;
  marketQuestion: string;
  upTokenId: string;
  downTokenId: string;
  upOrderId: string | null;
  downOrderId: string | null;
  upBidPrice: number;
  downBidPrice: number;
  upPosition: number;
  downPosition: number;
  status: 'IDLE' | 'QUOTING' | 'ONE_SIDED_UP' | 'ONE_SIDED_DOWN' | 'COMPLETE' | 'BLOCKED' | 'AGGRESSIVE_COMPLETE' | 'HOLDING';
  aggressiveCompleteOrderId: string | null;
  strategy: MarketStrategy;
  expiryTimestamp: number;
  totalPnL: number;
  tradesCompleted: number;
  tradesCut: number;
}

let state: MarketMakerState | null = null;

// Stats
const stats = {
  quotesPlaced: 0,
  bothSideFills: 0,
  oneSidedFills: 0,
  aggressiveCompletes: 0,
  cutLosses: 0,
  totalProfit: 0,
  totalLoss: 0,
};

export async function initializeMarketMaker(): Promise<boolean> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: POLYMARKET_PRIVATE_KEY not set');
    return false;
  }

  const funder = process.env.POLYMARKET_PROXY_WALLET || '';
  const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);

  try {
    wallet = new ethers.Wallet(privateKey);
    console.log(`Signer: ${wallet.address}`);
    console.log(`Funder: ${funder || 'not set'}`);

    const basicClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await basicClient.createOrDeriveApiKey();
    console.log(`API Key: ${creds.key?.slice(0, 8)}...`);

    clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, signatureType, funder);

    const balance = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balanceUsd = parseFloat(balance.balance || '0') / 1_000_000;
    console.log(`Balance: $${balanceUsd.toFixed(2)} USDC`);

    // Connect WebSocket
    await connectOrderBookWebSocket();

    return true;
  } catch (error: any) {
    console.error('Init failed:', error.message);
    return false;
  }
}

async function getPosition(tokenId: string): Promise<number> {
  if (!clobClient) return 0;
  try {
    const bal = await clobClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    // Balance is returned in smallest unit (like wei), divide by 1e6 to get shares
    const rawBalance = bal.balance || '0';
    const shares = Math.floor(parseFloat(rawBalance) / 1_000_000);
    return shares;
  } catch (error: any) {
    console.log(`   ⚠️ Error reading position for ${tokenId.slice(0, 8)}...: ${error.message}`);
    return 0;
  }
}

async function cancelAllOrders(): Promise<boolean> {
  if (!clobClient) return false;
  try {
    await clobClient.cancelAll();
    // Wait a bit for cancellation to process
    await new Promise(r => setTimeout(r, 500));
    // Verify cancellation
    const orders = await clobClient.getOpenOrders();
    return !orders || orders.length === 0;
  } catch {
    return false;
  }
}

async function placeLimitBuy(tokenId: string, shares: number, price: number): Promise<string | null> {
  if (!clobClient) return null;
  
  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      size: shares,
      side: Side.BUY,
    });
    
    const result = await clobClient.postOrder(order, OrderType.GTC);
    return result?.orderID || null;
  } catch (error: any) {
    return null;
  }
}

async function marketBuy(tokenId: string, shares: number, maxPrice: number): Promise<boolean> {
  if (!clobClient) return false;
  
  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: maxPrice,
      size: shares,
      side: Side.BUY,
    });
    
    const result = await clobClient.postOrder(order, OrderType.GTC);
    return !!result?.orderID;
  } catch {
    return false;
  }
}

async function marketSell(tokenId: string, shares: number): Promise<boolean> {
  if (!clobClient || shares <= 0) return true;
  
  // Get current bid price to sell at market
  const bid = getBestBid(tokenId);
  const sellPrice = bid ? Math.max(0.01, bid.price - 0.01) : 0.01; // Slightly below bid to ensure fill
  
  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: sellPrice,
      size: shares,
      side: Side.SELL,
    });
    
    const result = await clobClient.postOrder(order, OrderType.GTC);
    return !!result?.orderID;
  } catch (error: any) {
    console.log(`   ⚠️ Sell order failed: ${error.message}`);
    return false;
  }
}

function calculateBidPrices(
  upAsk: number, 
  downAsk: number, 
  targetCombined: number = 0.97,
  minEdge: number = 0.02
): { upBid: number; downBid: number } | null {
  // Current combined ask
  const combinedAsk = upAsk + downAsk;
  
  // If combined ask is already below target, we can be more aggressive
  // If combined ask is above 1.0, we need bigger discounts
  
  // Calculate mid prices (assume bid is ~2% below ask)
  const upMid = upAsk * 0.98;
  const downMid = downAsk * 0.98;
  const combinedMid = upMid + downMid;
  
  // How much discount do we need from mid to hit target?
  const discountNeeded = combinedMid - targetCombined;
  
  if (discountNeeded < minEdge) {
    // Not enough potential edge
    return null;
  }
  
  // Split discount proportionally based on current prices
  const upWeight = upMid / combinedMid;
  const downWeight = downMid / combinedMid;
  
  const upBid = Math.max(0.01, upMid - (discountNeeded * upWeight));
  const downBid = Math.max(0.01, downMid - (discountNeeded * downWeight));
  
  // Sanity check
  if (upBid + downBid > targetCombined + 0.01) {
    return null;
  }
  
  return { upBid, downBid };
}

async function handleOneSidedFill(filledSide: 'UP' | 'DOWN', filledPrice: number, filledShares: number): Promise<void> {
  if (!state) return;
  
  const otherSide = filledSide === 'UP' ? 'DOWN' : 'UP';
  const otherTokenId = filledSide === 'UP' ? state.downTokenId : state.upTokenId;
  
  console.log(`\n   ⚠️ ONE-SIDED FILL: ${filledSide} @ $${filledPrice.toFixed(3)}`);
  
  // Get current ask for other side
  const otherAsk = getBestAsk(otherTokenId);
  
  if (!otherAsk) {
    console.log(`   ❌ Cannot get ${otherSide} price - cutting loss`);
    await cutLoss(filledSide, filledShares);
    return;
  }
  
  const wouldPayCombined = filledPrice + otherAsk.price;
  console.log(`   📊 ${otherSide} ask: $${otherAsk.price.toFixed(3)}`);
  console.log(`   📊 Would pay combined: $${wouldPayCombined.toFixed(4)}`);
  
  if (wouldPayCombined <= CONFIG.MAX_COMBINED) {
    // Acceptable to complete (profit or small loss < 0.5%)
    const profitPct = (1 - wouldPayCombined) * 100;
    if (profitPct > 0) {
      console.log(`   ✅ Completing pair (${profitPct.toFixed(2)}% profit)`);
    } else {
      console.log(`   ⚠️ Completing pair (${Math.abs(profitPct).toFixed(2)}% loss - acceptable)`);
    }
    
    // Cancel all orders and verify before placing aggressive complete
    const cancelled = await cancelAllOrders();
    if (!cancelled) {
      console.log(`   ⚠️  Failed to cancel orders before aggressive complete`);
      await new Promise(r => setTimeout(r, 1000));
      const retryCancelled = await cancelAllOrders();
      if (!retryCancelled) {
        console.log(`   ❌ Cannot cancel orders - aborting aggressive complete`);
        await cutLoss(filledSide, filledShares);
        return;
      }
    }
    
    // Place aggressive complete order and track it
    const completeOrderId = await placeLimitBuy(otherTokenId, filledShares, otherAsk.price + 0.01);
    
    if (completeOrderId) {
      console.log(`   📝 Placed ${otherSide} order: ${completeOrderId.slice(0, 8)}...`);
      state.status = 'AGGRESSIVE_COMPLETE';
      state.aggressiveCompleteOrderId = completeOrderId;
      
      // Wait for fill (poll multiple times)
      let filled = false;
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1000));
        
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        
        console.log(`   📊 Positions (check ${i + 1}/5): ${upPos} UP, ${downPos} DOWN`);
        
        if (upPos > 0 && downPos > 0 && Math.abs(upPos - downPos) <= 1) {
          const minShares = Math.min(upPos, downPos);
          const actualProfit = (1 - wouldPayCombined) * minShares;
          console.log(`   ✅✅ COMPLETE! ${minShares} shares each`);
          if (actualProfit > 0) {
            console.log(`   💰 Locked profit: $${actualProfit.toFixed(2)} (${profitPct.toFixed(2)}%)`);
          } else {
            console.log(`   💰 Small loss: $${Math.abs(actualProfit).toFixed(2)} (${Math.abs(profitPct).toFixed(2)}%)`);
          }
          
          await cancelAllOrders(); // Cancel any remaining orders
          stats.aggressiveCompletes++;
          if (actualProfit > 0) {
            stats.totalProfit += actualProfit;
          } else {
            stats.totalLoss += Math.abs(actualProfit);
          }
          state.status = 'COMPLETE';
          state.aggressiveCompleteOrderId = null;
          state.tradesCompleted++;
          state.totalPnL += actualProfit;
          filled = true;
          break;
        }
      }
      
      if (!filled) {
        // Check if order is still open
        const hasOpen = await hasOpenOrders();
        if (hasOpen) {
          console.log(`   ⚠️ Aggressive complete order still open - cancelling and cutting loss`);
          await cancelAllOrders();
        }
        console.log(`   ❌ Aggressive complete didn't fill - cutting loss`);
        state.aggressiveCompleteOrderId = null;
        await cutLoss(filledSide, filledShares);
      }
    } else {
      console.log(`   ❌ Failed to place ${otherSide} order - cutting loss`);
      await cutLoss(filledSide, filledShares);
    }
  } else {
    // Would lose too much (>0.5%) - cut loss
    const wouldLose = (wouldPayCombined - 1) * 100;
    console.log(`   ❌ Would lose ${wouldLose.toFixed(2)}% - cutting loss`);
    await cutLoss(filledSide, filledShares);
  }
}

async function cutLoss(side: 'UP' | 'DOWN', shares: number): Promise<void> {
  if (!state) return;
  
  const tokenId = side === 'UP' ? state.upTokenId : state.downTokenId;
  
  console.log(`   📤 Selling ${shares} ${side} to cut loss`);
  console.log(`   🔍 Token ID: ${tokenId.slice(0, 16)}...`);
  
  await cancelAllOrders();
  await new Promise(r => setTimeout(r, 1000)); // Wait for settlement
  
  // Get current position before selling
  const initialPos = await getPosition(tokenId);
  console.log(`   📊 Current position: ${initialPos} shares (requested to sell: ${shares})`);
  
  // Also check the other side to see full picture
  const otherTokenId = side === 'UP' ? state.downTokenId : state.upTokenId;
  const otherPos = await getPosition(otherTokenId);
  console.log(`   📊 Other side position: ${otherPos} ${side === 'UP' ? 'DOWN' : 'UP'}`);
  
  if (initialPos === 0) {
    console.log(`   ✅ No position to close`);
    stats.cutLosses++;
    state.status = 'IDLE';
    state.tradesCut++;
    return;
  }
  
  // Try selling multiple times if needed
  for (let attempt = 1; attempt <= CONFIG.CUT_LOSS_MAX_ATTEMPTS; attempt++) {
    const currentPos = await getPosition(tokenId);
    if (currentPos === 0) {
      console.log(`   ✅ Position already closed`);
      stats.cutLosses++;
      state.status = 'IDLE';
      state.tradesCut++;
      return;
    }
    
    const sharesToSell = Math.min(currentPos, shares);
    console.log(`   📤 Attempt ${attempt}/${CONFIG.CUT_LOSS_MAX_ATTEMPTS}: Selling ${sharesToSell} shares`);
    
    const success = await marketSell(tokenId, sharesToSell);
    
    if (success) {
      // Wait for fill and check
      await new Promise(r => setTimeout(r, 2000));
      await cancelAllOrders(); // Cancel any remaining orders
      await new Promise(r => setTimeout(r, 1000));
      
      const remaining = await getPosition(tokenId);
      console.log(`   📊 Position after sell: ${remaining} shares`);
      
      if (remaining === 0) {
        const loss = initialPos * 0.02; // Estimate ~2% spread cost
        console.log(`   ✅ Loss cut - position closed (estimated loss: $${loss.toFixed(2)})`);
        stats.cutLosses++;
        stats.totalLoss += loss;
        state.status = 'IDLE';
        state.totalPnL -= loss;
        state.tradesCut++;
        return;
      }
    }
    
    // Wait before retry
    if (attempt < CONFIG.CUT_LOSS_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  // Failed to close position after all attempts
  const finalPos = await getPosition(tokenId);
  console.log(`   ❌ Failed to close position - ${finalPos} shares remaining`);
  console.log(`   ⚠️ Bot will continue but position is stuck`);
  state.status = 'IDLE'; // Don't block, just continue
  state.tradesCut++;
}

async function hasOpenOrders(): Promise<boolean> {
  if (!clobClient) return false;
  try {
    const orders = await clobClient.getOpenOrders();
    return orders && orders.length > 0;
  } catch {
    return false;
  }
}

async function updateQuotes(): Promise<void> {
  if (!state || !clobClient) {
    console.log(`   ⚠️ updateQuotes: No state or client`);
    return;
  }
  // Don't place new quotes if we're holding a completed position
  if (state.status === 'HOLDING') return;
  // Don't place new quotes if we're in the middle of aggressive complete
  if (state.status === 'AGGRESSIVE_COMPLETE') return;
  if (state.status !== 'IDLE' && state.status !== 'QUOTING') {
    console.log(`   ⚠️ updateQuotes: Status is ${state.status}, skipping`);
    return;
  }
  
  // Get current market prices from WebSocket cache
  const upAsk = getBestAsk(state.upTokenId);
  const downAsk = getBestAsk(state.downTokenId);
  
  if (!upAsk || !downAsk) {
    console.log(`   ⚠️ No order book data: UP=${upAsk ? 'yes' : 'NO'}, DOWN=${downAsk ? 'yes' : 'NO'}`);
    return; // No price data yet
  }
  
  // VOLATILITY FILTER: Skip if UP or DOWN >= 80¢
  if (upAsk.price >= CONFIG.VOLATILITY_THRESHOLD || downAsk.price >= CONFIG.VOLATILITY_THRESHOLD) {
    if (state.status === 'QUOTING') {
      console.log(`   ⏸️  High volatility: UP=$${upAsk.price.toFixed(2)}, DOWN=$${downAsk.price.toFixed(2)} - pausing`);
      await cancelAllOrders();
      state.status = 'IDLE';
      state.upOrderId = null;
      state.downOrderId = null;
    } else {
      console.log(`   ⏸️  Volatility skip: UP=$${upAsk.price.toFixed(2)}, DOWN=$${downAsk.price.toFixed(2)}`);
    }
    return; // Skip - too volatile
  }
  
  // Get strategy-specific config
  const strategyConfig = STRATEGY_CONFIG[state.strategy];
  
  // Calculate bid prices using strategy-specific target
  const prices = calculateBidPrices(upAsk.price, downAsk.price, strategyConfig.TARGET_COMBINED, strategyConfig.MIN_EDGE_TO_QUOTE);
  
  if (!prices) {
    console.log(`   ⚠️ No edge: UP ask=$${upAsk.price.toFixed(3)}, DOWN ask=$${downAsk.price.toFixed(3)} (combined $${(upAsk.price + downAsk.price).toFixed(4)})`);
  }
  
  if (!prices) {
    // Not enough edge - cancel existing orders
    if (state.status === 'QUOTING') {
      await cancelAllOrders();
      state.status = 'IDLE';
      state.upOrderId = null;
      state.downOrderId = null;
    }
    return;
  }
  
  // Check if we already have open orders
  const hasOrders = await hasOpenOrders();
  
  // Check if prices changed significantly (>0.5%)
  const priceChanged = 
    state.upBidPrice === 0 || // First time placing
    state.downBidPrice === 0 || // First time placing
    Math.abs(prices.upBid - state.upBidPrice) > 0.005 ||
    Math.abs(prices.downBid - state.downBidPrice) > 0.005;
  
  // Don't place if we're already quoting with same prices and orders exist
  if (state.status === 'QUOTING' && hasOrders && !priceChanged) {
    return; // No need to update
  }
  
  // CRITICAL: Never place new orders if old ones still exist
  if (hasOrders) {
    // Check if these are our orders by checking positions
    const upPos = await getPosition(state.upTokenId);
    const downPos = await getPosition(state.downTokenId);
    
    // If we have positions, we might have filled orders - don't place new ones yet
    if (upPos > 0 || downPos > 0) {
      console.log(`   ⏸️  Waiting: ${upPos} UP, ${downPos} DOWN positions exist`);
      return; // Wait for position handling
    }
    
    // Cancel and VERIFY cancellation before placing new orders
    console.log(`   🧹 Cancelling existing orders...`);
    const cancelled = await cancelAllOrders();
    
    if (!cancelled) {
      // Still have orders - retry cancellation
      console.log(`   ⚠️  Orders still exist, retrying cancellation...`);
      await new Promise(r => setTimeout(r, 1000));
      const retryCancelled = await cancelAllOrders();
      
      if (!retryCancelled) {
        console.log(`   ❌ Failed to cancel orders - skipping quote update`);
        return; // Don't place new orders if old ones still exist!
      }
    }
    
    // Double-check no orders exist
    const stillHasOrders = await hasOpenOrders();
    if (stillHasOrders) {
      console.log(`   ❌ Orders still exist after cancellation - aborting`);
      return;
    }
    
    console.log(`   ✅ All orders cancelled`);
  }
  
  console.log(`\n   📊 Market: UP ask=$${upAsk.price.toFixed(3)}, DOWN ask=$${downAsk.price.toFixed(3)} (combined $${(upAsk.price + downAsk.price).toFixed(4)})`);
  console.log(`   📝 Quoting: UP bid=$${prices.upBid.toFixed(3)}, DOWN bid=$${prices.downBid.toFixed(3)} (target $${strategyConfig.TARGET_COMBINED})`);
  
  const [upOrderId, downOrderId] = await Promise.all([
    placeLimitBuy(state.upTokenId, CONFIG.SHARES_PER_ORDER, prices.upBid),
    placeLimitBuy(state.downTokenId, CONFIG.SHARES_PER_ORDER, prices.downBid),
  ]);
  
  if (upOrderId && downOrderId) {
    // Verify we only have 2 orders (the ones we just placed)
    await new Promise(r => setTimeout(r, 500)); // Brief wait for orders to register
    const orderList = await clobClient!.getOpenOrders();
    const orderCount = orderList?.length || 0;
    
    if (orderCount > 2) {
      console.log(`   ⚠️  WARNING: ${orderCount} orders exist (expected 2) - cancelling and retrying`);
      await cancelAllOrders();
      state.status = 'IDLE';
      return; // Don't update state, retry next iteration
    }
    
    state.upOrderId = upOrderId;
    state.downOrderId = downOrderId;
    state.upBidPrice = prices.upBid;
    state.downBidPrice = prices.downBid;
    state.status = 'QUOTING';
    stats.quotesPlaced++;
    console.log(`   ✓ Orders placed (UP: ${upOrderId.slice(0, 8)}..., DOWN: ${downOrderId.slice(0, 8)}...)`);
  } else {
    console.log(`   ❌ Failed to place orders`);
    state.status = 'IDLE';
  }
}

async function checkFills(): Promise<void> {
  if (!state || state.status !== 'QUOTING') return;
  
  const upPos = await getPosition(state.upTokenId);
  const downPos = await getPosition(state.downTokenId);
  
  // Log positions for debugging
  if (upPos > 0 || downPos > 0) {
    console.log(`   📊 Positions: ${upPos} UP, ${downPos} DOWN`);
  }
  
  // Both sides filled
  if (upPos >= CONFIG.SHARES_PER_ORDER && downPos >= CONFIG.SHARES_PER_ORDER) {
    const actualCombined = state.upBidPrice + state.downBidPrice;
    const profit = (1 - actualCombined) * Math.min(upPos, downPos);
    
    console.log(`\n   ✅✅ BOTH SIDES FILLED!`);
    console.log(`   💰 ${upPos} UP + ${downPos} DOWN @ $${actualCombined.toFixed(4)}`);
    console.log(`   💰 Locked profit: $${profit.toFixed(2)} (${((1 - actualCombined) * 100).toFixed(1)}%)`);
    
    await cancelAllOrders();
    stats.bothSideFills++;
    stats.totalProfit += profit;
    state.status = 'COMPLETE';
    state.tradesCompleted++;
    state.totalPnL += profit;
    state.upOrderId = null;
    state.downOrderId = null;
    return;
  }
  
  // One side filled
  if (upPos > 0 && downPos === 0) {
    stats.oneSidedFills++;
    state.status = 'ONE_SIDED_UP';
    state.upPosition = upPos;
    await handleOneSidedFill('UP', state.upBidPrice, upPos);
    return;
  }
  
  if (downPos > 0 && upPos === 0) {
    stats.oneSidedFills++;
    state.status = 'ONE_SIDED_DOWN';
    state.downPosition = downPos;
    await handleOneSidedFill('DOWN', state.downBidPrice, downPos);
    return;
  }
}

export async function startMarketMaker(
  market: CategorizedMarket
): Promise<void> {
  if (!clobClient) {
    console.error('Market maker not initialized');
    return;
  }
  
  const strategyConfig = STRATEGY_CONFIG[market.strategy];
  const timeToExpiry = Math.round(market.timeToExpirySec / 60);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`   MARKET MAKER - ${market.strategy} Strategy`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Market: ${market.question}`);
  console.log(`Strategy: ${market.strategy} (${market.strategy === 'LIVE' ? '≤15 min' : '15-30 min'} to expiry)`);
  console.log(`Time to expiry: ${timeToExpiry} minutes`);
  console.log(`Target combined: $${strategyConfig.TARGET_COMBINED} (${((1 - strategyConfig.TARGET_COMBINED) * 100).toFixed(0)}% profit)`);
  console.log(`Shares per order: ${CONFIG.SHARES_PER_ORDER}`);
  console.log(`Volatility filter: Skip if UP or DOWN >= ${(CONFIG.VOLATILITY_THRESHOLD * 100).toFixed(0)}¢`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Subscribe to order book updates
  subscribeToTokens([market.up_token_id, market.down_token_id]);
  
  // Initialize state
  state = {
    marketId: market.id,
    marketQuestion: market.question,
    upTokenId: market.up_token_id,
    downTokenId: market.down_token_id,
    upOrderId: null,
    downOrderId: null,
    upBidPrice: 0,
    downBidPrice: 0,
    upPosition: 0,
    downPosition: 0,
    status: 'IDLE',
    aggressiveCompleteOrderId: null,
    strategy: market.strategy,
    expiryTimestamp: market.expiry_timestamp,
    totalPnL: 0,
    tradesCompleted: 0,
    tradesCut: 0,
  };
  
  // Wait for WebSocket data
  console.log('   ⏳ Waiting for order book data...');
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('   🚀 Starting market maker loop...\n');
  
  // Main loop
  while (state.status !== 'BLOCKED') {
    try {
      if (state.status === 'COMPLETE') {
        // Trade complete - STOP trading and hold until expiry
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        
        console.log(`\n   ✅✅ TRADE COMPLETE - HOLDING POSITION`);
        console.log(`   📊 Holding: ${upPos} UP + ${downPos} DOWN`);
        console.log(`   💰 Waiting for market expiry to collect $${(upPos + downPos).toFixed(2)}`);
        
        // Cancel any remaining orders
        await cancelAllOrders();
        
        // Set to HOLDING - no more trading
        state.status = 'HOLDING';
        state.upPosition = upPos;
        state.downPosition = downPos;
        state.aggressiveCompleteOrderId = null;
      }
      
      // If holding, just wait - NO MORE TRADING
      if (state.status === 'HOLDING') {
        // Check positions periodically to confirm still holding
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        
        if (upPos > 0 && downPos > 0) {
          // Still holding - just wait
          await new Promise(r => setTimeout(r, 10000)); // Check every 10 seconds
          continue;
        } else {
          // Position changed somehow - log and continue holding
          console.log(`   ⚠️  Position changed: ${upPos} UP, ${downPos} DOWN`);
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
      }
      
      // Handle one-sided states (should be handled by handleOneSidedFill, but check anyway)
      if (state.status === 'ONE_SIDED_UP' || state.status === 'ONE_SIDED_DOWN') {
        // Already handled, just wait a bit
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      
      // Don't place new quotes while aggressive complete is pending
      if (state.status === 'AGGRESSIVE_COMPLETE') {
        // Wait for aggressive complete to resolve (handled in handleOneSidedFill)
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      
      // Check if market expired
      const now = Date.now();
      const timeToExpiry = state.expiryTimestamp - now;
      
      if (timeToExpiry <= 60000) { // Less than 1 minute to expiry
        console.log(`\n   ⏰ Market expiring in ${Math.round(timeToExpiry / 1000)}s`);
        
        // If we have a position, keep holding
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        
        if (upPos > 0 && downPos > 0) {
          console.log(`   📦 Holding ${upPos} UP + ${downPos} DOWN until expiry`);
          state.status = 'HOLDING';
          continue;
        }
        
        // No position - exit this market
        if (upPos === 0 && downPos === 0) {
          console.log(`   📤 No position - exiting market`);
          await cancelAllOrders();
          state.status = 'BLOCKED';
          break;
        }
        
        // One-sided position - try to close
        if ((upPos > 0 && downPos === 0) || (downPos > 0 && upPos === 0)) {
          console.log(`   ⚠️ One-sided position at expiry: ${upPos} UP, ${downPos} DOWN`);
          // Let it ride - market will settle
          state.status = 'HOLDING';
          continue;
        }
      }
      
      // Update quotes
      await updateQuotes();
      
      // Check for fills
      if (state.status === 'QUOTING') {
        await new Promise(r => setTimeout(r, CONFIG.POSITION_CHECK_INTERVAL_MS));
        await checkFills();
      }
      
      // Wait before next iteration
      await new Promise(r => setTimeout(r, CONFIG.REQUOTE_INTERVAL_MS));
      
    } catch (error: any) {
      console.error(`Error in market maker loop: ${error.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`   MARKET MAKER STOPPED`);
  console.log(`${'='.repeat(60)}`);
  printStats();
}

export function printStats(): void {
  console.log(`\nStats:`);
  console.log(`  Quotes placed: ${stats.quotesPlaced}`);
  console.log(`  Both-side fills: ${stats.bothSideFills}`);
  console.log(`  One-sided fills: ${stats.oneSidedFills}`);
  console.log(`  Aggressive completes: ${stats.aggressiveCompletes}`);
  console.log(`  Cut losses: ${stats.cutLosses}`);
  console.log(`  Total profit: $${stats.totalProfit.toFixed(2)}`);
  console.log(`  Total loss: $${stats.totalLoss.toFixed(2)}`);
  console.log(`  Net P&L: $${(stats.totalProfit - stats.totalLoss).toFixed(2)}`);
}

export function getMarketState(): MarketMakerState | null {
  return state;
}

export function isHolding(): boolean {
  return state?.status === 'HOLDING';
}

export function stopMarketMaker(): void {
  if (state) {
    state.status = 'BLOCKED';
  }
  cancelAllOrders();
}

// Alias for the new multi-market approach
export async function startMarketMakerForMarket(market: CategorizedMarket): Promise<void> {
  return startMarketMaker(market);
}

