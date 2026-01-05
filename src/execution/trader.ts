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
const MIN_TRADE_SIZE_USD = 5; // Minimum $5 per trade (to meet Polymarket's 5 share minimum)
const MIN_SHARES = 5; // Polymarket requires minimum 5 shares per order
const MAX_LIQUIDITY_PERCENT = 0.30; // Don't take more than 30% of available liquidity
const MAX_COMBINED_COST = 0.99; // Maximum acceptable combined cost (reject if exceeds)
const MARKET_ORDER_SLIPPAGE = 0.02; // 2% - use aggressive limit prices that act like market orders
const PRICE_VERIFY_TOLERANCE = 0.02; // 2% - reject if price moved more than this
const ORDER_FILL_TIMEOUT_MS = 2000; // 2 seconds to wait for both orders to fill
const ORDER_CHECK_INTERVAL_MS = 100; // Check order status every 100ms (faster)
const SECOND_LEG_TIMEOUT_MS = 500; // If one fills, wait 500ms for other, then IMMEDIATELY market order
const REVERSE_TIMEOUT_MS = 3000; // If can't complete pair in 3s, reverse the filled leg

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

  // Floor at min USD
  if (targetUsd < MIN_TRADE_SIZE_USD) {
    return { shares: 0, reason: `below min $${MIN_TRADE_SIZE_USD}` };
  }

  // Calculate shares from USD
  let shares = Math.floor(targetUsd / combinedCost);
  
  // Enforce Polymarket's minimum 5 shares requirement
  if (shares < MIN_SHARES) {
    // Check if we can afford minimum 5 shares
    const minCost = MIN_SHARES * combinedCost;
    if (minCost > balance) {
      return { shares: 0, reason: `cannot afford minimum ${MIN_SHARES} shares (need $${minCost.toFixed(2)})` };
    }
    shares = MIN_SHARES;
  }

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
 * Sell/close a position immediately (reverse the filled leg)
 */
async function reversePosition(
  tokenId: string,
  shares: number
): Promise<boolean> {
  if (!clobClient) return false;
  
  try {
    // Get current price to sell at market
    const priceResp = await axios.get(`${CLOB_HOST}/price`, {
      params: { token_id: tokenId, side: 'sell' },
      timeout: 1000,
    });
    
    const sellPrice = parseFloat(priceResp.data?.price || '0');
    if (sellPrice === 0) return false;
    
    // Use aggressive limit (slightly below market) to ensure immediate fill
    const limitPrice = Math.max(sellPrice * 0.98, 0.01); // 2% below market, min $0.01
    
    console.log(`   🔄 Reversing position: selling ${shares} shares @ $${limitPrice.toFixed(3)}...`);
    
    const order = await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: limitPrice,
      size: shares,
      side: Side.SELL,
    });
    
    if (order.orderID) {
      console.log(`   ✓ Reversal order placed: ${order.orderID}`);
      return true;
    }
    return false;
  } catch (error: any) {
    console.error(`   ❌ Failed to reverse position: ${error.message}`);
    return false;
  }
}

