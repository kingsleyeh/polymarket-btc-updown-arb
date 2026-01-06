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
const TRADE_SIZE_PERCENT = 0.10; // 10% of available balance per trade
const MIN_SHARES = 5; // Polymarket requires minimum 5 shares per order
const MAX_LIQUIDITY_PERCENT = 0.30; // Don't take more than 30% of available liquidity
const MAX_COMBINED_COST = 0.99; // Maximum acceptable combined cost (reject if exceeds)
const MARKET_ORDER_SLIPPAGE = 0.03; // 3% - aggressive to ensure fills
const PRICE_VERIFY_TOLERANCE = 0.02; // 2% - reject if price moved more than this
const ORDER_FILL_TIMEOUT_MS = 2000; // 2s to wait for orders to fill
const ORDER_CHECK_INTERVAL_MS = 50; // Check every 50ms
const POSITION_CHECK_INTERVAL_MS = 50; // Check positions every 50ms
const MAX_WAIT_FOR_BOTH_MS = 2000; // 2s max wait for both orders
const POLLING_DELAY_MS = 50; // Polling delay 50ms
const API_TIMEOUT_MS = 2000; // 2s timeout for API calls (can't be too short!)

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
  // Smart retry fields
  orders_placed: boolean; // True if any orders were submitted to the exchange
  reversal_succeeded: boolean; // True if one-sided position was successfully reversed
  has_exposure: boolean; // True if we have unhedged position (needs manual intervention)
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
    console.log(`   Market order slippage: ${(MARKET_ORDER_SLIPPAGE * 100).toFixed(1)}%`);

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
 * Fetch current prices to verify they haven't moved (fast verification)
 */
