/**
 * ORDER BOOK AWARE EXECUTION with WebSocket
 * 
 * 1. Real-time order book via WebSocket (no fetch latency)
 * 2. Place orders at actual ask (instant fill)
 * 3. Fast polling (500ms) with early exit
 * 
 * No blind buffers - we know exactly what we're paying
 */

import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { ArbitrageOpportunity } from '../types/arbitrage';
import { 
  connectOrderBookWebSocket, 
  subscribeToTokens, 
  getPriceForShares,
  hasFreshCache,
  disconnectOrderBookWebSocket 
} from './orderbook-ws';

const MIN_SHARES = 5;
const POLL_INTERVAL_MS = 500;  // Fast polling
const MAX_WAIT_MS = 4000;      // Max wait for fills
const SETTLE_WAIT_MS = 2000;   // MUST wait for blockchain to update positions

const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';

let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;
let cachedBalance: number = 0;

const completedMarkets: Set<string> = new Set();
const blockedMarkets: Set<string> = new Set();

interface ExecutedTrade {
  id: string;
  market_id: string;
  shares: number;
  cost: number;
  status: 'filled' | 'failed';
  has_exposure: boolean;
  can_retry: boolean;
  error?: string;
}

const executedTrades: ExecutedTrade[] = [];

export function canTradeMarket(marketId: string): boolean {
  return !completedMarkets.has(marketId) && !blockedMarkets.has(marketId);
}

export async function initializeTrader(): Promise<boolean> {
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
    cachedBalance = parseFloat(balance.balance || '0') / 1_000_000;
    console.log(`Balance: $${cachedBalance.toFixed(2)} USDC`);

    // Connect WebSocket for real-time order books
    await connectOrderBookWebSocket();

    return true;
  } catch (error: any) {
    console.error('Init failed:', error.message);
    return false;
  }
}

/**
 * Subscribe to order book updates for market tokens
 */
export function subscribeToMarketOrderBooks(upTokenId: string, downTokenId: string): void {
  subscribeToTokens([upTokenId, downTokenId]);
}

/**
 * Fallback: Fetch order book via REST if WebSocket cache is stale
 */
async function getOrderBookAskREST(tokenId: string, sharesNeeded: number, label: string): Promise<{price: number, available: number} | null> {
  if (!clobClient) return null;
  
  try {
    const book = await clobClient.getOrderBook(tokenId);
    
    if (!book || !book.asks || book.asks.length === 0) {
      console.log(`   ⚠️ ${label}: No asks in order book`);
      return null;
    }
    
    // Sort asks ascending (best/lowest first)
    const sortedAsks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    
    let sharesAccum = 0;
    let worstPriceNeeded = 0;
    
    for (const ask of sortedAsks) {
      const askPrice = parseFloat(ask.price);
      const askSize = parseFloat(ask.size);
      
      sharesAccum += askSize;
      worstPriceNeeded = askPrice;
      
      if (sharesAccum >= sharesNeeded) {
        console.log(`   📖 ${label}: $${worstPriceNeeded.toFixed(3)} (REST fallback)`);
        return { price: worstPriceNeeded, available: sharesAccum };
      }
    }
    
    return { price: worstPriceNeeded, available: sharesAccum };
  } catch (error: any) {
    console.log(`   ❌ ${label} order book error: ${error.message}`);
    return null;
  }
}

async function getPosition(tokenId: string): Promise<number> {
  if (!clobClient) return 0;
  try {
    const bal = await clobClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Math.floor(parseFloat(bal.balance || '0') / 1_000_000);
  } catch {
    return 0;
  }
}

async function getBothPositions(upTokenId: string, downTokenId: string): Promise<{up: number, down: number}> {
  const [up, down] = await Promise.all([
    getPosition(upTokenId),
    getPosition(downTokenId)
  ]);
  return { up, down };
}

async function cancelAllOrders(): Promise<void> {
  if (!clobClient) return;
  try {
    const openOrders = await clobClient.getOpenOrders();
    if (openOrders && openOrders.length > 0) {
      console.log(`   🧹 Cancelling ${openOrders.length} orders...`);
      await clobClient.cancelAll();
    }
  } catch {}
}

/**
 * Place a LIMIT order at specified price
 */
async function placeLimitBuy(tokenId: string, shares: number, price: number, label: string): Promise<string | null> {
  if (!clobClient) return null;
  
  console.log(`   📥 ${label}: BUY ${shares} @ $${price.toFixed(3)}`);
  
  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      size: shares,
      side: Side.BUY,
    });
    
    const result = await clobClient.postOrder(order, OrderType.GTC);
    
    if (result && result.orderID) {
      return result.orderID;
    }
    
    console.log(`   ❌ ${label}: Failed to place`);
    return null;
  } catch (error: any) {
    const errMsg = error?.data?.error || error?.message || 'Unknown';
    console.log(`   ❌ ${label}: ${errMsg}`);
    return null;
  }
}