/**
 * Wait for both orders to fill, IMMEDIATELY place market order for second leg if one fills
 * If can't complete pair, reverse the filled leg to close position
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
  let upFilled = false;
  let downFilled = false;
  let secondLegOrderId: string | null = null;
  let marketOrderPlaced = false;

  // Fast polling loop
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
      return { upFilled: true, downFilled: true, secondLegOrderId: null, reversed: false };
    }

    // If one filled but other didn't - IMMEDIATELY place market order (no wait)
    if ((upFilled && !downFilled) || (!upFilled && downFilled)) {
      if (!marketOrderPlaced) {
        marketOrderPlaced = true;
        
        if (upFilled && !downFilled) {
          console.log(`   ⚠️ UP filled but DOWN didn't - IMMEDIATELY placing MARKET order for DOWN...`);
          secondLegOrderId = await placeMarketOrder(downTokenId, shares, Side.BUY, maxDownPrice);
          if (secondLegOrderId) {
            console.log(`   ✓ Market order placed for DOWN: ${secondLegOrderId}`);
          }
        } else if (downFilled && !upFilled) {
          console.log(`   ⚠️ DOWN filled but UP didn't - IMMEDIATELY placing MARKET order for UP...`);
          secondLegOrderId = await placeMarketOrder(upTokenId, shares, Side.BUY, maxUpPrice);
          if (secondLegOrderId) {
            console.log(`   ✓ Market order placed for UP: ${secondLegOrderId}`);
          }
        }
      }
      
      // If we placed market order, check if it filled
      if (secondLegOrderId) {
        if (upFilled && !downFilled) {
          const downStatus = await checkOrderStatus(secondLegOrderId);
          downFilled = downStatus === 'filled';
        } else if (downFilled && !upFilled) {
          const upStatus = await checkOrderStatus(secondLegOrderId);
          upFilled = upStatus === 'filled';
        }
        
        // If both filled now, we're done
        if (upFilled && downFilled) {
          return { upFilled: true, downFilled: true, secondLegOrderId, reversed: false };
        }
      }
    }

    // Wait before next check
    await new Promise(r => setTimeout(r, ORDER_CHECK_INTERVAL_MS));
  }

  // Final check after timeout
  if (!upFilled) {
    const upStatus = await checkOrderStatus(upOrderId);
    upFilled = upStatus === 'filled';
  }
  if (!downFilled) {
    const downStatus = await checkOrderStatus(downOrderId);
    downFilled = downStatus === 'filled';
  }
  
  // Check market order if we placed one
  if (secondLegOrderId) {
    if (upFilled && !downFilled) {
      const downStatus = await checkOrderStatus(secondLegOrderId);
      downFilled = downStatus === 'filled';
    } else if (downFilled && !upFilled) {
      const upStatus = await checkOrderStatus(secondLegOrderId);
      upFilled = upStatus === 'filled';
    }
  }

  // If still only one filled after all attempts, REVERSE the position
  if ((upFilled && !downFilled) || (downFilled && !upFilled)) {
    const totalTime = Date.now() - startTime;
    if (totalTime >= REVERSE_TIMEOUT_MS) {
      console.log(`   ⚠️ Cannot complete pair after ${(totalTime / 1000).toFixed(1)}s - REVERSING position to avoid exposure...`);
      
      let reversed = false;
      if (upFilled && !downFilled) {
        // Cancel any pending orders
        if (downOrderId) await cancelOrder(downOrderId);
        if (secondLegOrderId) await cancelOrder(secondLegOrderId);
        // Reverse UP position
        reversed = await reversePosition(upTokenId, shares);
      } else if (downFilled && !upFilled) {
        // Cancel any pending orders
        if (upOrderId) await cancelOrder(upOrderId);
        if (secondLegOrderId) await cancelOrder(secondLegOrderId);
        // Reverse DOWN position
        reversed = await reversePosition(downTokenId, shares);
      }
      
      return { upFilled: false, downFilled: false, secondLegOrderId, reversed };
    }
  }

  // Cancel any unfilled orders
  if (!upFilled && upOrderId) {
    await cancelOrder(upOrderId);
  }
  if (!downFilled && downOrderId) {
    await cancelOrder(downOrderId);
  }
  if (secondLegOrderId) {
    const secondStatus = await checkOrderStatus(secondLegOrderId);
    if (secondStatus !== 'filled') {
      await cancelOrder(secondLegOrderId);
    }
  }

  return { upFilled, downFilled, secondLegOrderId, reversed: false };
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

  // Step 1: Fast price verification (use cached liquidity from scan)
  console.log(`\n🔍 VERIFYING PRICES (fast)...`);
  const verification = await verifyPricesAndLiquidity(
    arb.up_token_id,
    arb.down_token_id,
    arb.up_price,
    arb.down_price,
    arb.up_shares_available, // Use cached liquidity from scan
    arb.down_shares_available // Use cached liquidity from scan
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

  // Check max combined cost protection
  if (combinedCost > MAX_COMBINED_COST) {
    console.log(`   ❌ Combined cost $${combinedCost.toFixed(4)} exceeds max $${MAX_COMBINED_COST.toFixed(2)} - rejecting`);
    return null;
  }

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

  // Step 4: Execute BOTH orders in PARALLEL using market-like orders
  console.log(`   Submitting MARKET-LIKE orders in parallel...`);
  
  // Use aggressive limit prices that act like market orders
  // Set to max acceptable price to ensure immediate fills
  const upMaxPrice = Math.min(upPrice * (1 + MARKET_ORDER_SLIPPAGE), 0.99);
  const downMaxPrice = Math.min(downPrice * (1 + MARKET_ORDER_SLIPPAGE), 0.99);
  const maxCombinedCost = upMaxPrice + downMaxPrice;

  // Final safety check - ensure max combined cost is acceptable
  if (maxCombinedCost > MAX_COMBINED_COST) {
    console.log(`   ❌ Max combined cost $${maxCombinedCost.toFixed(4)} exceeds limit $${MAX_COMBINED_COST.toFixed(2)} - rejecting`);
    return null;
  }

  console.log(`   UP max: $${upMaxPrice.toFixed(3)} (market-like)`);
  console.log(`   DOWN max: $${downMaxPrice.toFixed(3)} (market-like)`);
  console.log(`   Max combined: $${maxCombinedCost.toFixed(4)}`);

  try {
    const [upResult, downResult] = await Promise.all([
      clobClient.createAndPostOrder({
        tokenID: arb.up_token_id,
        price: upMaxPrice, // Market-like: aggressive limit at max acceptable price
        size: shares,
        side: Side.BUY,
      }).catch(err => ({ error: err })),
      clobClient.createAndPostOrder({
        tokenID: arb.down_token_id,
        price: downMaxPrice, // Market-like: aggressive limit at max acceptable price
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
      trade.error = `Order submission failed: UP=${upOrderId ? 'ok' : upErr}, DOWN=${downOrderId ? 'ok' : downErr}`;
      console.log(`   ❌ TRADE FAILED - Could not submit both orders`);
      executedTrades.push(trade);
      return trade;
    }

    trade.up_order_id = upOrderId;
    trade.down_order_id = downOrderId;
    console.log(`   ✓ UP order submitted: ${upOrderId}`);
    console.log(`   ✓ DOWN order submitted: ${downOrderId}`);
    console.log(`   ⏳ Waiting for both orders to fill (max ${ORDER_FILL_TIMEOUT_MS / 1000}s)...`);

    // Wait for both orders to fill, place market order for second leg if one fills
    const { upFilled, downFilled, secondLegOrderId, reversed } = await waitForBothOrders(
      upOrderId,
      downOrderId,
      arb.up_token_id,
      arb.down_token_id,
      shares,
      upMaxPrice,
      downMaxPrice
    );

    // Update order IDs if we placed a market order for second leg
    if (secondLegOrderId) {
      if (upFilled && !downFilled) {
        trade.down_order_id = secondLegOrderId;
      } else if (downFilled && !upFilled) {
        trade.up_order_id = secondLegOrderId;
      }
    }

    // Determine final status
    if (reversed) {
      // Position was reversed to avoid exposure
      trade.status = 'failed';
      trade.error = 'Position reversed - could not complete pair';
      console.log(`   ✅ POSITION REVERSED - Avoided directional exposure`);
      console.log(`   📊 Continuing to scan for more opportunities...\n`);
    } else if (upFilled && downFilled) {
      trade.status = 'filled';
      if (secondLegOrderId) {
        console.log(`   ✅ BOTH ORDERS FILLED (used market order for second leg) - Profit locked: $${profitUsd.toFixed(2)}`);
      } else {
        console.log(`   ✅ BOTH ORDERS FILLED - Profit locked: $${profitUsd.toFixed(2)}`);
      }
      
      // Update balance cache (use actual cost, might be slightly higher if market order was used)
      cachedBalance -= costUsd;
      console.log(`   💵 Remaining balance: ~$${cachedBalance.toFixed(2)}`);
      console.log(`   📊 Continuing to scan for more opportunities...\n`);
    } else {
      // This should rarely happen now - we reverse if can't complete
      trade.status = 'failed';
      trade.error = `Could not complete pair - UP=${upFilled ? 'filled' : 'failed'}, DOWN=${downFilled ? 'filled' : 'failed'}`;
      console.log(`   ❌ TRADE FAILED - Could not complete both legs`);
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