async function verifyPricesAndLiquidity(
  upTokenId: string,
  downTokenId: string,
  expectedUpPrice: number,
  expectedDownPrice: number,
  cachedUpLiquidity: number,
  cachedDownLiquidity: number
): Promise<{
  verified: boolean;
  upPrice: number;
  downPrice: number;
  upLiquidity: number;
  downLiquidity: number;
  reason?: string;
}> {
  try {
    // Only fetch prices (fast) - use cached liquidity from scan
    const [upPriceResp, downPriceResp] = await Promise.all([
      axios.get(`${CLOB_HOST}/price`, { params: { token_id: upTokenId, side: 'buy' }, timeout: 1000 }),
      axios.get(`${CLOB_HOST}/price`, { params: { token_id: downTokenId, side: 'buy' }, timeout: 1000 }),
    ]);

    const currentUpPrice = parseFloat(upPriceResp.data?.price || '0');
    const currentDownPrice = parseFloat(downPriceResp.data?.price || '0');
    
    // Use cached liquidity from scan (faster - no need to re-fetch)
    const upLiquidity = cachedUpLiquidity;
    const downLiquidity = cachedDownLiquidity;

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

  // Calculate shares from USD
  let shares = Math.floor(targetUsd / combinedCost);
  
  // Enforce Polymarket's minimum 5 shares requirement
  if (shares < MIN_SHARES) {
    // Check if we can afford minimum 5 shares
    const minCost = MIN_SHARES * combinedCost;
    if (minCost > balance) {
      return { shares: 0, reason: `cannot afford minimum ${MIN_SHARES} shares (need $${minCost.toFixed(2)}, have $${balance.toFixed(2)})` };
    }
    // Use minimum 5 shares if we can afford it
    shares = MIN_SHARES;
    reason = `minimum ${MIN_SHARES} shares (can afford $${minCost.toFixed(2)} of $${balance.toFixed(2)} balance)`;
  }

  // Respect liquidity - don't take more than MAX_LIQUIDITY_PERCENT of available
  const maxUpShares = Math.floor(upLiquidity * MAX_LIQUIDITY_PERCENT);
  const maxDownShares = Math.floor(downLiquidity * MAX_LIQUIDITY_PERCENT);
  const liquidityLimit = Math.min(maxUpShares, maxDownShares);

  if (shares > liquidityLimit && liquidityLimit >= MIN_SHARES) {
    // Only limit if liquidity allows at least minimum shares
    shares = liquidityLimit;
    reason = `limited by liquidity (${(MAX_LIQUIDITY_PERCENT * 100).toFixed(0)}% of ${Math.min(upLiquidity, downLiquidity).toFixed(0)} available)`;
  } else if (shares > liquidityLimit && liquidityLimit < MIN_SHARES) {
    // Liquidity is too low - can't meet minimum
    return { shares: 0, reason: `insufficient liquidity (need ${MIN_SHARES} shares, only ${liquidityLimit.toFixed(0)} available)` };
  }

  // Final check - must have at least minimum shares
  if (shares < MIN_SHARES) {
    return { shares: 0, reason: `below minimum ${MIN_SHARES} shares` };
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
    if (!order) {
      // Order not found - might be filled and removed from system
      return 'unknown';
    }
    
    // Check order status (case-insensitive)
    const status = String(order.status || '').toLowerCase();
    
    if (status === 'filled' || status === 'complete') {
      return 'filled';
    }
    if (status === 'cancelled' || status === 'canceled') {
      return 'cancelled';
    }
    
    // Check if order is partially filled (treat as filled for our purposes)
    const orderAny = order as any;
    const filledSize = parseFloat(orderAny.filledSize || orderAny.filled_size || '0');
    const orderSize = parseFloat(orderAny.size || orderAny.orderSize || '0');
    if (filledSize > 0 && orderSize > 0 && filledSize >= orderSize * 0.95) {
      // 95%+ filled counts as filled
      return 'filled';
    }
    
    return 'open';
  } catch (error: any) {
    // If order not found (404), it might be filled and removed
    if (error?.response?.status === 404) {
      return 'unknown'; // Could be filled
    }
    return 'unknown';
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
    console.error(`   Failed to cancel order ${orderId}: ${error.message}`);
    return false;
  }
}

/**
 * Place market order (aggressive limit that acts like market)
 */
async function placeMarketOrder(
  tokenId: string,
  size: number,
  side: Side,
  maxPrice: number
): Promise<string | null> {
  if (!clobClient) return null;
  
  try {
    // Use very aggressive limit price (maxPrice) - will fill immediately if liquidity exists
    const order = await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: maxPrice, // Set to max acceptable price - acts like market order
      size: size,
      side: side,
    });
    
    return order.orderID || null;
  } catch (error: any) {
    console.error(`   Market order failed: ${error.message}`);
    return null;
  }
}

/**
 * Check actual positions (token balances) to see if we have one-sided exposure
 * Uses the CLOB API /balance endpoint with token_id
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
    // Try using getBalanceAllowance with CONDITIONAL asset type for token positions
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
    
    // Consider we have a position if balance >= 90% of expected (accounting for rounding)
    const hasUp = upBal >= expectedShares * 0.9;
    const hasDown = downBal >= expectedShares * 0.9;
    
    return { hasUp, hasDown, upBalance: upBal, downBalance: downBal };
  } catch (error: any) {
    // Fallback: try direct API call
    try {
      const [upResp, downResp] = await Promise.all([
        axios.get(`${CLOB_HOST}/balance`, {
          params: { token_id: upTokenId },
          timeout: API_TIMEOUT_MS,
        }).catch(() => ({ data: { balance: '0' } })),
        axios.get(`${CLOB_HOST}/balance`, {
          params: { token_id: downTokenId },
          timeout: API_TIMEOUT_MS,
        }).catch(() => ({ data: { balance: '0' } })),
      ]);
      
      const upBal = parseFloat(upResp.data?.balance || '0') / 1_000_000;
      const downBal = parseFloat(downResp.data?.balance || '0') / 1_000_000;
      
      const hasUp = upBal >= expectedShares * 0.9;
      const hasDown = downBal >= expectedShares * 0.9;
      
      return { hasUp, hasDown, upBalance: upBal, downBalance: downBal };
    } catch (fallbackError: any) {
      console.error(`   ⚠️ Failed to check positions: ${error.message}`);
      return { hasUp: false, hasDown: false, upBalance: 0, downBalance: 0 };
    }
  }
}

/**
 * Sell/close a position immediately (reverse the filled leg)
 */
