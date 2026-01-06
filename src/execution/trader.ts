/**
 * Real Trade Execution - SEQUENTIAL STRATEGY
 * 
 * NEW APPROACH: DOWN first, then UP
 * - Place DOWN order first (historically harder to fill)
 * - Wait for DOWN to fill
 * - ONLY then place UP order
 * - If DOWN doesn't fill, cancel and retry (no exposure)
 * - If DOWN fills but UP doesn't, we have DOWN exposure (report it)
 */

import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import axios from 'axios';
import { ArbitrageOpportunity } from '../types/arbitrage';

// ============ CONFIGURATION ============
const TRADE_SIZE_PERCENT = 0.10; // 10% of available balance per trade
const MIN_SHARES = 5; // Polymarket requires minimum 5 shares per order
const MAX_LIQUIDITY_PERCENT = 0.30; // Don't take more than 30% of available liquidity
const MAX_COMBINED_COST = 0.99; // Maximum acceptable combined cost (reject if exceeds)
const FILL_TIMEOUT_MS = 2000; // 2 seconds to wait for each order to fill
const POSITION_CHECK_INTERVAL_MS = 100; // Check positions every 100ms
const API_TIMEOUT_MS = 2000; // 2s timeout for API calls

// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';

// Client singleton
let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;
let cachedBalance: number = 0;
let lastBalanceUpdate: number = 0;
const BALANCE_CACHE_MS = 30000; // Cache balance for 30 seconds

// Track executed trades
interface ExecutedTrade {
  id: string;
  market_id: string;
  market_title: string;
  up_order_id: string | null;
  down_order_id: string | null;
  up_price: number;
  down_price: number;
  combined_cost: number;
  shares: number;
  cost_usd: number;
  guaranteed_payout: number;
  profit_usd: number;
  timestamp: number;
  expiry_timestamp: number;
  status: 'pending' | 'filled' | 'partial' | 'failed';
  error?: string;
  orders_placed: boolean;
  reversal_succeeded: boolean;
  has_exposure: boolean;
}

const executedTrades: ExecutedTrade[] = [];

/**
 * Initialize the CLOB client with wallet
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
    console.log(`Signer wallet: ${wallet.address}`);
    console.log(`Funder (profile): ${funder || 'not set'}`);
    console.log(`Signature type: ${signatureType} (${signatureType === 1 ? 'Magic/Email' : 'Browser'})`);

    console.log('Deriving API credentials...');
    const basicClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await basicClient.createOrDeriveApiKey();
    
    console.log(`API Key: ${creds.key?.slice(0, 8)}...`);

    clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      creds,
      signatureType,
      funder
    );

    // Get initial balance
    await updateBalance();
    
    console.log(`\n📊 SIZING CONFIG:`);
    console.log(`   Trade size: ${(TRADE_SIZE_PERCENT * 100).toFixed(0)}% of balance`);
    console.log(`   Minimum shares: ${MIN_SHARES} (Polymarket requirement)`);
    console.log(`   Max liquidity take: ${(MAX_LIQUIDITY_PERCENT * 100).toFixed(0)}%`);
    console.log(`   Strategy: SEQUENTIAL (DOWN first, then UP)`);

    return true;
  } catch (error: any) {
    console.error('Failed to initialize trader:', error.message);
    return false;
  }
}

/**
 * Update cached balance
 */
async function updateBalance(): Promise<number> {
  if (!clobClient) return 0;
  
  try {
    const balance = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    cachedBalance = parseFloat(balance.balance || '0') / 1_000_000;
    lastBalanceUpdate = Date.now();
    console.log(`Balance: $${cachedBalance.toFixed(2)} USDC`);
    return cachedBalance;
  } catch (error: any) {
    console.warn(`Could not fetch balance: ${error.message}`);
    return cachedBalance;
  }
}

/**
 * Get current balance (cached)
 */
export async function getBalance(): Promise<number> {
  if (Date.now() - lastBalanceUpdate > BALANCE_CACHE_MS) {
    return await updateBalance();
  }
  return cachedBalance;
}

/**
 * Check actual positions (token balances)
 */
