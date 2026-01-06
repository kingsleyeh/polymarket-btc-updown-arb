/**
 * SIMPLE LIMIT ORDER EXECUTION
 *
 * Place both orders, wait for fills, verify positions
 * No FAK, no race conditions, no stale position checks
 */
import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
const MIN_SHARES = 5;
const FILL_WAIT_MS = 3000; // Wait for orders to fill
const SETTLE_WAIT_MS = 2000; // Wait for position to settle
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
const completedMarkets = new Set();
const blockedMarkets = new Set();
const executedTrades = [];
export function canTradeMarket(marketId) {
    return !completedMarkets.has(marketId) && !blockedMarkets.has(marketId);
}
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
        console.log(`Signer: ${wallet.address}`);
        console.log(`Funder: ${funder || 'not set'}`);
        const basicClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
        const creds = await basicClient.createOrDeriveApiKey();
        console.log(`API Key: ${creds.key?.slice(0, 8)}...`);
        clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, signatureType, funder);
        const balance = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        cachedBalance = parseFloat(balance.balance || '0') / 1_000_000;
        console.log(`Balance: $${cachedBalance.toFixed(2)} USDC`);
        return true;
    }
    catch (error) {
        console.error('Init failed:', error.message);
        return false;
    }
}
async function getPosition(tokenId) {
    if (!clobClient)
        return 0;
    try {
        const bal = await clobClient.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
        return Math.floor(parseFloat(bal.balance || '0') / 1_000_000);
    }
    catch {
        return 0;
    }
}
async function getBothPositions(upTokenId, downTokenId) {
    const [up, down] = await Promise.all([
        getPosition(upTokenId),
        getPosition(downTokenId)
    ]);
    return { up, down };
}
async function cancelAllOrders() {
    if (!clobClient)
        return;
    try {
        const openOrders = await clobClient.getOpenOrders();
        if (openOrders && openOrders.length > 0) {
            console.log(`   🧹 Cancelling ${openOrders.length} orders...`);
            await clobClient.cancelAll();
        }
    }
    catch { }
}
/**
 * Place a LIMIT order at specified price - GTC (stays until filled/cancelled)
 */
async function placeLimitBuy(tokenId, shares, price, label) {
    if (!clobClient)
        return null;
    console.log(`   📥 ${label}: LIMIT BUY ${shares} @ $${price.toFixed(3)}`);
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: price,
            size: shares,
            side: Side.BUY,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        if (result && result.orderID) {
            console.log(`   ✓ ${label}: Order placed (${result.orderID.slice(0, 8)}...)`);
            return result.orderID;
        }
        console.log(`   ❌ ${label}: Failed to place order`);
        return null;
    }
    catch (error) {
        const errMsg = error?.data?.error || error?.message || 'Unknown';
        console.log(`   ❌ ${label}: ${errMsg}`);
        return null;
    }
}
/**
 * Check if order is filled by looking at open orders
 */
async function isOrderFilled(orderId) {
    if (!clobClient || !orderId)
        return false;
    try {
        const openOrders = await clobClient.getOpenOrders();
        // If order is NOT in open orders, it was filled (or cancelled)
        return !openOrders.some(o => o.id === orderId);
    }
    catch {
        return false;
    }
}
/**
 * MARKET SELL using limit order at low price
 */