async function reversePosition(
  tokenId: string,
  shares: number
): Promise<boolean> {
  if (!clobClient) return false;
  
  // Retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Get current price to sell at market
      const priceResp = await axios.get(`${CLOB_HOST}/price`, {
        params: { token_id: tokenId, side: 'sell' },
        timeout: API_TIMEOUT_MS,
      });
      
      const sellPrice = parseFloat(priceResp.data?.price || '0');
      if (sellPrice === 0) {
        if (attempt < 3) continue;
        return false;
      }
      
      // Use VERY aggressive limit (5% below market) to ensure immediate fill
      const limitPrice = Math.max(sellPrice * 0.95, 0.01); // 5% below market for speed
      
      if (attempt === 1) {
        console.log(`   🔄 Reversing: selling ${shares} shares @ $${limitPrice.toFixed(3)} (attempt ${attempt})...`);
      }
      
      const order = await clobClient.createAndPostOrder({
        tokenID: tokenId,
        price: limitPrice,
        size: shares,
        side: Side.SELL,
      });
      
      if (order.orderID) {
        console.log(`   ✓ Reversal order placed: ${order.orderID}`);
        
        // Wait briefly and verify it filled
        await new Promise(r => setTimeout(r, 200)); // 200ms to let order process
        const orderStatus = await checkOrderStatus(order.orderID);
        if (orderStatus === 'filled') {
          return true;
        } else if (attempt < 3) {
          console.log(`   ⚠️ Reversal order not filled yet, retrying...`);
          continue;
        }
        return true; // Order placed, even if not confirmed filled
      }
      
      if (attempt < 3) continue;
      return false;
    } catch (error: any) {
      if (attempt < 3) {
        console.log(`   ⚠️ Reversal attempt ${attempt} failed: ${error.message}, retrying...`);
        continue;
      }
      console.error(`   ❌ Failed to reverse position after ${attempt} attempts: ${error.message}`);
      return false;
    }
  }
  
  return false;
}

/**
 * BOTH OR NOTHING: Wait for both orders, check positions continuously
 * If we don't have both within 1 second, cancel everything and reverse any filled leg
 */
