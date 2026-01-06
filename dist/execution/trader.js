/**
 * SEQUENTIAL Execution - ONLY way to guarantee UP = DOWN
 *
 * 1. Place DOWN order, wait for fill
 * 2. Check EXACTLY how many DOWN we got
 * 3. Place UP order for EXACTLY that amount
 * 4. If imbalanced, reverse to 0
 */
import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
// Configuration
const MIN_SHARES = 5;
const FILL_TIMEOUT_MS = 2000;
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
async function cancelAllOrders() {
    if (!clobClient)
        return;
    try {
        const openOrders = await clobClient.getOpenOrders();
        if (openOrders && openOrders.length > 0) {
            console.log(`   🧹 Cancelling ${openOrders.length} open orders...`);
            await Promise.all(openOrders.map(o => clobClient.cancelOrder({ orderID: o.id })));
            // Wait for cancellations to propagate
            await new Promise(r => setTimeout(r, 500));
        }
    }
    catch { }
}
async function placeAndWaitForFill(tokenId, shares, price, label) {
    if (!clobClient)
        return 0;
    const takePrice = Math.min(price + 0.01, 0.99);
    const startPos = await getPosition(tokenId);
    console.log(`   📥 ${label}: Buying ${shares} @ $${takePrice.toFixed(3)} (start: ${startPos})...`);
    try {
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: takePrice,
            size: shares,
            side: Side.BUY,
        }).catch(e => ({ error: e }));
        const orderId = result && !('error' in result) ? result.orderID : null;
        if (!orderId) {
            const err = result?.error;
            console.log(`   ❌ ${label} order failed: ${err?.data?.error || err?.message || 'Unknown'}`);
            return 0;
        }
        console.log(`   ⏳ ${label}: Order placed, waiting...`);
        // Wait for order to process, then cancel unfilled portion
        await new Promise(r => setTimeout(r, FILL_TIMEOUT_MS));
        // Cancel any remaining
        try {
            await clobClient.cancelOrder({ orderID: orderId });
        }
        catch { }
        // Check order status to see how much filled
        let filledFromOrder = 0;
        try {
            const order = await clobClient.getOrder(orderId);
            if (order) {
                const sizeFilled = parseFloat(order.size_matched || '0');
                filledFromOrder = Math.floor(sizeFilled);
                console.log(`   📋 ${label}: Order status says ${filledFromOrder} filled`);
            }
        }
        catch (e) {
            console.log(`   ⚠️ Could not get order status`);
        }
        // ALSO check position (belt and suspenders)
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s for balance to update
        const finalPos = await getPosition(tokenId);
        const filledFromPos = finalPos - startPos;
        // Use the HIGHER of the two (order status vs position)
        const filled = Math.max(filledFromOrder, filledFromPos);
        console.log(`   📊 ${label}: Order says ${filledFromOrder}, Position says ${filledFromPos}, using ${filled}`);
        return filled;
    }
    catch (error) {
        console.log(`   ❌ ${label} error: ${error.message}`);
        return 0;
    }
}
async function marketSell(tokenId, shares, label) {
    if (!clobClient || shares <= 0)
        return true;
    console.log(`   📤 Selling ${shares} ${label}...`);
    await new Promise(r => setTimeout(r, SETTLEMENT_WAIT_MS));
    try {
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: 0.01,
            size: shares,
            side: Side.SELL,
        }).catch(e => ({ error: e }));
        if (result && !('error' in result)) {
            await new Promise(r => setTimeout(r, 1500));
            const remaining = await getPosition(tokenId);
            console.log(`   ${remaining === 0 ? '✓' : '❌'} ${label}: ${remaining} remaining`);
            return remaining === 0;
        }
        return false;
    }
    catch {
        return false;
    }
}
async function reverseToZero(upTokenId, downTokenId) {
    await cancelAllOrders();
    const pos = await getBothPositions(upTokenId, downTokenId);
    console.log(`   🔄 Reversing: ${pos.up} UP, ${pos.down} DOWN`);
    if (pos.up > 0)
        await marketSell(upTokenId, pos.up, 'UP');
    if (pos.down > 0)
        await marketSell(downTokenId, pos.down, 'DOWN');
    await cancelAllOrders();
    const final = await getBothPositions(upTokenId, downTokenId);
    return final.up === 0 && final.down === 0;
}
/**
 * SEQUENTIAL EXECUTE - Guarantees UP = DOWN
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet)
        return null;
    if (brokenMarkets.has(arb.market_id) || completedMarkets.has(arb.market_id))
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
    // Cancel any stale orders first
    await cancelAllOrders();
    // Check starting position
    const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    // If already imbalanced, reverse first
    if (startPos.up !== startPos.down) {
        console.log(`   ⚠️ Pre-existing imbalance: ${startPos.up} UP, ${startPos.down} DOWN`);
        if (!await reverseToZero(arb.up_token_id, arb.down_token_id)) {
            brokenMarkets.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = 'Could not reverse pre-existing imbalance';
            executedTrades.push(trade);
            return trade;
        }
    }
    console.log(`\n   ⚡ SEQUENTIAL: DOWN first, then match UP`);
    console.log(`   Target: ${MIN_SHARES} shares @ $${arb.combined_cost.toFixed(3)}`);
    // ===== STEP 1: Buy DOWN =====
    const downFilled = await placeAndWaitForFill(arb.down_token_id, MIN_SHARES, arb.down_price, 'DOWN');
    if (downFilled === 0) {
        console.log(`   ⚠️ No DOWN fills - can retry`);
        trade.error = 'DOWN did not fill';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // ===== STEP 2: Buy EXACT same amount of UP =====
    console.log(`   📊 Got ${downFilled} DOWN - now buying ${downFilled} UP to match`);
    const upFilled = await placeAndWaitForFill(arb.up_token_id, downFilled, arb.up_price, 'UP');
    // ===== CHECK RESULT =====
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    const totalTime = Date.now() - startTime;
    console.log(`\n   📊 FINAL: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms)`);
    // SUCCESS: Equal positions
    if (finalPos.up === finalPos.down && finalPos.up > 0) {
        const profit = finalPos.up * (1 - arb.combined_cost);
        console.log(`   ✅✅ SUCCESS! ${finalPos.up} each | Profit: ~$${profit.toFixed(2)}`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // IMBALANCED: Reverse to 0
    console.log(`   🚨 Imbalanced! Reversing...`);
    if (await reverseToZero(arb.up_token_id, arb.down_token_id)) {
        console.log(`   ✓ Reversed to 0 - can retry`);
        trade.error = 'Imbalanced, reversed';
        trade.can_retry = true;
    }
    else {
        console.log(`   ❌ Reversal failed - manual fix needed`);
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