async function sellPosition(tokenId, shares, label) {
    if (!clobClient || shares <= 0)
        return true;
    console.log(`   📤 ${label}: SELL ${shares} shares`);
    // Wait for settlement first
    await new Promise(r => setTimeout(r, SETTLE_WAIT_MS));
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: 0.01, // Sell at any price (market sell)
            size: shares,
            side: Side.SELL,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        if (result && result.orderID) {
            console.log(`   ✓ ${label}: Sell order placed`);
            // Wait for fill
            await new Promise(r => setTimeout(r, FILL_WAIT_MS));
            const remaining = await getPosition(tokenId);
            if (remaining === 0) {
                console.log(`   ✅ ${label}: Sold all`);
                return true;
            }
            else {
                console.log(`   ⚠️ ${label}: ${remaining} remaining`);
                return remaining < shares; // Partial success
            }
        }
        return false;
    }
    catch (error) {
        console.log(`   ❌ ${label}: ${error.message}`);
        return false;
    }
}
/**
 * MAIN EXECUTION
 *
 * 1. Place BOTH limit orders simultaneously at detected prices
 * 2. Wait for fills
 * 3. Verify final positions match
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet)
        return null;
    if (completedMarkets.has(arb.market_id) || blockedMarkets.has(arb.market_id))
        return null;
    const startTime = Date.now();
    const trade = {
        id: `trade-${Date.now()}`,
        market_id: arb.market_id,
        shares: 0,
        status: 'failed',
        has_exposure: false,
        can_retry: true,
    };
    // STEP 1: Cancel any existing orders
    await cancelAllOrders();
    // STEP 2: Check starting positions
    const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (startPos.up > 0 || startPos.down > 0) {
        console.log(`   ⚠️ Existing position: ${startPos.up} UP, ${startPos.down} DOWN`);
        if (startPos.up === startPos.down && startPos.up >= MIN_SHARES) {
            console.log(`   ✅ Already have balanced position!`);
            completedMarkets.add(arb.market_id);
            trade.status = 'filled';
            trade.shares = startPos.up;
            trade.can_retry = false;
            executedTrades.push(trade);
            return trade;
        }
        // Try to sell imbalanced positions
        console.log(`   🔄 Clearing existing positions...`);
        if (startPos.up > 0)
            await sellPosition(arb.up_token_id, startPos.up, 'UP');
        if (startPos.down > 0)
            await sellPosition(arb.down_token_id, startPos.down, 'DOWN');
        const afterClear = await getBothPositions(arb.up_token_id, arb.down_token_id);
        if (afterClear.up > 0 || afterClear.down > 0) {
            console.log(`   🚨 Could not clear positions: ${afterClear.up} UP, ${afterClear.down} DOWN`);
            blockedMarkets.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = 'Could not clear existing positions';
            executedTrades.push(trade);
            return trade;
        }
    }
    // STEP 3: Place BOTH orders at the SAME TIME
    // Use detected prices + 2% buffer to ensure fills
    const upPrice = Math.min(0.99, arb.up_price * 1.02);
    const downPrice = Math.min(0.99, arb.down_price * 1.02);
    console.log(`\n   ⚡ PLACING ORDERS: ${MIN_SHARES} shares each`);
    console.log(`   💰 Cost: $${(upPrice * MIN_SHARES).toFixed(2)} + $${(downPrice * MIN_SHARES).toFixed(2)} = $${((upPrice + downPrice) * MIN_SHARES).toFixed(2)}`);
    const [upOrderId, downOrderId] = await Promise.all([
        placeLimitBuy(arb.up_token_id, MIN_SHARES, upPrice, 'UP'),
        placeLimitBuy(arb.down_token_id, MIN_SHARES, downPrice, 'DOWN')
    ]);
    // STEP 4: If either order failed to place, cancel everything
    if (!upOrderId || !downOrderId) {
        console.log(`   ❌ Order placement failed`);
        await cancelAllOrders();
        trade.error = 'Order placement failed';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // STEP 5: Wait for orders to fill
    console.log(`   ⏳ Waiting ${FILL_WAIT_MS}ms for fills...`);
    await new Promise(r => setTimeout(r, FILL_WAIT_MS));
    // STEP 6: Check fill status
    const [upFilled, downFilled] = await Promise.all([
        isOrderFilled(upOrderId),
        isOrderFilled(downOrderId)
    ]);
    console.log(`   📊 Fill status: UP=${upFilled ? 'FILLED' : 'PENDING'}, DOWN=${downFilled ? 'FILLED' : 'PENDING'}`);
    // STEP 7: Cancel any unfilled orders
    await cancelAllOrders();
    // STEP 8: Wait a bit more for positions to settle, then verify
    await new Promise(r => setTimeout(r, SETTLE_WAIT_MS));
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    const totalTime = Date.now() - startTime;
    console.log(`\n   📊 FINAL POSITIONS: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms)`);
    // STEP 9: Evaluate results
    // SUCCESS: Equal positions
    if (finalPos.up === finalPos.down && finalPos.up >= MIN_SHARES) {
        console.log(`   ✅✅ SUCCESS! ${finalPos.up} shares each side`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // NOTHING: No fills
    if (finalPos.up === 0 && finalPos.down === 0) {
        console.log(`   ⚠️ No fills - can retry`);
        trade.error = 'No fills';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // PARTIAL: Imbalanced - try to balance by selling excess
    console.log(`   ⚖️ Imbalanced - attempting to balance...`);
    const minPos = Math.min(finalPos.up, finalPos.down);
    if (minPos > 0) {
        // We have SOME of both - sell the excess
        if (finalPos.up > finalPos.down) {
            const excess = finalPos.up - finalPos.down;
            console.log(`   📤 Selling ${excess} excess UP`);
            await sellPosition(arb.up_token_id, excess, 'UP');
        }
        else {
            const excess = finalPos.down - finalPos.up;
            console.log(`   📤 Selling ${excess} excess DOWN`);
            await sellPosition(arb.down_token_id, excess, 'DOWN');
        }
        const balancedPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
        if (balancedPos.up === balancedPos.down && balancedPos.up > 0) {
            console.log(`   ✅ Balanced! ${balancedPos.up} shares each`);
            completedMarkets.add(arb.market_id);
            trade.status = 'filled';
            trade.shares = balancedPos.up;
            trade.can_retry = false;
            executedTrades.push(trade);
            return trade;
        }
    }
    // ONE-SIDED: Only one side filled - sell it and retry
    console.log(`   🔄 One-sided fill - selling all to reset`);
    if (finalPos.up > 0)
        await sellPosition(arb.up_token_id, finalPos.up, 'UP');
    if (finalPos.down > 0)
        await sellPosition(arb.down_token_id, finalPos.down, 'DOWN');
    const resetPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (resetPos.up === 0 && resetPos.down === 0) {
        console.log(`   ✅ Reset to 0 - can retry`);
        trade.error = 'One-sided fill, reset';
        trade.can_retry = true;
    }
    else {
        console.log(`   🚨 Could not reset: ${resetPos.up} UP, ${resetPos.down} DOWN`);
        blockedMarkets.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.error = 'Could not reset positions';
    }
    executedTrades.push(trade);
    return trade;
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
export function isTraderReady() {
    return clobClient !== null && wallet !== null;
}
export async function getBalance() {
    return cachedBalance;
}
//# sourceMappingURL=trader.js.map