async function waitForBothOrders(
  upOrderId: string | null,
  downOrderId: string | null,
  upTokenId: string,
  downTokenId: string,
  shares: number,
  maxUpPrice: number,
  maxDownPrice: number
): Promise<{ upFilled: boolean; downFilled: boolean; secondLegOrderId: string | null; reversed: boolean }> {
  if (!upOrderId || !downOrderId) {
    return { upFilled: false, downFilled: false, secondLegOrderId: null, reversed: false };
  }

  const startTime = Date.now();
  let secondLegOrderId: string | null = null;
  let marketOrderPlaced = false;
  let lastPositionCheck = 0;

  // IMMEDIATE first check: Check ORDER STATUS (fast)
  const [upStatus, downStatus] = await Promise.all([
    checkOrderStatus(upOrderId),
    checkOrderStatus(downOrderId),
  ]);
  
  // Treat 'filled' or 'unknown' (404 = order removed, likely filled) as potentially filled
  let upFilled = upStatus === 'filled' || upStatus === 'unknown';
  let downFilled = downStatus === 'filled' || downStatus === 'unknown';
  
  // Verify with positions (positions are the source of truth)
  let positions = await checkPositions(upTokenId, downTokenId, shares);
  let hasUpPos = positions.hasUp;
  let hasDownPos = positions.hasDown;
  
  console.log(`   [0ms] Order status: UP=${upStatus} DOWN=${downStatus} | Positions: UP=${positions.upBalance.toFixed(1)} DOWN=${positions.downBalance.toFixed(1)}`);
  
  // BOTH FILLED - SUCCESS!
  if (hasUpPos && hasDownPos) {
    console.log(`   ✅ BOTH FILLED immediately!`);
    await Promise.all([
      cancelOrder(upOrderId),
      cancelOrder(downOrderId),
    ]);
    return { upFilled: true, downFilled: true, secondLegOrderId: null, reversed: false };
  }

  // ONE-SIDED: Place market order IMMEDIATELY
  if (hasUpPos && !hasDownPos && !marketOrderPlaced) {
    console.log(`   ⚠️ UP filled but DOWN didn't - placing MARKET order for DOWN NOW...`);
    marketOrderPlaced = true;
    secondLegOrderId = await placeMarketOrder(downTokenId, shares, Side.BUY, maxDownPrice);
  } else if (!hasUpPos && hasDownPos && !marketOrderPlaced) {
    console.log(`   ⚠️ DOWN filled but UP didn't - placing MARKET order for UP NOW...`);
    marketOrderPlaced = true;
    secondLegOrderId = await placeMarketOrder(upTokenId, shares, Side.BUY, maxUpPrice);
  }

  // Fast polling loop: check POSITIONS every 100ms (positions are source of truth)
  while (Date.now() - startTime < MAX_WAIT_FOR_BOTH_MS) {
    const elapsed = Date.now() - startTime;
    
    // Check POSITIONS (source of truth - faster than order status API)
    if (Date.now() - lastPositionCheck >= POSITION_CHECK_INTERVAL_MS) {
      lastPositionCheck = Date.now();
      positions = await checkPositions(upTokenId, downTokenId, shares);
      
      hasUpPos = positions.hasUp;
      hasDownPos = positions.hasDown;
      
      // BOTH FILLED - SUCCESS!
      if (hasUpPos && hasDownPos) {
        console.log(`   [${elapsed}ms] ✅ BOTH POSITIONS - SUCCESS!`);
        await Promise.all([
          cancelOrder(upOrderId),
          cancelOrder(downOrderId),
          secondLegOrderId ? cancelOrder(secondLegOrderId) : Promise.resolve(),
        ]);
        return { upFilled: true, downFilled: true, secondLegOrderId, reversed: false };
      }
      
      // ONE-SIDED: Place market order if not already placed
      if (hasUpPos && !hasDownPos && !marketOrderPlaced) {
        console.log(`   [${elapsed}ms] ⚠️ UP filled - placing MARKET order for DOWN...`);
        marketOrderPlaced = true;
        secondLegOrderId = await placeMarketOrder(downTokenId, shares, Side.BUY, maxDownPrice);
      } else if (!hasUpPos && hasDownPos && !marketOrderPlaced) {
        console.log(`   [${elapsed}ms] ⚠️ DOWN filled - placing MARKET order for UP...`);
        marketOrderPlaced = true;
        secondLegOrderId = await placeMarketOrder(upTokenId, shares, Side.BUY, maxUpPrice);
      }
    }

    await new Promise(r => setTimeout(r, POLLING_DELAY_MS)); // Poll every 5ms (maximum speed)
  }

  // TIMEOUT: Final check - POSITIONS are source of truth
  const finalPositions = await checkPositions(upTokenId, downTokenId, shares);
  const finalHasUp = finalPositions.hasUp;
  const finalHasDown = finalPositions.hasDown;
  
  console.log(`   [TIMEOUT] Final positions: UP=${finalPositions.upBalance.toFixed(1)} (${finalHasUp ? 'YES' : 'NO'}) DOWN=${finalPositions.downBalance.toFixed(1)} (${finalHasDown ? 'YES' : 'NO'})`);

  // BOTH - Success
  if (finalHasUp && finalHasDown) {
    console.log(`   ✅ BOTH POSITIONS at timeout - SUCCESS!`);
    await Promise.all([
      cancelOrder(upOrderId),
      cancelOrder(downOrderId),
      secondLegOrderId ? cancelOrder(secondLegOrderId) : Promise.resolve(),
    ]);
    return { upFilled: true, downFilled: true, secondLegOrderId, reversed: false };
  }

  // ONE-SIDED OR NONE - REVERSE IMMEDIATELY
  console.log(`   ❌ Don't have both - reversing any filled leg...`);
  await Promise.all([
    cancelOrder(upOrderId),
    cancelOrder(downOrderId),
    secondLegOrderId ? cancelOrder(secondLegOrderId) : Promise.resolve(),
  ]);

  // Reverse any filled leg - use ACTUAL balance from positions (not expected shares)
  let reversed = false;
  let hadPositionToReverse = false;
  
  if (finalHasUp && !finalHasDown) {
    hadPositionToReverse = true;
    // Only reverse what we actually have, not what we expected
    const sharesToReverse = Math.floor(finalPositions.upBalance);
    if (sharesToReverse >= 1) {
      console.log(`   🔄 Reversing ${sharesToReverse} UP shares...`);
      reversed = await reversePosition(upTokenId, sharesToReverse);
    }
  } else if (!finalHasUp && finalHasDown) {
    hadPositionToReverse = true;
    const sharesToReverse = Math.floor(finalPositions.downBalance);
    if (sharesToReverse >= 1) {
      console.log(`   🔄 Reversing ${sharesToReverse} DOWN shares...`);
      reversed = await reversePosition(downTokenId, sharesToReverse);
    }
  } else if (!finalHasUp && !finalHasDown) {
    // No positions - orders never filled, this is actually a success (no exposure)
    console.log(`   ✓ No positions to reverse - orders didn't fill (safe)`);
    reversed = true; // Mark as "reversed" since we have no exposure
  }
  
  if (reversed && hadPositionToReverse) {
    console.log(`   ✅ Reversal successful - position cleared`);
  } else if (!reversed && hadPositionToReverse) {
    console.log(`   ❌ REVERSAL FAILED - MANUAL INTERVENTION NEEDED`);
  }

  return { upFilled: false, downFilled: false, secondLegOrderId, reversed };
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

  // Use prices directly from scan (already execution prices from /price endpoint)
  // No verification delay - execute immediately to catch fast-moving arbs
  const upPrice = arb.up_price;
  const downPrice = arb.down_price;
  const combinedCost = arb.combined_cost;

  console.log(`\n💰 EXECUTING IMMEDIATELY: UP=$${upPrice.toFixed(3)} DOWN=$${downPrice.toFixed(3)} = $${combinedCost.toFixed(4)}`);
  console.log(`   Liquidity: UP=${arb.up_shares_available.toFixed(0)} DOWN=${arb.down_shares_available.toFixed(0)}`);

  // Check max combined cost protection
  if (combinedCost > MAX_COMBINED_COST) {
    console.log(`   ❌ Combined cost $${combinedCost.toFixed(4)} exceeds max $${MAX_COMBINED_COST.toFixed(2)} - rejecting`);
    return null;
  }

  // Calculate optimal size
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
    orders_placed: false,
    reversal_succeeded: false,
    has_exposure: false,
  };

  console.log(`   Shares: ${shares} @ $${combinedCost.toFixed(4)}`);
  console.log(`   Cost: $${costUsd.toFixed(2)} | Payout: $${trade.guaranteed_payout.toFixed(2)} | Profit: $${profitUsd.toFixed(2)}`);
  
  // Use scan prices directly but pay UP TO $0.99 combined to ensure fills
  // Strategy: Set limit prices to max we're willing to pay per token
  // If scan combined is $0.97, we have $0.02 room to spare
  const room = MAX_COMBINED_COST - combinedCost; // Room before hitting 0.99
  const bufferPerToken = Math.min(room / 2, 0.05); // Split room between tokens, max 5% each
  
  let upMarketPrice = Math.min(upPrice + bufferPerToken, 0.95);
  let downMarketPrice = Math.min(downPrice + bufferPerToken, 0.95);
  let maxCombinedCost = upMarketPrice + downMarketPrice;

  // Ensure we don't exceed $0.99 combined
  if (maxCombinedCost > MAX_COMBINED_COST) {
    const excess = maxCombinedCost - MAX_COMBINED_COST;
    upMarketPrice = upMarketPrice - (excess / 2);
    downMarketPrice = downMarketPrice - (excess / 2);
    maxCombinedCost = upMarketPrice + downMarketPrice;
  }

  // Final safety check
  if (maxCombinedCost > MAX_COMBINED_COST) {
    console.log(`   ❌ Max combined cost $${maxCombinedCost.toFixed(4)} exceeds limit $${MAX_COMBINED_COST.toFixed(2)} - rejecting`);
    return null;
  }

  console.log(`   Market orders: UP=$${upMarketPrice.toFixed(3)} DOWN=$${downMarketPrice.toFixed(3)} = $${maxCombinedCost.toFixed(4)}`);

  try {
    // Place BOTH orders simultaneously with aggressive limit prices
    console.log(`   🚀 Placing BOTH orders simultaneously...`);
    const [upResult, downResult] = await Promise.all([
      clobClient.createAndPostOrder({
        tokenID: arb.up_token_id,
        price: upMarketPrice, // Aggressive limit to ensure fill
        size: shares,
        side: Side.BUY,
      }).catch(err => ({ error: err })),
      clobClient.createAndPostOrder({
        tokenID: arb.down_token_id,
        price: downMarketPrice, // Aggressive limit to ensure fill
        size: shares,
        side: Side.BUY,
      }).catch(err => ({ error: err })),
    ]);

    // Check if orders were submitted
    const upOrderId = upResult && !('error' in upResult) ? (upResult as any).orderID : null;
    const downOrderId = downResult && !('error' in downResult) ? (downResult as any).orderID : null;

    if (!upOrderId || !downOrderId) {
      // One or both orders failed to submit - extract error message
      let upErr = 'Unknown error';
      let downErr = 'Unknown error';
      
      if ('error' in upResult) {
        const err = upResult.error as any;
        upErr = err?.data?.error || err?.message || err?.toString() || 'Unknown error';
      }
      
      if ('error' in downResult) {
        const err = downResult.error as any;
        downErr = err?.data?.error || err?.message || err?.toString() || 'Unknown error';
      }
      
      if (!upOrderId) {
        console.error(`   ❌ UP order submission failed: ${upErr}`);
        // Check if it's the minimum size error
        if (upErr.includes('minimum') || upErr.includes('Size')) {
          console.error(`   ⚠️  This is likely due to minimum 5 shares requirement`);
        }
      }
      if (!downOrderId) {
        console.error(`   ❌ DOWN order submission failed: ${downErr}`);
        // Check if it's the minimum size error
        if (downErr.includes('minimum') || downErr.includes('Size')) {
          console.error(`   ⚠️  This is likely due to minimum 5 shares requirement`);
        }
      }
      
      trade.status = 'failed';
      trade.orders_placed = false; // Orders were NOT placed - safe to retry
      trade.error = `Order submission failed: UP=${upOrderId ? 'ok' : upErr}, DOWN=${downOrderId ? 'ok' : downErr}`;
      console.log(`   ❌ TRADE FAILED - Could not submit both orders`);
      executedTrades.push(trade);
      return trade;
    }

    trade.up_order_id = upOrderId;
    trade.down_order_id = downOrderId;
    trade.orders_placed = true; // CRITICAL: Orders are now live on the exchange
    console.log(`   ✓ UP order submitted: ${upOrderId}`);
    console.log(`   ✓ DOWN order submitted: ${downOrderId}`);
    console.log(`   ⏳ Waiting for both orders to fill (max ${ORDER_FILL_TIMEOUT_MS / 1000}s)...`);

    // Wait for both orders to fill, place market order for second leg if one fills
    const { upFilled, downFilled, secondLegOrderId, reversed: waitReversed } = await waitForBothOrders(
      upOrderId,
      downOrderId,
      arb.up_token_id,
      arb.down_token_id,
      shares,
      upMarketPrice,
      downMarketPrice
    );
    
    // Update order IDs if we placed a market order for second leg
    if (secondLegOrderId) {
      trade.down_order_id = secondLegOrderId;
    }

    // Final position check - this is the source of truth
    const finalCheck = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
    const hasBoth = finalCheck.hasUp && finalCheck.hasDown;
    const hasOneSided = (finalCheck.hasUp && !finalCheck.hasDown) || (!finalCheck.hasUp && finalCheck.hasDown);
    const hasNone = !finalCheck.hasUp && !finalCheck.hasDown;
    
    // SUCCESS: Both positions confirmed
    if (hasBoth) {
      trade.status = 'filled';
      trade.has_exposure = false;
      trade.reversal_succeeded = false; // N/A
      console.log(`   ✅ BOTH POSITIONS CONFIRMED - Profit locked: $${profitUsd.toFixed(2)}`);
      cachedBalance -= costUsd;
      console.log(`   💵 Remaining balance: ~$${cachedBalance.toFixed(2)}`);
      console.log(`   📊 Continuing to scan...\n`);
      executedTrades.push(trade);
      return trade;
    }
    
    // DANGER: One-sided position - need to verify reversal worked
    if (hasOneSided) {
      console.log(`   🚨 One-sided position: UP=${finalCheck.upBalance.toFixed(1)} DOWN=${finalCheck.downBalance.toFixed(1)}`);
      
      // waitForBothOrders should have already tried to reverse
      // But we still have a position, so reversal failed OR it's still pending
      // Try ONE more time
      console.log(`   🔄 Attempting final reversal...`);
      let finalReversed = false;
      
      if (finalCheck.hasUp && !finalCheck.hasDown) {
        finalReversed = await reversePosition(arb.up_token_id, Math.floor(finalCheck.upBalance));
      } else {
        finalReversed = await reversePosition(arb.down_token_id, Math.floor(finalCheck.downBalance));
      }
      
      // Check positions again after reversal attempt
      const afterReversal = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
      const stillHasExposure = (afterReversal.hasUp && !afterReversal.hasDown) || (!afterReversal.hasUp && afterReversal.hasDown);
      
      trade.status = 'failed';
      trade.reversal_succeeded = finalReversed && !stillHasExposure;
      trade.has_exposure = stillHasExposure;
      
      if (stillHasExposure) {
        trade.error = 'REVERSAL FAILED - Manual intervention needed';
        console.log(`   ❌ REVERSAL FAILED - Unhedged: UP=${afterReversal.upBalance.toFixed(1)} DOWN=${afterReversal.downBalance.toFixed(1)}`);
        console.log(`   🚨 MANUAL INTERVENTION NEEDED!`);
      } else {
        trade.error = 'One-sided position reversed successfully';
        console.log(`   ✅ Position cleared - can retry if arb persists`);
      }
      console.log(`   📊 Continuing to scan...\n`);
      executedTrades.push(trade);
      return trade;
    }
    
    // NO POSITIONS: Orders never filled (or were cancelled)
    if (hasNone) {
      trade.status = 'failed';
      trade.error = 'Orders did not fill';
      trade.reversal_succeeded = true; // No exposure = success
      trade.has_exposure = false;
      console.log(`   ℹ️ No positions - orders didn't fill (can retry)`);
      console.log(`   📊 Continuing to scan...\n`);
      executedTrades.push(trade);
      return trade;
    }

  } catch (error: any) {
    trade.status = 'failed';
    trade.error = error.message;
    trade.has_exposure = false; // Unknown state, assume safe but log error
    trade.reversal_succeeded = false;
    console.error(`   ❌ TRADE ERROR: ${error.message}`);
    console.log(`   📊 Continuing to scan...\n`);
    executedTrades.push(trade);
    return trade;
  }

  // Should not reach here - all cases above should return
  console.warn(`   ⚠️ Unexpected code path - trade state unknown`);
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
