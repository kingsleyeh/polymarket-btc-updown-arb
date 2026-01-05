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
        console.log(`   Minimum shares: ${MIN_SHARES} (Polymarket requirement)`);
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
    }
    else if (shares > liquidityLimit && liquidityLimit < MIN_SHARES) {
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
async function checkOrderStatus(orderId) {
    if (!clobClient)
        return 'unknown';
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
        const orderAny = order;
        const filledSize = parseFloat(orderAny.filledSize || orderAny.filled_size || '0');
        const orderSize = parseFloat(orderAny.size || orderAny.orderSize || '0');
        if (filledSize > 0 && orderSize > 0 && filledSize >= orderSize * 0.95) {
            // 95%+ filled counts as filled
            return 'filled';
        }
        return 'open';
    }
    catch (error) {
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
 * Check actual positions (token balances) to see if we have one-sided exposure
 * Uses the CLOB API /balance endpoint with token_id
 */
async function checkPositions(upTokenId, downTokenId, expectedShares) {
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
    }
    catch (error) {
        // Fallback: try direct API call
        try {
            const [upResp, downResp] = await Promise.all([
                axios.get(`${CLOB_HOST}/balance`, {
                    params: { token_id: upTokenId },
                    timeout: 2000,
                }).catch(() => ({ data: { balance: '0' } })),
                axios.get(`${CLOB_HOST}/balance`, {
                    params: { token_id: downTokenId },
                    timeout: 2000,
                }).catch(() => ({ data: { balance: '0' } })),
            ]);
            const upBal = parseFloat(upResp.data?.balance || '0') / 1_000_000;
            const downBal = parseFloat(downResp.data?.balance || '0') / 1_000_000;
            const hasUp = upBal >= expectedShares * 0.9;
            const hasDown = downBal >= expectedShares * 0.9;
            return { hasUp, hasDown, upBalance: upBal, downBalance: downBal };
        }
        catch (fallbackError) {
            console.error(`   ⚠️ Failed to check positions: ${error.message}`);
            return { hasUp: false, hasDown: false, upBalance: 0, downBalance: 0 };
        }
    }
}
/**
 * Sell/close a position immediately (reverse the filled leg)
 */
async function reversePosition(tokenId, shares) {
    if (!clobClient)
        return false;
    try {
        // Get current price to sell at market
        const priceResp = await axios.get(`${CLOB_HOST}/price`, {
            params: { token_id: tokenId, side: 'sell' },
            timeout: 1000,
        });
        const sellPrice = parseFloat(priceResp.data?.price || '0');
        if (sellPrice === 0)
            return false;
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
    }
    catch (error) {
        console.error(`   ❌ Failed to reverse position: ${error.message}`);
        return false;
    }
}
/**
 * Wait for both orders to fill, IMMEDIATELY place market order for second leg if one fills
 * If can't complete pair, reverse the filled leg to close position
 */
async function waitForBothOrders(upOrderId, downOrderId, upTokenId, downTokenId, shares, maxUpPrice, maxDownPrice) {
    if (!upOrderId || !downOrderId) {
        return { upFilled: false, downFilled: false, secondLegOrderId: null, reversed: false };
    }
    const startTime = Date.now();
    let upFilled = false;
    let downFilled = false;
    let secondLegOrderId = null;
    let marketOrderPlaced = false;
    // Fast polling loop
    let checkCount = 0;
    while (Date.now() - startTime < ORDER_FILL_TIMEOUT_MS) {
        checkCount++;
        // Check both orders in parallel
        if (!upFilled) {
            const upStatus = await checkOrderStatus(upOrderId);
            upFilled = upStatus === 'filled';
            if (upFilled) {
                console.log(`   ✓ UP order FILLED (check #${checkCount})`);
            }
            else if (upStatus !== 'open' && checkCount <= 3) {
                console.log(`   ⚠️ UP order status: ${upStatus} (check #${checkCount})`);
            }
        }
        if (!downFilled) {
            const downStatus = await checkOrderStatus(downOrderId);
            downFilled = downStatus === 'filled';
            if (downFilled) {
                console.log(`   ✓ DOWN order FILLED (check #${checkCount})`);
            }
            else if (downStatus !== 'open' && checkCount <= 3) {
                console.log(`   ⚠️ DOWN order status: ${downStatus} (check #${checkCount})`);
            }
        }
        // If both filled, we're done
        if (upFilled && downFilled) {
            console.log(`   ✅ BOTH ORDERS FILLED after ${checkCount} checks`);
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
                }
                else if (downFilled && !upFilled) {
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
                }
                else if (downFilled && !upFilled) {
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
    const elapsed = Date.now() - startTime;
    console.log(`   ⏱️ Timeout reached (${(elapsed / 1000).toFixed(1)}s) - checking final status...`);
    if (!upFilled) {
        const upStatus = await checkOrderStatus(upOrderId);
        upFilled = upStatus === 'filled';
        console.log(`   Final UP status: ${upStatus} (filled: ${upFilled})`);
    }
    if (!downFilled) {
        const downStatus = await checkOrderStatus(downOrderId);
        downFilled = downStatus === 'filled';
        console.log(`   Final DOWN status: ${downStatus} (filled: ${downFilled})`);
    }
    // Check market order if we placed one
    if (secondLegOrderId) {
        const secondStatus = await checkOrderStatus(secondLegOrderId);
        console.log(`   Final second-leg status: ${secondStatus}`);
        if (upFilled && !downFilled) {
            downFilled = secondStatus === 'filled';
        }
        else if (downFilled && !upFilled) {
            upFilled = secondStatus === 'filled';
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
                if (downOrderId)
                    await cancelOrder(downOrderId);
                if (secondLegOrderId)
                    await cancelOrder(secondLegOrderId);
                // Reverse UP position
                reversed = await reversePosition(upTokenId, shares);
            }
            else if (downFilled && !upFilled) {
                // Cancel any pending orders
                if (upOrderId)
                    await cancelOrder(upOrderId);
                if (secondLegOrderId)
                    await cancelOrder(secondLegOrderId);
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
export async function executeTrade(arb) {
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
    const { shares, reason } = calculateTradeSize(balance, combinedCost, arb.up_shares_available, arb.down_shares_available);
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
    console.log(`   Shares: ${shares} @ $${combinedCost.toFixed(4)}`);
    console.log(`   Cost: $${costUsd.toFixed(2)} | Payout: $${trade.guaranteed_payout.toFixed(2)} | Profit: $${profitUsd.toFixed(2)}`);
    console.log(`   Submitting MARKET-LIKE orders in parallel (no delay)...`);
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
            // One or both orders failed to submit - extract error message
            let upErr = 'Unknown error';
            let downErr = 'Unknown error';
            if ('error' in upResult) {
                const err = upResult.error;
                upErr = err?.data?.error || err?.message || err?.toString() || 'Unknown error';
            }
            if ('error' in downResult) {
                const err = downResult.error;
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
        const { upFilled, downFilled, secondLegOrderId, reversed } = await waitForBothOrders(upOrderId, downOrderId, arb.up_token_id, arb.down_token_id, shares, upMaxPrice, downMaxPrice);
        // CRITICAL: Check actual positions (order status API is unreliable)
        // If order status says "open" but we have positions, we need to handle it
        console.log(`   🔍 Checking actual positions (order status may be stale)...`);
        const positions = await checkPositions(arb.up_token_id, arb.down_token_id, shares);
        console.log(`   Positions: UP=${positions.upBalance.toFixed(1)} shares, DOWN=${positions.downBalance.toFixed(1)} shares`);
        // Determine what actually happened
        const actuallyHasUp = positions.hasUp;
        const actuallyHasDown = positions.hasDown;
        // Update order IDs if we placed a market order for second leg
        if (secondLegOrderId) {
            if (upFilled && !downFilled) {
                trade.down_order_id = secondLegOrderId;
            }
            else if (downFilled && !upFilled) {
                trade.up_order_id = secondLegOrderId;
            }
        }
        // Handle based on ACTUAL positions, not just order status
        if (actuallyHasUp && actuallyHasDown) {
            // Both positions exist - success!
            trade.status = 'filled';
            console.log(`   ✅ BOTH POSITIONS CONFIRMED - Profit locked: $${profitUsd.toFixed(2)}`);
            cachedBalance -= costUsd;
            console.log(`   💵 Remaining balance: ~$${cachedBalance.toFixed(2)}`);
            console.log(`   📊 Continuing to scan for more opportunities...\n`);
        }
        else if (actuallyHasUp && !actuallyHasDown) {
            // Only UP position - REVERSE immediately
            console.log(`   ⚠️ ONE-SIDED EXPOSURE DETECTED: Have ${positions.upBalance.toFixed(0)} UP shares, no DOWN`);
            console.log(`   🔄 REVERSING UP position immediately...`);
            const reversed = await reversePosition(arb.up_token_id, Math.floor(positions.upBalance));
            if (reversed) {
                trade.status = 'failed';
                trade.error = 'Reversed one-sided UP position';
                console.log(`   ✅ UP position reversed - avoided exposure`);
            }
            else {
                trade.status = 'failed';
                trade.error = 'Failed to reverse one-sided UP position';
                console.log(`   ❌ FAILED to reverse UP position - manual intervention needed!`);
            }
            console.log(`   📊 Continuing to scan for more opportunities...\n`);
        }
        else if (!actuallyHasUp && actuallyHasDown) {
            // Only DOWN position - REVERSE immediately
            console.log(`   ⚠️ ONE-SIDED EXPOSURE DETECTED: Have ${positions.downBalance.toFixed(0)} DOWN shares, no UP`);
            console.log(`   🔄 REVERSING DOWN position immediately...`);
            const reversed = await reversePosition(arb.down_token_id, Math.floor(positions.downBalance));
            if (reversed) {
                trade.status = 'failed';
                trade.error = 'Reversed one-sided DOWN position';
                console.log(`   ✅ DOWN position reversed - avoided exposure`);
            }
            else {
                trade.status = 'failed';
                trade.error = 'Failed to reverse one-sided DOWN position';
                console.log(`   ❌ FAILED to reverse DOWN position - manual intervention needed!`);
            }
            console.log(`   📊 Continuing to scan for more opportunities...\n`);
        }
        else {
            // Neither position - orders didn't fill or were cancelled
            trade.status = 'failed';
            trade.error = `No positions detected - orders may not have filled`;
            console.log(`   ❌ No positions detected - orders likely didn't fill`);
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