/**
 * Real Trade Execution - Optimized
 * 
 * Features:
 * - Parallel order execution
 * - Dynamic sizing (% of balance)
 * - Liquidity-aware (don't move the market)
 * - Slippage protection
 * - Price verification before execution
 */

import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import axios from 'axios';
import { ArbitrageOpportunity } from '../types/arbitrage';

// ============ CONFIGURATION ============
const TRADE_SIZE_PERCENT = 0.20; // 20% of available balance per trade
const MIN_TRADE_SIZE_USD = 2; // Minimum $2 per trade
const MAX_LIQUIDITY_PERCENT = 0.30; // Don't take more than 30% of available liquidity
const SLIPPAGE_TOLERANCE = 0.01; // 1% slippage tolerance - more aggressive to ensure fills
const PRICE_VERIFY_TOLERANCE = 0.02; // 2% - reject if price moved more than this
const ORDER_FILL_TIMEOUT_MS = 5000; // 5 seconds to wait for both orders to fill
const ORDER_CHECK_INTERVAL_MS = 500; // Check order status every 500ms

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
    console.log(`   Min per trade: $${MIN_TRADE_SIZE_USD}`);
    console.log(`   Max liquidity take: ${(MAX_LIQUIDITY_PERCENT * 100).toFixed(0)}%`);
    console.log(`   Slippage tolerance: ${(SLIPPAGE_TOLERANCE * 100).toFixed(1)}%`);

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
 * Fetch current orderbook to verify prices and get liquidity
 */