/**
 * Fast polling - wait until both positions reach target OR timeout
 */
async function waitForBothPositions(
  upTokenId: string, 
  downTokenId: string, 
  targetShares: number
): Promise<{up: number, down: number, timeMs: number}> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < MAX_WAIT_MS) {
    const pos = await getBothPositions(upTokenId, downTokenId);
    
    // Early exit if both sides have target shares
    if (pos.up >= targetShares && pos.down >= targetShares) {
      return { ...pos, timeMs: Date.now() - startTime };
    }
    
    // Early exit if both sides have SOME shares
    if (pos.up > 0 && pos.down > 0) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const pos2 = await getBothPositions(upTokenId, downTokenId);
      return { ...pos2, timeMs: Date.now() - startTime };
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  
  const finalPos = await getBothPositions(upTokenId, downTokenId);
  return { ...finalPos, timeMs: Date.now() - startTime };
}

/**
 * MARKET SELL - fast
 */
async function sellPosition(tokenId: string, shares: number, label: string): Promise<boolean> {
  if (!clobClient || shares <= 0) return true;
  
  console.log(`   📤 ${label}: SELL ${shares}`);
  
  await new Promise(r => setTimeout(r, SETTLE_WAIT_MS));
  
  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: 0.01,
      size: shares,
      side: Side.SELL,
    });
    
    const result = await clobClient.postOrder(order, OrderType.GTC);
    
    if (result && result.orderID) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS * 2));
      const remaining = await getPosition(tokenId);
      return remaining < shares;
    }
    return false;
  } catch (error: any) {
    console.log(`   ❌ ${label}: ${error.message}`);
    return false;
  }
}

/**
 * MAIN EXECUTION - Order Book Aware with WebSocket
 */
