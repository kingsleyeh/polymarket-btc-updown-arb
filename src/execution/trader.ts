/**
 * Trade Execution with Smart Retry
 * 
 * RULES:
 * 1. 0 UP, 0 DOWN → can retry (no exposure)
 * 2. X UP = X DOWN → success (done)
 * 3. X UP ≠ Y DOWN → STOP (has exposure, manual fix needed)
 */

import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { ArbitrageOpportunity } from '../types/arbitrage';

// Configuration
const MIN_SHARES = 5;
const MAX_COMBINED_COST = 0.995; // Allow up to 99.5 cents
const FILL_TIMEOUT_MS = 3000;
const POSITION_CHECK_INTERVAL_MS = 200;
const PRICE_BUFFER = 0.03; // 3% above market (enough to fill, still profitable)

// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';

// Client
let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;
let cachedBalance: number = 0;

// Track markets with UNEQUAL exposure - these can NEVER be retried
const marketsWithExposure: Set<string> = new Set();

// Track markets we've successfully completed
const completedMarkets: Set<string> = new Set();

interface ExecutedTrade {
  id: string;
  market_id: string;
  shares: number;
  status: 'filled' | 'failed';
  has_exposure: boolean;
  can_retry: boolean;
  error?: string;
}

const executedTrades: ExecutedTrade[] = [];

/**
 * Check if market can be traded
 * Returns: true if we can attempt, false if blocked
 */
export function canTradeMarket(marketId: string): boolean {
  // Never retry if we have unequal exposure
  if (marketsWithExposure.has(marketId)) {
    return false;
  }
  // Don't retry completed markets
  if (completedMarkets.has(marketId)) {
    return false;
  }
  return true;
}

/**
 * Initialize trader
 */
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

    console.log(`\n📊 Strategy: DOWN first, then UP (sequential)`);
    console.log(`   Retry: YES if 0 exposure, NO if unequal exposure`);

    return true;
  } catch (error: any) {
    console.error('Init failed:', error.message);
    return false;
  }
}

/**
 * Check token position
 */
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

/**
 * Get both positions
 */
async function getBothPositions(upTokenId: string, downTokenId: string): Promise<{up: number, down: number}> {
  const [up, down] = await Promise.all([
    getPosition(upTokenId),
    getPosition(downTokenId)
  ]);
  return { up, down };
}

/**
 * Cancel order (best effort)
 */
async function cancelOrder(orderId: string): Promise<void> {
  if (!clobClient) return;
  try {
    await clobClient.cancelOrder({ orderID: orderId });
  } catch {}
}

/**
 * Sell position to reverse exposure
 * Waits for settlement then market sells
 */
async function sellPosition(tokenId: string, shares: number, label: string): Promise<boolean> {
  if (!clobClient || shares <= 0) return false;
  
  console.log(`   🔄 Waiting 2s for token settlement...`);
  await new Promise(r => setTimeout(r, 2000)); // Wait for settlement
  
  try {
    // Sell at low price to ensure fill (market sell)
    const sellPrice = 0.01; // Very low price = market sell
    
    console.log(`   📤 Selling ${shares} ${label} @ $${sellPrice}...`);
    
    const result = await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: sellPrice,
      size: shares,
      side: Side.SELL,
    }).catch(e => ({ error: e }));
    
    const orderId = result && !('error' in result) ? (result as any).orderID : null;
    
    if (!orderId) {
      const err = (result as any)?.error;
      console.log(`   ❌ Sell failed: ${err?.data?.error || err?.message || 'Unknown'}`);
      return false;
    }
    
    // Wait for sell to fill
    await new Promise(r => setTimeout(r, 1000));
    
    // Check if position is gone
    const remaining = await getPosition(tokenId);
    if (remaining === 0) {
      console.log(`   ✅ Sold all ${label} - back to 0 exposure`);
      return true;
    } else {
      console.log(`   ⚠️ Still have ${remaining} ${label} remaining`);
      return false;
    }
  } catch (error: any) {
    console.log(`   ❌ Sell error: ${error.message}`);
    return false;
  }
}

/**
 * Wait for position to appear
 */
async function waitForPosition(tokenId: string, minShares: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pos = await getPosition(tokenId);
    if (pos >= minShares) return pos;
    await new Promise(r => setTimeout(r, POSITION_CHECK_INTERVAL_MS));
  }
  return await getPosition(tokenId);
}

/**
 * Execute trade - with smart retry logic
 */
