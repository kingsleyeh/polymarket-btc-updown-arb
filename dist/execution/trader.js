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
// Configuration
const MIN_SHARES = 5;
const MAX_COMBINED_COST = 0.99;
const FILL_TIMEOUT_MS = 3000;
const POSITION_CHECK_INTERVAL_MS = 200;
const PRICE_BUFFER = 0.15; // 15% above market
// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
// Client
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
// Track markets with UNEQUAL exposure - these can NEVER be retried
const marketsWithExposure = new Set();
// Track markets we've successfully completed
const completedMarkets = new Set();
const executedTrades = [];
/**
 * Check if market can be traded
 * Returns: true if we can attempt, false if blocked
 */
export function canTradeMarket(marketId) {
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
        console.log(`\n📊 Strategy: DOWN first, then UP (sequential)`);
        console.log(`   Retry: YES if 0 exposure, NO if unequal exposure`);
        return true;
    }
    catch (error) {
        console.error('Init failed:', error.message);
        return false;
    }
}
/**
 * Check token position
 */
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
/**
 * Get both positions
 */
async function getBothPositions(upTokenId, downTokenId) {
    const [up, down] = await Promise.all([
        getPosition(upTokenId),
        getPosition(downTokenId)
    ]);
    return { up, down };
}
/**
 * Cancel order (best effort)
 */
async function cancelOrder(orderId) {
    if (!clobClient)
        return;
    try {
        await clobClient.cancelOrder({ orderID: orderId });
    }
    catch { }
}
/**
 * Wait for position to appear
 */
async function waitForPosition(tokenId, minShares, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pos = await getPosition(tokenId);
        if (pos >= minShares)
            return pos;
        await new Promise(r => setTimeout(r, POSITION_CHECK_INTERVAL_MS));
    }
    return await getPosition(tokenId);
}
/**
 * Execute trade - with smart retry logic
 */
export async function executeTrade(arb) {
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
    const trade = {
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
        const downOrderId = downResult && !('error' in downResult) ? downResult.orderID : null;
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
            }
            else {
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
        const upOrderId = upResult && !('error' in upResult) ? upResult.orderID : null;
        if (!upOrderId) {
            console.log(`   ❌ UP order failed to submit`);
            console.log(`   🚨 Have ${afterDown.down} DOWN, ${afterDown.up} UP!`);
            marketsWithExposure.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = `UP order failed - have ${afterDown.down} DOWN, ${afterDown.up} UP`;
            executedTrades.push(trade);
            return trade;
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
        // Imbalanced - block forever
        console.log(`   🚨 IMBALANCED: ${finalPos.up} UP ≠ ${finalPos.down} DOWN`);
        console.log(`   👉 Fix on polymarket.com`);
        marketsWithExposure.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.shares = Math.max(finalPos.up, finalPos.down);
        trade.error = `Imbalanced: ${finalPos.up} UP, ${finalPos.down} DOWN`;
        executedTrades.push(trade);
        return trade;
    }
    catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        // Check final positions to determine if we can retry
        const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
        if (finalPos.up === finalPos.down) {
            trade.can_retry = true;
            trade.error = error.message;
        }
        else {
            marketsWithExposure.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = `Error + imbalance: ${finalPos.up} UP, ${finalPos.down} DOWN`;
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
export function isTraderReady() {
    return clobClient !== null && wallet !== null;
}
export async function getBalance() {
    return cachedBalance;
}
//# sourceMappingURL=trader.js.map