export async function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null> {
  if (!clobClient || !wallet) return null;
  if (completedMarkets.has(arb.market_id) || blockedMarkets.has(arb.market_id)) return null;

  const startTime = Date.now();
  
  const trade: ExecutedTrade = {
    id: `trade-${Date.now()}`,
    market_id: arb.market_id,
    shares: 0,
    cost: 0,
    status: 'failed',
    has_exposure: false,
    can_retry: true,
  };

  await cancelAllOrders();
  
  // Check starting positions
  const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
  
  if (startPos.up > 0 || startPos.down > 0) {
    console.log(`   ⚠️ Existing: ${startPos.up} UP, ${startPos.down} DOWN`);
    
    if (startPos.up === startPos.down && startPos.up >= MIN_SHARES) {
      console.log(`   ✅ Already balanced!`);
      completedMarkets.add(arb.market_id);
      trade.status = 'filled';
      trade.shares = startPos.up;
      trade.can_retry = false;
      executedTrades.push(trade);
      return trade;
    }
    
    console.log(`   🔄 Clearing...`);
    if (startPos.up > 0) await sellPosition(arb.up_token_id, startPos.up, 'UP');
    if (startPos.down > 0) await sellPosition(arb.down_token_id, startPos.down, 'DOWN');
    
    const afterClear = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (afterClear.up > 0 || afterClear.down > 0) {
      console.log(`   🚨 Could not clear: ${afterClear.up} UP, ${afterClear.down} DOWN`);
      blockedMarkets.add(arb.market_id);
      trade.has_exposure = true;
      trade.can_retry = false;
      trade.error = 'Could not clear';
      executedTrades.push(trade);
      return trade;
    }
  }

  // USE ARB PRICES DIRECTLY - Scanner already validated from same WebSocket cache
  // No re-checking = no latency = no "arb disappeared"
  const upPrice = arb.up_price;
  const downPrice = arb.down_price;
  const realCost = upPrice + downPrice;
  const realEdge = (1 - realCost) * 100;
  
  const totalCost = realCost * MIN_SHARES;
  console.log(`\n   ⚡ EXECUTING: UP=$${upPrice.toFixed(3)} + DOWN=$${downPrice.toFixed(3)} = $${realCost.toFixed(4)} (${realEdge.toFixed(1)}%)`);
  console.log(`   💰 Total: $${totalCost.toFixed(2)} for ${MIN_SHARES} shares each`);

  const [upOrderId, downOrderId] = await Promise.all([
    placeLimitBuy(arb.up_token_id, MIN_SHARES, upPrice, 'UP'),
    placeLimitBuy(arb.down_token_id, MIN_SHARES, downPrice, 'DOWN')
  ]);

  if (!upOrderId || !downOrderId) {
    console.log(`   ❌ Order placement failed`);
    await cancelAllOrders();
    trade.error = 'Order placement failed';
    trade.can_retry = true;
    executedTrades.push(trade);
    return trade;
  }

  console.log(`   ✓ Orders placed, polling...`);

  // STEP 3: FAST POLLING FOR FILLS
  const fillResult = await waitForBothPositions(arb.up_token_id, arb.down_token_id, MIN_SHARES);
  
  await cancelAllOrders();
  
  // CRITICAL: Wait for blockchain to update, then poll MULTIPLE times
  // The blockchain position can lag behind actual fills
  console.log(`   ⏳ Waiting for blockchain settlement...`);
  
  let finalPos = { up: 0, down: 0 };
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(r => setTimeout(r, SETTLE_WAIT_MS));
    finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    
    // If we see ANY position, we know fills happened
    if (finalPos.up > 0 || finalPos.down > 0) {
      console.log(`   📊 Positions detected (attempt ${attempt}): ${finalPos.up} UP, ${finalPos.down} DOWN`);
      break;
    }
    
    if (attempt < 4) {
      console.log(`   📊 Attempt ${attempt}: 0 UP, 0 DOWN - waiting more...`);
    }
  }
  
  const totalTime = Date.now() - startTime;
  console.log(`\n   📊 FINAL: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms)`);

  // SUCCESS
  if (finalPos.up === finalPos.down && finalPos.up >= MIN_SHARES) {
    const actualCost = realCost * finalPos.up;
    console.log(`   ✅✅ SUCCESS! ${finalPos.up} each @ $${actualCost.toFixed(2)} (${realEdge.toFixed(1)}% edge)`);
    completedMarkets.add(arb.market_id);
    trade.status = 'filled';
    trade.shares = finalPos.up;
    trade.cost = actualCost;
    trade.can_retry = false;
    executedTrades.push(trade);
    return trade;
  }
  
  // NOTHING after multiple checks - truly nothing filled
  if (finalPos.up === 0 && finalPos.down === 0) {
    console.log(`   ⚠️ No fills after ${4} checks - can retry`);
    trade.error = 'No fills';
    trade.can_retry = true;
    executedTrades.push(trade);
    return trade;
  }
  
  // IMBALANCED
  console.log(`   ⚖️ Imbalanced, balancing...`);
  
  const minPos = Math.min(finalPos.up, finalPos.down);
  
  if (minPos > 0) {
    if (finalPos.up > finalPos.down) {
      await sellPosition(arb.up_token_id, finalPos.up - finalPos.down, 'UP');
    } else {
      await sellPosition(arb.down_token_id, finalPos.down - finalPos.up, 'DOWN');
    }
    
    const balancedPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (balancedPos.up === balancedPos.down && balancedPos.up > 0) {
      const actualCost = realCost * balancedPos.up;
      console.log(`   ✅ Balanced! ${balancedPos.up} each @ $${actualCost.toFixed(2)}`);
      completedMarkets.add(arb.market_id);
      trade.status = 'filled';
      trade.shares = balancedPos.up;
      trade.cost = actualCost;
      trade.can_retry = false;
      executedTrades.push(trade);
      return trade;
    }
  }
  
  // ONE-SIDED - reset
  console.log(`   🔄 Resetting...`);
  if (finalPos.up > 0) await sellPosition(arb.up_token_id, finalPos.up, 'UP');
  if (finalPos.down > 0) await sellPosition(arb.down_token_id, finalPos.down, 'DOWN');
  
  const resetPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
  if (resetPos.up === 0 && resetPos.down === 0) {
    console.log(`   ✅ Reset - can retry`);
    trade.error = 'One-sided, reset';
    trade.can_retry = true;
  } else {
    console.log(`   🚨 Could not reset: ${resetPos.up} UP, ${resetPos.down} DOWN`);
    blockedMarkets.add(arb.market_id);
    trade.has_exposure = true;
    trade.can_retry = false;
    trade.error = 'Could not reset';
  }
  
  executedTrades.push(trade);
  return trade;
}

export function getExecutionStats() {
  const filled = executedTrades.filter(t => t.status === 'filled');
  const totalCost = filled.reduce((sum, t) => sum + t.cost, 0);
  const totalShares = filled.reduce((sum, t) => sum + t.shares, 0);
  
  return {
    total_trades: executedTrades.length,
    successful_trades: filled.length,
    failed_trades: executedTrades.length - filled.length,
    total_cost: totalCost,
    total_profit: totalShares - totalCost,
    pending_payout: totalShares,
  };
}

export function isTraderReady(): boolean {
  return clobClient !== null && wallet !== null;
}

export async function getBalance(): Promise<number> {
  return cachedBalance;
}

export function shutdownTrader(): void {
  disconnectOrderBookWebSocket();
}