export async function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null> {
  if (!clobClient || !wallet) {
    console.error('Not initialized');
    return null;
  }

  // Check if this market is blocked
  if (marketsWithExposure.has(arb.market_id)) {
    console.log(`   ⛔ Market blocked (has unequal exposure)`);
    return null;
  }
  if (completedMarkets.has(arb.market_id)) {
    console.log(`   ⛔ Market already completed`);
    return null;
  }

  const trade: ExecutedTrade = {
    id: `trade-${Date.now()}`,
    market_id: arb.market_id,
    shares: 0,
    status: 'failed',
    has_exposure: false,
    can_retry: true,
  };

  // Check current positions FIRST
  const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
  console.log(`   📊 Current: ${startPos.up} UP, ${startPos.down} DOWN`);
  
  if (startPos.up !== startPos.down) {
    console.log(`   🚨 Already have unequal exposure! Blocking market.`);
    marketsWithExposure.add(arb.market_id);
    trade.has_exposure = true;
    trade.can_retry = false;
    trade.error = `Pre-existing imbalance: ${startPos.up} UP, ${startPos.down} DOWN`;
    executedTrades.push(trade);
    return trade;
  }

  // Calculate prices with buffer
  const downLimit = Math.min(arb.down_price * (1 + PRICE_BUFFER), 0.95);
  const upLimit = Math.min(arb.up_price * (1 + PRICE_BUFFER), 0.95);
  
  if (downLimit + upLimit > MAX_COMBINED_COST) {
    console.log(`   ❌ Prices too high after buffer`);
    trade.error = 'Prices too high';
    trade.can_retry = true; // Prices might improve
    executedTrades.push(trade);
    return trade;
  }

  console.log(`   💵 Limits: DOWN=$${downLimit.toFixed(3)} UP=$${upLimit.toFixed(3)}`);

  try {
    // ===== STEP 1: Place DOWN order =====
    console.log(`\n   📥 STEP 1: Buying ${MIN_SHARES} DOWN @ $${downLimit.toFixed(3)}...`);
    
    const downResult = await clobClient.createAndPostOrder({
      tokenID: arb.down_token_id,
      price: downLimit,
      size: MIN_SHARES,
      side: Side.BUY,
    }).catch(e => ({ error: e }));

    const downOrderId = downResult && !('error' in downResult) ? (downResult as any).orderID : null;
    
    if (!downOrderId) {
      console.log(`   ❌ DOWN order failed to submit`);
      trade.error = 'DOWN order failed';
      trade.can_retry = true; // No order placed, safe to retry
      executedTrades.push(trade);
      return trade;
    }
    console.log(`   ✓ DOWN order placed`);

    // Wait for DOWN to fill
    console.log(`   ⏳ Waiting for DOWN fill...`);
    await waitForPosition(arb.down_token_id, startPos.down + 1, FILL_TIMEOUT_MS);
    
    // Cancel remaining order
    await cancelOrder(downOrderId);
    
    // Check positions after DOWN attempt
    const afterDown = await getBothPositions(arb.up_token_id, arb.down_token_id);
    const newDownShares = afterDown.down - startPos.down;
    
    console.log(`   📊 After DOWN: ${afterDown.up} UP, ${afterDown.down} DOWN (got ${newDownShares} new)`);
    
    if (newDownShares === 0) {
      // No DOWN filled - check if still equal
      if (afterDown.up === afterDown.down) {
        console.log(`   ✓ No fills - safe to retry`);
        trade.error = 'DOWN did not fill';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
      } else {
        // Something weird happened
        console.log(`   🚨 Positions changed unexpectedly!`);
        marketsWithExposure.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.error = `Unexpected: ${afterDown.up} UP, ${afterDown.down} DOWN`;
        executedTrades.push(trade);
        return trade;
      }
    }

    // Got some DOWN - now must get same amount of UP
    console.log(`   ✅ Got ${newDownShares} DOWN - now need ${newDownShares} UP`);

    // ===== STEP 2: Place UP order for EXACT same amount =====
    console.log(`\n   📥 STEP 2: Buying ${newDownShares} UP @ $${upLimit.toFixed(3)}...`);
    
    const upResult = await clobClient.createAndPostOrder({
      tokenID: arb.up_token_id,
      price: upLimit,
      size: newDownShares, // EXACT same as DOWN we got
      side: Side.BUY,
    }).catch(e => ({ error: e }));

    const upOrderId = upResult && !('error' in upResult) ? (upResult as any).orderID : null;
    
    if (!upOrderId) {
      console.log(`   ❌ UP order failed to submit`);
      console.log(`   🚨 Have ${afterDown.down} DOWN, ${afterDown.up} UP - attempting reversal...`);
      
      // Try to sell the DOWN we just bought
      const sold = await sellPosition(arb.down_token_id, newDownShares, 'DOWN');
      
      const checkAfterSell = await getBothPositions(arb.up_token_id, arb.down_token_id);
      if (checkAfterSell.up === checkAfterSell.down) {
        console.log(`   ✅ Reversal successful - back to balanced (can retry)`);
        trade.has_exposure = false;
        trade.can_retry = true;
        trade.error = 'UP failed, reversed DOWN';
        executedTrades.push(trade);
        return trade;
      } else {
        console.log(`   ❌ Reversal failed - manual intervention needed`);
        marketsWithExposure.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.error = `Reversal failed: ${checkAfterSell.up} UP, ${checkAfterSell.down} DOWN`;
        executedTrades.push(trade);
        return trade;
      }
    }
    console.log(`   ✓ UP order placed`);

    // Wait for UP to fill
    console.log(`   ⏳ Waiting for UP fill...`);
    await waitForPosition(arb.up_token_id, startPos.up + newDownShares, FILL_TIMEOUT_MS);
    
    // Cancel remaining
    await cancelOrder(upOrderId);
    
    // Final position check
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    console.log(`\n   📊 FINAL: ${finalPos.up} UP, ${finalPos.down} DOWN`);

    if (finalPos.up === finalPos.down && finalPos.up > startPos.up) {
      // SUCCESS!
      const newShares = finalPos.up - startPos.up;
      console.log(`   ✅✅ SUCCESS! Got ${newShares} of each`);
      completedMarkets.add(arb.market_id);
      trade.status = 'filled';
      trade.shares = newShares;
      trade.has_exposure = false;
      trade.can_retry = false;
      executedTrades.push(trade);
      return trade;
    }

    // Imbalanced - attempt auto-reversal
    console.log(`   🚨 IMBALANCED: ${finalPos.up} UP ≠ ${finalPos.down} DOWN`);
    console.log(`   🔄 Attempting auto-reversal to 0...`);
    
    // Sell everything to get back to 0
    let reversed = true;
    if (finalPos.up > 0) {
      const soldUp = await sellPosition(arb.up_token_id, finalPos.up, 'UP');
      if (!soldUp) reversed = false;
    }
    if (finalPos.down > 0) {
      const soldDown = await sellPosition(arb.down_token_id, finalPos.down, 'DOWN');
      if (!soldDown) reversed = false;
    }
    
    // Check final state
    const afterReversal = await getBothPositions(arb.up_token_id, arb.down_token_id);
    
    if (afterReversal.up === 0 && afterReversal.down === 0) {
      console.log(`   ✅ Reversal successful - back to 0 (can retry)`);
      trade.has_exposure = false;
      trade.can_retry = true;
      trade.error = 'Imbalanced but reversed to 0';
      executedTrades.push(trade);
      return trade;
    } else if (afterReversal.up === afterReversal.down) {
      console.log(`   ✅ Positions balanced: ${afterReversal.up} each (can retry)`);
      trade.has_exposure = false;
      trade.can_retry = true;
      trade.error = 'Balanced after reversal';
      executedTrades.push(trade);
      return trade;
    } else {
      console.log(`   ❌ Reversal failed: ${afterReversal.up} UP, ${afterReversal.down} DOWN`);
      console.log(`   👉 Manual fix on polymarket.com`);
      marketsWithExposure.add(arb.market_id);
      trade.has_exposure = true;
      trade.can_retry = false;
      trade.shares = Math.max(afterReversal.up, afterReversal.down);
      trade.error = `Reversal failed: ${afterReversal.up} UP, ${afterReversal.down} DOWN`;
      executedTrades.push(trade);
      return trade;
    }

  } catch (error: any) {
    console.error(`   ❌ Error: ${error.message}`);
    
    // Check positions
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    
    if (finalPos.up === finalPos.down) {
      trade.can_retry = true;
      trade.error = error.message;
      executedTrades.push(trade);
      return trade;
    }
    
    // Imbalanced - try reversal
    console.log(`   🔄 Error caused imbalance, attempting reversal...`);
    if (finalPos.up > 0) await sellPosition(arb.up_token_id, finalPos.up, 'UP');
    if (finalPos.down > 0) await sellPosition(arb.down_token_id, finalPos.down, 'DOWN');
    
    const afterReversal = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (afterReversal.up === afterReversal.down) {
      trade.can_retry = true;
      trade.error = `Error reversed: ${error.message}`;
    } else {
      marketsWithExposure.add(arb.market_id);
      trade.has_exposure = true;
      trade.can_retry = false;
      trade.error = `Error + reversal failed: ${afterReversal.up} UP, ${afterReversal.down} DOWN`;
    }
    
    executedTrades.push(trade);
    return trade;
  }
}

export function getExecutionStats() {
  const filled = executedTrades.filter(t => t.status === 'filled');
  return {
    total_trades: executedTrades.length,
    successful_trades: filled.length,
    failed_trades: executedTrades.length - filled.length,
    total_cost: 0,
    total_profit: 0,
    pending_payout: 0,
  };
}

export function isTraderReady(): boolean {
  return clobClient !== null && wallet !== null;
}

export async function getBalance(): Promise<number> {
  return cachedBalance;
}
