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
// ============ CONFIGURATION ============
const TRADE_SIZE_PERCENT = 0.10; // 10% of available balance per trade
const MIN_TRADE_SIZE_USD = 2; // Minimum $2 per trade
const MAX_LIQUIDITY_PERCENT = 0.30; // Don't take more than 30% of available liquidity
const MAX_COMBINED_COST = 0.99; // Maximum acceptable combined cost (reject if exceeds)
const MARKET_ORDER_SLIPPAGE = 0.02; // 2% - use aggressive limit prices that act like market orders
const PRICE_VERIFY_TOLERANCE = 0.02; // 2% - reject if price moved more than this
const ORDER_FILL_TIMEOUT_MS = 3000; // 3 seconds to wait for both orders to fill
const ORDER_CHECK_INTERVAL_MS = 200; // Check order status every 200ms
const SECOND_LEG_TIMEOUT_MS = 2000; // If one fills, wait 2s for other, then market order
// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
// Client singleton
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
let lastBalanceUpdate = 0;
const BALANCE_CACHE_MS = 30000; // Cache balance for 30 seconds
const executedTrades = [];
/**
 * Initialize the CLOB client with wallet
 */
export async function initializeTrader() {
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
        clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, signatureType, funder);
        // Get initial balance
        await updateBalance();
        console.log(`\n📊 SIZING CONFIG:`);
        console.log(`   Trade size: ${(TRADE_SIZE_PERCENT * 100).toFixed(0)}% of balance`);
        console.log(`   Min per trade: $${MIN_TRADE_SIZE_USD}`);
        console.log(`   Max liquidity take: ${(MAX_LIQUIDITY_PERCENT * 100).toFixed(0)}%`);
        console.log(`   Market order slippage: ${(MARKET_ORDER_SLIPPAGE * 100).toFixed(1)}%`);
        return true;
    }
    catch (error) {
        console.error('Failed to initialize trader:', error.message);
        return false;
    }
}
/**
 * Update cached balance
 */
async function updateBalance() {
    if (!clobClient)
        return 0;
    try {
        const balance = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        cachedBalance = parseFloat(balance.balance || '0') / 1_000_000;
        lastBalanceUpdate = Date.now();
        console.log(`Balance: $${cachedBalance.toFixed(2)} USDC`);
        return cachedBalance;
    }
    catch (error) {
        console.warn(`Could not fetch balance: ${error.message}`);
        return cachedBalance;
    }
}
/**
 * Get current balance (cached)
 */
export async function getBalance() {
    if (Date.now() - lastBalanceUpdate > BALANCE_CACHE_MS) {
        return await updateBalance();
    }
    return cachedBalance;
}
/**
 * Fetch current prices to verify they haven't moved (fast verification)
 */
async function verifyPricesAndLiquidity(upTokenId, downTokenId, expectedUpPrice, expectedDownPrice, cachedUpLiquidity, cachedDownLiquidity) {
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
    }
    catch (error) {
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
function calculateTradeSize(balance, combinedCost, upLiquidity, downLiquidity) {
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
async function checkOrderStatus(orderId) {
    if (!clobClient)
        return 'unknown';
    try {
        const order = await clobClient.getOrder(orderId);
        if (!order)
            return 'unknown';
        // Check order status
        if (order.status === 'FILLED' || order.status === 'filled') {
            return 'filled';
        }
        if (order.status === 'CANCELLED' || order.status === 'cancelled') {
            return 'cancelled';
        }
        return 'open';
    }
    catch (error) {
        // If order not found, might be filled or cancelled
        return 'unknown';
    }
}
/**
 * Cancel an order
 */
async function cancelOrder(orderId) {
    if (!clobClient)
        return false;
    try {
        await clobClient.cancelOrder({ orderID: orderId });
        return true;
    }
    catch (error) {
        console.error(`   Failed to cancel order ${orderId}: ${error.message}`);
        return false;
    }
}
/**
 * Place market order (aggressive limit that acts like market)
 */
async function placeMarketOrder(tokenId, size, side, maxPrice) {
    if (!clobClient)
        return null;
    try {
        // Use very aggressive limit price (maxPrice) - will fill immediately if liquidity exists
        const order = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: maxPrice, // Set to max acceptable price - acts like market order
            size: size,
            side: side,
        });
        return order.orderID || null;
    }
    catch (error) {
        console.error(`   Market order failed: ${error.message}`);
        return null;
    }
}
/**
 * Wait for both orders to fill, place market order for second leg if one fills
 */