async function checkPositions(
  upTokenId: string,
  downTokenId: string,
  expectedShares: number
): Promise<{ hasUp: boolean; hasDown: boolean; upBalance: number; downBalance: number }> {
  if (!clobClient) {
    return { hasUp: false, hasDown: false, upBalance: 0, downBalance: 0 };
  }
  
  try {
    const [upBalance, downBalance] = await Promise.all([
      clobClient.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: upTokenId,
      }).catch(() => ({ balance: '0' })),
      clobClient.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: downTokenId,
      }).catch(() => ({ balance: '0' })),
    ]);
    
    const upBal = parseFloat(upBalance.balance || '0') / 1_000_000;
    const downBal = parseFloat(downBalance.balance || '0') / 1_000_000;
    
    // Consider we have a position if balance >= 90% of expected
    const hasUp = upBal >= expectedShares * 0.9;
    const hasDown = downBal >= expectedShares * 0.9;
    
    return { hasUp, hasDown, upBalance: upBal, downBalance: downBal };
  } catch (error: any) {
    return { hasUp: false, hasDown: false, upBalance: 0, downBalance: 0 };
  }
}

/**
 * Cancel an order
 */
async function cancelOrder(orderId: string): Promise<boolean> {
  if (!clobClient) return false;
  
  try {
    await clobClient.cancelOrder({ orderID: orderId });
    return true;
  } catch (error: any) {
    return false;
  }
}

/**
 * Calculate optimal trade size
 */
function calculateTradeSize(
  balance: number,
  combinedCost: number,
  upLiquidity: number,
  downLiquidity: number
): { shares: number; reason: string } {
  let targetUsd = balance * TRADE_SIZE_PERCENT;
  let reason = `${(TRADE_SIZE_PERCENT * 100).toFixed(0)}% of $${balance.toFixed(2)} balance`;

  let shares = Math.floor(targetUsd / combinedCost);
  
  if (shares < MIN_SHARES) {
    const minCost = MIN_SHARES * combinedCost;
    if (minCost > balance) {
      return { shares: 0, reason: `cannot afford minimum ${MIN_SHARES} shares` };
    }
    shares = MIN_SHARES;
    reason = `minimum ${MIN_SHARES} shares`;
  }

  const maxUpShares = Math.floor(upLiquidity * MAX_LIQUIDITY_PERCENT);
  const maxDownShares = Math.floor(downLiquidity * MAX_LIQUIDITY_PERCENT);
  const liquidityLimit = Math.min(maxUpShares, maxDownShares);

  if (shares > liquidityLimit && liquidityLimit >= MIN_SHARES) {
    shares = liquidityLimit;
    reason = `limited by liquidity`;
  }

  if (shares < MIN_SHARES) {
    return { shares: 0, reason: `insufficient liquidity` };
  }

  return { shares, reason };
}

/**
 * Wait for a position to appear (order to fill)
 */
async function waitForPosition(
  tokenId: string,
  otherTokenId: string,
  expectedShares: number,
  timeoutMs: number,
  side: 'UP' | 'DOWN'
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const positions = await checkPositions(
      side === 'UP' ? tokenId : otherTokenId,
      side === 'DOWN' ? tokenId : otherTokenId,
      expectedShares
    );
    
    if (side === 'DOWN' && positions.hasDown) {
      return true;
    }
    if (side === 'UP' && positions.hasUp) {
      return true;
    }
    
    await new Promise(r => setTimeout(r, POSITION_CHECK_INTERVAL_MS));
  }
  
  return false;
}

/**
 * Execute arbitrage trade - SEQUENTIAL: DOWN first, then UP
 */