async function verifyPricesAndLiquidity(
  upTokenId: string,
  downTokenId: string,
  expectedUpPrice: number,
  expectedDownPrice: number
): Promise<{
  verified: boolean;
  upPrice: number;
  downPrice: number;
  upLiquidity: number;
  downLiquidity: number;
  reason?: string;
}> {
  try {
    // Fetch both orderbooks in parallel
    const [upPriceResp, downPriceResp, upBook, downBook] = await Promise.all([
      axios.get(`${CLOB_HOST}/price`, { params: { token_id: upTokenId, side: 'buy' }, timeout: 3000 }),
      axios.get(`${CLOB_HOST}/price`, { params: { token_id: downTokenId, side: 'buy' }, timeout: 3000 }),
      axios.get(`${CLOB_HOST}/book`, { params: { token_id: upTokenId }, timeout: 3000 }),
      axios.get(`${CLOB_HOST}/book`, { params: { token_id: downTokenId }, timeout: 3000 }),
    ]);

    const currentUpPrice = parseFloat(upPriceResp.data?.price || '0');
    const currentDownPrice = parseFloat(downPriceResp.data?.price || '0');
    
    // Get liquidity at best ask
    const upAsks = upBook.data?.asks || [];
    const downAsks = downBook.data?.asks || [];
    const upLiquidity = upAsks.length > 0 ? parseFloat(upAsks[0].size) : 0;
    const downLiquidity = downAsks.length > 0 ? parseFloat(downAsks[0].size) : 0;

    // Check if prices moved too much
    const upPriceChange = Math.abs(currentUpPrice - expectedUpPrice) / expectedUpPrice;
    const downPriceChange = Math.abs(currentDownPrice - expectedDownPrice) / expectedDownPrice;

    if (upPriceChange > PRICE_VERIFY_TOLERANCE) {
      return {
        verified: false,
        upPrice: currentUpPrice,
        downPrice: currentDownPrice,
        upLiquidity,
        downLiquidity,
        reason: `UP price moved ${(upPriceChange * 100).toFixed(1)}% (was $${expectedUpPrice.toFixed(3)}, now $${currentUpPrice.toFixed(3)})`,
      };
    }

    if (downPriceChange > PRICE_VERIFY_TOLERANCE) {
      return {
        verified: false,
        upPrice: currentUpPrice,
        downPrice: currentDownPrice,
        upLiquidity,
        downLiquidity,
        reason: `DOWN price moved ${(downPriceChange * 100).toFixed(1)}% (was $${expectedDownPrice.toFixed(3)}, now $${currentDownPrice.toFixed(3)})`,
      };
    }

    // Verify combined cost still gives us an arb
    const combinedCost = currentUpPrice + currentDownPrice;
    if (combinedCost >= 0.98) {
      return {
        verified: false,
        upPrice: currentUpPrice,
        downPrice: currentDownPrice,
        upLiquidity,
        downLiquidity,
        reason: `No arb anymore - combined cost is now $${combinedCost.toFixed(4)}`,
      };
    }

    return {
      verified: true,
      upPrice: currentUpPrice,
      downPrice: currentDownPrice,
      upLiquidity,
      downLiquidity,
    };
  } catch (error: any) {
    return {
      verified: false,
      upPrice: 0,
      downPrice: 0,
      upLiquidity: 0,
      downLiquidity: 0,
      reason: `Failed to verify prices: ${error.message}`,
    };
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
  // Start with % of balance
  let targetUsd = balance * TRADE_SIZE_PERCENT;
  let reason = `${(TRADE_SIZE_PERCENT * 100).toFixed(0)}% of $${balance.toFixed(2)} balance`;

  // Floor at min
  if (targetUsd < MIN_TRADE_SIZE_USD) {
    return { shares: 0, reason: `below min $${MIN_TRADE_SIZE_USD}` };
  }

  // Calculate shares from USD
  let shares = Math.floor(targetUsd / combinedCost);

  // Respect liquidity - don't take more than MAX_LIQUIDITY_PERCENT of available
  const maxUpShares = Math.floor(upLiquidity * MAX_LIQUIDITY_PERCENT);
  const maxDownShares = Math.floor(downLiquidity * MAX_LIQUIDITY_PERCENT);
  const liquidityLimit = Math.min(maxUpShares, maxDownShares);

  if (shares > liquidityLimit && liquidityLimit > 0) {
    shares = liquidityLimit;
    reason = `limited by liquidity (${(MAX_LIQUIDITY_PERCENT * 100).toFixed(0)}% of ${Math.min(upLiquidity, downLiquidity).toFixed(0)} available)`;
  }

  // Final check
  if (shares < 1) {
    return { shares: 0, reason: 'insufficient liquidity' };
  }

  return { shares, reason };
}

/**
 * Check if an order is filled
 */
async function checkOrderStatus(orderId: string): Promise<'filled' | 'open' | 'cancelled' | 'unknown'> {
  if (!clobClient) return 'unknown';
  
  try {
    const order = await clobClient.getOrder(orderId);
    if (!order) return 'unknown';
    
    // Check order status
    if (order.status === 'FILLED' || order.status === 'filled') {
      return 'filled';
    }
    if (order.status === 'CANCELLED' || order.status === 'cancelled') {
      return 'cancelled';
    }
    return 'open';
  } catch (error: any) {
    // If order not found, might be filled or cancelled
    return 'unknown';
  }
}

/**
 * Cancel an order
 */
async function cancelOrder(orderId: string): Promise<boolean> {
  if (!clobClient) return false;
  
  try {
    await clobClient.cancelOrder(orderId);
    return true;
  } catch (error: any) {
    console.error(`   Failed to cancel order ${orderId}: ${error.message}`);
    return false;
  }
}

/**
 * Wait for both orders to fill, cancel if one doesn't
 */
async function waitForBothOrders(
  upOrderId: string | null,
  downOrderId: string | null
): Promise<{ upFilled: boolean; downFilled: boolean }> {
  if (!upOrderId || !downOrderId) {
    return { upFilled: false, downFilled: false };
  }

  const startTime = Date.now();
  let upFilled = false;
  let downFilled = false;

  while (Date.now() - startTime < ORDER_FILL_TIMEOUT_MS) {
    // Check both orders in parallel
    if (!upFilled) {
      const upStatus = await checkOrderStatus(upOrderId);
      upFilled = upStatus === 'filled';
    }

    if (!downFilled) {
      const downStatus = await checkOrderStatus(downOrderId);
      downFilled = downStatus === 'filled';
    }

    // If both filled, we're done
    if (upFilled && downFilled) {
      return { upFilled: true, downFilled: true };
    }

    // If one filled but other didn't, wait a bit more then cancel
    if ((upFilled && !downFilled) || (!upFilled && downFilled)) {
      await new Promise(r => setTimeout(r, ORDER_CHECK_INTERVAL_MS));
      
      // Check one more time
      if (!upFilled) {
        const upStatus = await checkOrderStatus(upOrderId);
        upFilled = upStatus === 'filled';
      }
      if (!downFilled) {
        const downStatus = await checkOrderStatus(downOrderId);
        downFilled = downStatus === 'filled';
      }

      // If still only one filled, cancel the other
      if (upFilled && !downFilled) {
        console.log(`   ⚠️ UP filled but DOWN didn't - cancelling DOWN order...`);
        await cancelOrder(downOrderId);
        return { upFilled: true, downFilled: false };
      }
      if (downFilled && !upFilled) {
        console.log(`   ⚠️ DOWN filled but UP didn't - cancelling UP order...`);
        await cancelOrder(upOrderId);
        return { upFilled: false, downFilled: true };
      }
    }

    // Wait before next check
    await new Promise(r => setTimeout(r, ORDER_CHECK_INTERVAL_MS));
  }

  // Timeout - check final status
  if (!upFilled) {
    const upStatus = await checkOrderStatus(upOrderId);
    upFilled = upStatus === 'filled';
  }
  if (!downFilled) {
    const downStatus = await checkOrderStatus(downOrderId);
    downFilled = downStatus === 'filled';
  }

  // Cancel any unfilled orders
  if (!upFilled && upOrderId) {
    console.log(`   ⚠️ UP order didn't fill - cancelling...`);
    await cancelOrder(upOrderId);
  }
  if (!downFilled && downOrderId) {
    console.log(`   ⚠️ DOWN order didn't fill - cancelling...`);
    await cancelOrder(downOrderId);
  }

  return { upFilled, downFilled };
}

/**
 * Execute arbitrage trade - buy both Up and Down in PARALLEL
 */
export async function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null> {
  if (!clobClient || !wallet) {
    console.error('Trader not initialized');
    return null;
  }

  const now = Date.now();

  // Step 1: Verify prices haven't moved
  console.log(`\n🔍 VERIFYING PRICES...`);
  const verification = await verifyPricesAndLiquidity(
    arb.up_token_id,
    arb.down_token_id,
    arb.up_price,
    arb.down_price
  );

  if (!verification.verified) {
    console.log(`   ❌ ${verification.reason}`);
    return null;
  }

  // Use verified current prices
  const upPrice = verification.upPrice;
  const downPrice = verification.downPrice;
  const combinedCost = upPrice + downPrice;

  console.log(`   ✓ Prices verified: UP=$${upPrice.toFixed(3)} DOWN=$${downPrice.toFixed(3)} = $${combinedCost.toFixed(4)}`);
  console.log(`   ✓ Liquidity: UP=${verification.upLiquidity.toFixed(0)} DOWN=${verification.downLiquidity.toFixed(0)}`);

  // Step 2: Calculate optimal size
  const balance = await getBalance();
  const { shares, reason } = calculateTradeSize(
    balance,
    combinedCost,
    verification.upLiquidity,
    verification.downLiquidity
  );

  if (shares < 1) {
    console.log(`   ❌ Cannot trade: ${reason}`);
    return null;
  }

  const costUsd = shares * combinedCost;
  const profitUsd = shares * (1.0 - combinedCost);

  console.log(`   ✓ Size: ${shares} shares (${reason})`);

  // Step 3: Prepare trade record
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
  };

  console.log(`\n💰 EXECUTING TRADE: ${arb.market_title}`);
  console.log(`   Shares: ${shares} @ $${combinedCost.toFixed(4)}`);
  console.log(`   Cost: $${costUsd.toFixed(2)} | Payout: $${trade.guaranteed_payout.toFixed(2)} | Profit: $${profitUsd.toFixed(2)}`);

  // Step 4: Execute BOTH orders in PARALLEL with aggressive pricing
  console.log(`   Submitting orders in parallel...`);
  
  // Use more aggressive slippage to ensure fills
  const upPriceWithSlippage = Math.min(upPrice * (1 + SLIPPAGE_TOLERANCE), 0.99);
  const downPriceWithSlippage = Math.min(downPrice * (1 + SLIPPAGE_TOLERANCE), 0.99);

  console.log(`   UP limit: $${upPriceWithSlippage.toFixed(3)} (${((upPriceWithSlippage / upPrice - 1) * 100).toFixed(1)}% slippage)`);
  console.log(`   DOWN limit: $${downPriceWithSlippage.toFixed(3)} (${((downPriceWithSlippage / downPrice - 1) * 100).toFixed(1)}% slippage)`);

  try {
    const [upResult, downResult] = await Promise.all([
      clobClient.createAndPostOrder({
        tokenID: arb.up_token_id,
        price: upPriceWithSlippage,
        size: shares,
        side: Side.BUY,
      }).catch(err => ({ error: err })),
      clobClient.createAndPostOrder({
        tokenID: arb.down_token_id,
        price: downPriceWithSlippage,
        size: shares,
        side: Side.BUY,
      }).catch(err => ({ error: err })),
    ]);

    // Check if orders were submitted
    const upOrderId = upResult && !('error' in upResult) ? (upResult as any).orderID : null;
    const downOrderId = downResult && !('error' in downResult) ? (downResult as any).orderID : null;

    if (!upOrderId || !downOrderId) {
      // One or both orders failed to submit
      const upErr = ('error' in upResult) ? (upResult.error as any).message : 'No order ID';
      const downErr = ('error' in downResult) ? (downResult.error as any).message : 'No order ID';
      
      if (!upOrderId) console.error(`   ❌ UP order submission failed: ${upErr}`);
      if (!downOrderId) console.error(`   ❌ DOWN order submission failed: ${downErr}`);
      
      trade.status = 'failed';
      trade.error = `Order submission failed: UP=${upOrderId ? 'ok' : 'failed'}, DOWN=${downOrderId ? 'ok' : 'failed'}`;
      console.log(`   ❌ TRADE FAILED - Could not submit both orders`);
      executedTrades.push(trade);
      return trade;
    }

    trade.up_order_id = upOrderId;
    trade.down_order_id = downOrderId;
    console.log(`   ✓ UP order submitted: ${upOrderId}`);
    console.log(`   ✓ DOWN order submitted: ${downOrderId}`);
    console.log(`   ⏳ Waiting for both orders to fill (max ${ORDER_FILL_TIMEOUT_MS / 1000}s)...`);

    // Wait for both orders to fill, cancel if only one fills
    const { upFilled, downFilled } = await waitForBothOrders(upOrderId, downOrderId);

    // Determine final status
    if (upFilled && downFilled) {
      trade.status = 'filled';
      console.log(`   ✅ BOTH ORDERS FILLED - Profit locked: $${profitUsd.toFixed(2)}`);
      
      // Update balance cache
      cachedBalance -= costUsd;
      console.log(`   💵 Remaining balance: ~$${cachedBalance.toFixed(2)}`);
      console.log(`   📊 Continuing to scan for more opportunities...\n`);
    } else {
      // Partial fill - we cancelled the other order
      trade.status = 'failed';
      trade.error = `Partial fill - UP=${upFilled ? 'filled' : 'cancelled'}, DOWN=${downFilled ? 'filled' : 'cancelled'}`;
      console.log(`   ❌ TRADE CANCELLED - Only one side filled, cancelled the other to avoid exposure`);
      console.log(`   📊 Continuing to scan for more opportunities...\n`);
    }

  } catch (error: any) {
    trade.status = 'failed';
    trade.error = error.message;
    console.error(`   ❌ TRADE FAILED: ${error.message}`);
    console.log(`   📊 Continuing to scan for more opportunities...\n`);
  }

  executedTrades.push(trade);
  return trade;
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