async function waitForBothOrders(upOrderId, downOrderId, upTokenId, downTokenId, shares, maxUpPrice, maxDownPrice) {
    if (!upOrderId || !downOrderId) {
        return { upFilled: false, downFilled: false, secondLegOrderId: null };
    }
    const startTime = Date.now();
    let upFilled = false;
    let downFilled = false;
    let secondLegOrderId = null;
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
            return { upFilled: true, downFilled: true, secondLegOrderId: null };
        }
        // If one filled but other didn't, wait a bit then place market order for second leg
        if ((upFilled && !downFilled) || (!upFilled && downFilled)) {
            const waitTime = Date.now() - startTime;
            if (waitTime >= SECOND_LEG_TIMEOUT_MS) {
                // Time to place market order for the unfilled leg
                if (upFilled && !downFilled) {
                    console.log(`   ⚠️ UP filled but DOWN didn't - placing MARKET order for DOWN leg...`);
                    secondLegOrderId = await placeMarketOrder(downTokenId, shares, Side.BUY, maxDownPrice);
                    if (secondLegOrderId) {
                        console.log(`   ✓ Market order placed for DOWN: ${secondLegOrderId}`);
                        // Wait a moment for market order to fill
                        await new Promise(r => setTimeout(r, 1000));
                        const downStatus = await checkOrderStatus(secondLegOrderId);
                        downFilled = downStatus === 'filled';
                    }
                }
                else if (downFilled && !upFilled) {
                    console.log(`   ⚠️ DOWN filled but UP didn't - placing MARKET order for UP leg...`);
                    secondLegOrderId = await placeMarketOrder(upTokenId, shares, Side.BUY, maxUpPrice);
                    if (secondLegOrderId) {
                        console.log(`   ✓ Market order placed for UP: ${secondLegOrderId}`);
                        // Wait a moment for market order to fill
                        await new Promise(r => setTimeout(r, 1000));
                        const upStatus = await checkOrderStatus(secondLegOrderId);
                        upFilled = upStatus === 'filled';
                    }
                }
                // If we placed market order, return result
                if (secondLegOrderId) {
                    return { upFilled, downFilled, secondLegOrderId };
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
    // If still only one filled, place market order for the other
    if (upFilled && !downFilled && !secondLegOrderId) {
        console.log(`   ⚠️ Timeout - UP filled but DOWN didn't - placing MARKET order for DOWN...`);
        secondLegOrderId = await placeMarketOrder(downTokenId, shares, Side.BUY, maxDownPrice);
        if (secondLegOrderId) {
            await new Promise(r => setTimeout(r, 1000));
            const downStatus = await checkOrderStatus(secondLegOrderId);
            downFilled = downStatus === 'filled';
        }
    }
    else if (downFilled && !upFilled && !secondLegOrderId) {
        console.log(`   ⚠️ Timeout - DOWN filled but UP didn't - placing MARKET order for UP...`);
        secondLegOrderId = await placeMarketOrder(upTokenId, shares, Side.BUY, maxUpPrice);
        if (secondLegOrderId) {
            await new Promise(r => setTimeout(r, 1000));
            const upStatus = await checkOrderStatus(secondLegOrderId);
            upFilled = upStatus === 'filled';
        }
    }
    // Cancel original unfilled orders if we placed market orders
    if (secondLegOrderId) {
        if (!upFilled && upOrderId) {
            await cancelOrder(upOrderId);
        }
        if (!downFilled && downOrderId) {
            await cancelOrder(downOrderId);
        }
    }
    return { upFilled, downFilled, secondLegOrderId };
}
/**
 * Execute arbitrage trade - buy both Up and Down in PARALLEL
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet) {
        console.error('Trader not initialized');
        return null;
    }
    const now = Date.now();
    // Step 1: Fast price verification (use cached liquidity from scan)
    console.log(`\n🔍 VERIFYING PRICES (fast)...`);
    const verification = await verifyPricesAndLiquidity(arb.up_token_id, arb.down_token_id, arb.up_price, arb.down_price, arb.up_shares_available, // Use cached liquidity from scan
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
    const { shares, reason } = calculateTradeSize(balance, combinedCost, verification.upLiquidity, verification.downLiquidity);
    if (shares < 1) {
        console.log(`   ❌ Cannot trade: ${reason}`);
        return null;
    }
    const costUsd = shares * combinedCost;
    const profitUsd = shares * (1.0 - combinedCost);
    console.log(`   ✓ Size: ${shares} shares (${reason})`);
    // Step 3: Prepare trade record
    const trade = {
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
        const upOrderId = upResult && !('error' in upResult) ? upResult.orderID : null;
        const downOrderId = downResult && !('error' in downResult) ? downResult.orderID : null;
        if (!upOrderId || !downOrderId) {
            // One or both orders failed to submit
            const upErr = ('error' in upResult) ? upResult.error.message : 'No order ID';
            const downErr = ('error' in downResult) ? downResult.error.message : 'No order ID';
            if (!upOrderId)
                console.error(`   ❌ UP order submission failed: ${upErr}`);
            if (!downOrderId)
                console.error(`   ❌ DOWN order submission failed: ${downErr}`);
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
        // Wait for both orders to fill, place market order for second leg if one fills
        const { upFilled, downFilled, secondLegOrderId } = await waitForBothOrders(upOrderId, downOrderId, arb.up_token_id, arb.down_token_id, shares, upMaxPrice, downMaxPrice);
        // Update order IDs if we placed a market order for second leg
        if (secondLegOrderId) {
            if (upFilled && !downFilled) {
                trade.down_order_id = secondLegOrderId;
            }
            else if (downFilled && !upFilled) {
                trade.up_order_id = secondLegOrderId;
            }
        }
        // Determine final status
        if (upFilled && downFilled) {
            trade.status = 'filled';
            if (secondLegOrderId) {
                console.log(`   ✅ BOTH ORDERS FILLED (used market order for second leg) - Profit locked: $${profitUsd.toFixed(2)}`);
            }
            else {
                console.log(`   ✅ BOTH ORDERS FILLED - Profit locked: $${profitUsd.toFixed(2)}`);
            }
            // Update balance cache (use actual cost, might be slightly higher if market order was used)
            cachedBalance -= costUsd;
            console.log(`   💵 Remaining balance: ~$${cachedBalance.toFixed(2)}`);
            console.log(`   📊 Continuing to scan for more opportunities...\n`);
        }
        else {
            // Still partial - this shouldn't happen often with market orders
            trade.status = 'partial';
            trade.error = `Partial fill - UP=${upFilled ? 'filled' : 'failed'}, DOWN=${downFilled ? 'filled' : 'failed'}`;
            console.log(`   ⚠️ PARTIAL FILL - One side still not filled (unusual with market orders)`);
            console.log(`   📊 Continuing to scan for more opportunities...\n`);
        }
    }
    catch (error) {
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
export function getExecutedTrades() {
    return [...executedTrades];
}
/**
 * Get execution stats
 */
export function getExecutionStats() {
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
        }
        else if (trade.status === 'failed') {
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
export function isTraderReady() {
    return clobClient !== null && wallet !== null;
}
//# sourceMappingURL=trader.js.map