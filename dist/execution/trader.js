/**
 * ULTRA-LOW LATENCY Execution
 *
 * Scanner already fetched order book - USE THOSE PRICES
 * Place orders IMMEDIATELY - no redundant API calls
 */
import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
// Configuration
const MIN_SHARES = 5;
const FILL_TIMEOUT_MS = 2000;
const POSITION_CHECK_INTERVAL_MS = 100;
const SETTLEMENT_WAIT_MS = 2000;
// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
// Client
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
// Track markets
const brokenMarkets = new Set();
const completedMarkets = new Set();
const executedTrades = [];
export function canTradeMarket(marketId) {
    return !brokenMarkets.has(marketId) && !completedMarkets.has(marketId);
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
/**
 * Place order - fire and forget style
 */
async function placeOrder(tokenId, shares, price, label) {
    if (!clobClient)
        return null;
    // Add tiny buffer to take the ask
    const takePrice = Math.min(price + 0.005, 0.99);
    try {
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: takePrice,
            size: shares,
            side: Side.BUY,
        }).catch(e => ({ error: e }));
        return result && !('error' in result) ? result.orderID : null;
    }
    catch {
        return null;
    }
}
async function cancelOrder(orderId) {
    if (!clobClient)
        return;
    try {
        await clobClient.cancelOrder({ orderID: orderId });
    }
    catch { }
}
async function marketSell(tokenId, shares, label) {
    if (!clobClient || shares <= 0)
        return true;
    console.log(`   📤 SELLING ${shares} ${label} (waiting for settlement)...`);
    await new Promise(r => setTimeout(r, SETTLEMENT_WAIT_MS));
    try {
        console.log(`   📤 Placing SELL order for ${shares} ${label} @ $0.01...`);
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: 0.01,
            size: shares,
            side: Side.SELL, // SELL not BUY!
        }).catch(e => ({ error: e }));
        if (result && !('error' in result)) {
            const orderId = result.orderID;
            console.log(`   ✓ Sell order placed: ${orderId}`);
            await new Promise(r => setTimeout(r, 1500));
            const remaining = await getPosition(tokenId);
            console.log(`   📊 ${label} remaining: ${remaining}`);
            return remaining === 0;
        }
        else {
            const err = result?.error;
            console.log(`   ❌ Sell failed: ${err?.data?.error || err?.message || 'Unknown'}`);
            return false;
        }
    }
    catch (e) {
        console.log(`   ❌ Sell error: ${e.message}`);
        return false;
    }
}
async function reverseToZero(upTokenId, downTokenId) {
    // First cancel any open orders that might fill while we're reversing
    await cancelAllOrders();
    const pos = await getBothPositions(upTokenId, downTokenId);
    console.log(`   🔄 Need to sell: ${pos.up} UP, ${pos.down} DOWN`);
    // Sell sequentially to avoid confusion
    if (pos.up > 0) {
        await marketSell(upTokenId, pos.up, 'UP');
    }
    if (pos.down > 0) {
        await marketSell(downTokenId, pos.down, 'DOWN');
    }
    // Cancel again in case anything snuck through
    await cancelAllOrders();
    const final = await getBothPositions(upTokenId, downTokenId);
    const success = final.up === 0 && final.down === 0;
    console.log(success ? `   ✅ Reversed to 0` : `   ❌ Still have: ${final.up} UP, ${final.down} DOWN`);
    return success;
}
/**
 * Cancel ALL open orders for a token
 */
async function cancelAllOrders() {
    if (!clobClient)
        return;
    try {
        const openOrders = await clobClient.getOpenOrders();
        if (openOrders && openOrders.length > 0) {
            console.log(`   🧹 Cancelling ${openOrders.length} stale orders...`);
            await Promise.all(openOrders.map(o => cancelOrder(o.id)));
        }
    }
    catch { }
}
/**
 * FAST EXECUTE - Use scanner prices directly, no redundant fetches
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet)
        return null;
    if (brokenMarkets.has(arb.market_id) || completedMarkets.has(arb.market_id))
        return null;
    // FIRST: Cancel any stale orders from previous attempts
    await cancelAllOrders();
    const startTime = Date.now();
    const trade = {
        id: `trade-${Date.now()}`,
        market_id: arb.market_id,
        shares: 0,
        status: 'failed',
        has_exposure: false,
        can_retry: true,
    };
    // ===== IMMEDIATE ORDER PLACEMENT =====
    // Scanner already verified prices - JUST EXECUTE
    const totalCost = (arb.up_price + arb.down_price) * MIN_SHARES;
    console.log(`\n   ⚡ FAST EXECUTE: ${MIN_SHARES} shares @ $${arb.combined_cost.toFixed(3)}`);
    console.log(`   UP: $${arb.up_price.toFixed(3)} | DOWN: $${arb.down_price.toFixed(3)} | Cost: $${totalCost.toFixed(2)}`);
    // Place BOTH orders simultaneously - no waiting
    const orderPromises = Promise.all([
        placeOrder(arb.down_token_id, MIN_SHARES, arb.down_price, 'DOWN'),
        placeOrder(arb.up_token_id, MIN_SHARES, arb.up_price, 'UP')
    ]);
    const [downOrderId, upOrderId] = await orderPromises;
    const orderTime = Date.now() - startTime;
    console.log(`   📨 Orders placed in ${orderTime}ms`);
    if (!downOrderId && !upOrderId) {
        console.log(`   ❌ Both orders failed`);
        trade.error = 'Both orders failed';
        executedTrades.push(trade);
        return trade;
    }
    // Wait for fills
    await new Promise(r => setTimeout(r, FILL_TIMEOUT_MS));
    // Cancel unfilled
    await Promise.all([
        downOrderId ? cancelOrder(downOrderId) : null,
        upOrderId ? cancelOrder(upOrderId) : null
    ]);
    // Check result
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    const totalTime = Date.now() - startTime;
    console.log(`   📊 Result: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms total)`);
    // SUCCESS
    if (finalPos.up === finalPos.down && finalPos.up > 0) {
        const profit = finalPos.up * (1 - arb.combined_cost);
        console.log(`   ✅ SUCCESS! ${finalPos.up} each | Profit: ~$${profit.toFixed(2)}`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // ZERO - can retry
    if (finalPos.up === 0 && finalPos.down === 0) {
        console.log(`   ⚠️ No fills - retrying...`);
        trade.error = 'No fills';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // IMBALANCED - auto reverse
    console.log(`   🚨 Imbalanced - reversing...`);
    if (await reverseToZero(arb.up_token_id, arb.down_token_id)) {
        trade.error = 'Reversed';
        trade.can_retry = true;
    }
    else {
        brokenMarkets.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.error = 'Reversal failed';
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