export async function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null> {
  if (!clobClient || !wallet) {
    console.error('Trader not initialized');
    return null;
  }

  const now = Date.now();
  const upPrice = arb.up_price;
  const downPrice = arb.down_price;
  const combinedCost = arb.combined_cost;

  console.log(`\n💰 EXECUTING: UP=$${upPrice.toFixed(3)} DOWN=$${downPrice.toFixed(3)} = $${combinedCost.toFixed(4)}`);
  console.log(`   Liquidity: UP=${arb.up_shares_available.toFixed(0)} DOWN=${arb.down_shares_available.toFixed(0)}`);

  if (combinedCost > MAX_COMBINED_COST) {
    console.log(`   ❌ Combined cost exceeds max - rejecting`);
    return null;
  }

  const balance = await getBalance();
  const { shares, reason } = calculateTradeSize(
    balance,
    combinedCost,
    arb.up_shares_available,
    arb.down_shares_available
  );

  if (shares < 1) {
    console.log(`   ❌ Cannot trade: ${reason}`);
    return null;
  }

  const costUsd = shares * combinedCost;
  const profitUsd = shares * (1.0 - combinedCost);

  console.log(`   ✓ Size: ${shares} shares (${reason})`);
  console.log(`   Cost: $${costUsd.toFixed(2)} | Profit: $${profitUsd.toFixed(2)}`);

  const trade: ExecutedTrade = {
    id: `trade-${now}`,
    market_id: arb.market_id,
    market_title: arb.market_title,
    up_order_id: null,
    down_order_id: null,
    up_price: upPrice,
    down_price: downPrice,
    combined_cost: combinedCost,
    shares,
    cost_usd: costUsd,
    guaranteed_payout: shares * 1.0,
    profit_usd: profitUsd,
    timestamp: now,
    expiry_timestamp: arb.expiry_timestamp,
    status: 'pending',
    orders_placed: false,
    reversal_succeeded: false,
    has_exposure: false,
  };

  // Calculate limit prices with buffer
  const room = MAX_COMBINED_COST - combinedCost;
  const bufferPerToken = Math.min(room / 2, 0.05);
  
  let upLimitPrice = Math.min(upPrice + bufferPerToken, 0.95);
  let downLimitPrice = Math.min(downPrice + bufferPerToken, 0.95);

  console.log(`   Limits: UP=$${upLimitPrice.toFixed(3)} DOWN=$${downLimitPrice.toFixed(3)}`);

  try {
    // ========== STEP 1: Place DOWN order first ==========
    console.log(`\n   🎯 STEP 1: Placing DOWN order...`);
    
    const downResult = await clobClient.createAndPostOrder({
      tokenID: arb.down_token_id,
      price: downLimitPrice,
      size: shares,
      side: Side.BUY,
    }).catch(err => ({ error: err }));
    
    const downOrderId = downResult && !('error' in downResult) ? (downResult as any).orderID : null;
    
    if (!downOrderId) {
      const err = (downResult as any).error;
      const errMsg = err?.data?.error || err?.message || 'Unknown';
      console.log(`   ❌ DOWN order failed: ${errMsg}`);
      trade.status = 'failed';
      trade.error = `DOWN order failed: ${errMsg}`;
      executedTrades.push(trade);
      return trade;
    }
    
    trade.down_order_id = downOrderId;
    trade.orders_placed = true;
    console.log(`   ✓ DOWN order: ${downOrderId.slice(0, 16)}...`);
    
    // ========== STEP 2: Wait for DOWN to fill ==========
    console.log(`   ⏳ Waiting for DOWN to fill...`);
    
    const downFilled = await waitForPosition(
      arb.down_token_id,
      arb.up_token_id,
      shares,
      FILL_TIMEOUT_MS,
      'DOWN'
    );
    
    if (!downFilled) {
      // DOWN didn't fill - cancel and exit (SAFE - no exposure)
      console.log(`   ⏱️ DOWN didn't fill - cancelling...`);
      await cancelOrder(downOrderId);
      
      // Verify we don't have the position
      const check = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
      if (check.hasDown) {
        // DOWN actually filled after timeout but before cancel!
        console.log(`   ⚠️ DOWN filled just before cancel!`);
        // Continue to place UP order
      } else {
        console.log(`   ✓ DOWN cancelled - no exposure (safe to retry)`);
        trade.status = 'failed';
        trade.has_exposure = false;
        trade.error = 'DOWN did not fill - cancelled';
        executedTrades.push(trade);
        return trade;
      }
    }
    
    console.log(`   ✅ DOWN FILLED!`);
    
    // ========== STEP 3: Place UP order ==========
    console.log(`   🎯 STEP 2: Placing UP order...`);
    
    const upResult = await clobClient.createAndPostOrder({
      tokenID: arb.up_token_id,
      price: upLimitPrice,
      size: shares,
      side: Side.BUY,
    }).catch(err => ({ error: err }));
    
    const upOrderId = upResult && !('error' in upResult) ? (upResult as any).orderID : null;
    
    if (!upOrderId) {
      const err = (upResult as any).error;
      const errMsg = err?.data?.error || err?.message || 'Unknown';
      console.log(`   ❌ UP order failed: ${errMsg}`);
      console.log(`   🚨 EXPOSURE: Have ${shares} DOWN, no UP!`);
      console.log(`   👉 MANUAL: Sell DOWN on polymarket.com`);
      trade.up_order_id = null;
      trade.status = 'failed';
      trade.has_exposure = true;
      trade.error = `Have DOWN but UP failed - sell DOWN manually`;
      executedTrades.push(trade);
      return trade;
    }
    
    trade.up_order_id = upOrderId;
    console.log(`   ✓ UP order: ${upOrderId.slice(0, 16)}...`);
    
    // ========== STEP 4: Wait for UP to fill ==========
    console.log(`   ⏳ Waiting for UP to fill...`);
    
    const upFilled = await waitForPosition(
      arb.up_token_id,
      arb.down_token_id,
      shares,
      FILL_TIMEOUT_MS,
      'UP'
    );
    
    // Final check
    const finalCheck = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
    
    if (finalCheck.hasUp && finalCheck.hasDown) {
      // SUCCESS!
      console.log(`   ✅✅ BOTH FILLED - ARBITRAGE COMPLETE!`);
      console.log(`   💰 Locked profit: $${profitUsd.toFixed(2)}`);
      trade.status = 'filled';
      trade.has_exposure = false;
      cachedBalance -= costUsd;
      executedTrades.push(trade);
      return trade;
    }
    
    if (finalCheck.hasDown && !finalCheck.hasUp) {
      // Have DOWN but not UP
      console.log(`   ⚠️ UP didn't fill - cancelling...`);
      await cancelOrder(upOrderId);
      
      // Check again
      const recheck = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
      if (recheck.hasUp && recheck.hasDown) {
        console.log(`   ✅ UP filled just before cancel - SUCCESS!`);
        trade.status = 'filled';
        trade.has_exposure = false;
        executedTrades.push(trade);
        return trade;
      }
      
      console.log(`   🚨 EXPOSURE: Have ${recheck.downBalance.toFixed(0)} DOWN, ${recheck.upBalance.toFixed(0)} UP`);
      console.log(`   👉 MANUAL: Balance positions on polymarket.com`);
      trade.status = 'failed';
      trade.has_exposure = true;
      trade.error = `Imbalanced: ${recheck.downBalance.toFixed(0)} DOWN, ${recheck.upBalance.toFixed(0)} UP`;
      executedTrades.push(trade);
      return trade;
    }
    
    // Unexpected state
    console.log(`   ⚠️ Unexpected: UP=${finalCheck.upBalance} DOWN=${finalCheck.downBalance}`);
    trade.status = 'failed';
    trade.has_exposure = finalCheck.hasUp || finalCheck.hasDown;
    trade.error = `Unexpected state`;
    executedTrades.push(trade);
    return trade;

  } catch (error: any) {
    console.error(`   ❌ ERROR: ${error.message}`);
    trade.status = 'failed';
    trade.error = error.message;
    executedTrades.push(trade);
    return trade;
  }
}

/**
 * Get all executed trades
 */
export function getExecutedTrades(): ExecutedTrade[] {
  return [...executedTrades];
}

/**
 * Get execution stats
 */
export function getExecutionStats(): {
  total_trades: number;
  successful_trades: number;
  failed_trades: number;
  total_cost: number;
  total_profit: number;
  pending_payout: number;
} {
  let successful = 0;
  let failed = 0;
  let totalCost = 0;
  let totalProfit = 0;
  let pendingPayout = 0;

  for (const trade of executedTrades) {
    if (trade.status === 'filled') {
      successful++;
      totalCost += trade.cost_usd;
      totalProfit += trade.profit_usd;
      pendingPayout += trade.guaranteed_payout;
    } else if (trade.status === 'failed') {
      failed++;
    }
  }

  return {
    total_trades: executedTrades.length,
    successful_trades: successful,
    failed_trades: failed,
    total_cost: totalCost,
    total_profit: totalProfit,
    pending_payout: pendingPayout,
  };
}

/**
 * Check if trader is ready
 */
export function isTraderReady(): boolean {
  return clobClient !== null && wallet !== null;
}
