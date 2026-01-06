/**
 * SIMPLIFIED Trade Execution
 *
 * 1. Market buy both sides IMMEDIATELY
 * 2. Auto-reverse any imbalance
 * 3. Retry until success or manual intervention needed
 */
import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
// Configuration
const MIN_SHARES = 5;
const FILL_TIMEOUT_MS = 3000;
const POSITION_CHECK_INTERVAL_MS = 200;
const SETTLEMENT_WAIT_MS = 2000;
// Polymarket
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
// Client
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
// Track markets with failed reversals - these need manual fix
const brokenMarkets = new Set();
// Track completed markets
const completedMarkets = new Set();
const executedTrades = [];
/**
 * Check if market can be traded
 */
export function canTradeMarket(marketId) {
    if (brokenMarkets.has(marketId))
        return false;
    if (completedMarkets.has(marketId))
        return false;
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
        return true;
    }
    catch (error) {
        console.error('Init failed:', error.message);
        return false;
    }
}
/**
 * Get token position
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
 * Market buy - use high price to ensure fill
 */
async function marketBuy(tokenId, shares, label) {
    if (!clobClient)
        return null;
    try {
        console.log(`   📥 Market buying ${shares} ${label}...`);
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: 0.99, // High price = market order
            size: shares,
            side: Side.BUY,
        }).catch(e => ({ error: e }));
        const orderId = result && !('error' in result) ? result.orderID : null;
        if (orderId) {
            console.log(`   ✓ ${label} order placed`);
        }
        else {
            const err = result?.error;
            console.log(`   ❌ ${label} order failed: ${err?.data?.error || err?.message || 'Unknown'}`);
        }
        return orderId;
    }
    catch (error) {
        console.log(`   ❌ ${label} error: ${error.message}`);
        return null;
    }
}
/**
 * Market sell - use low price to ensure fill
 */
async function marketSell(tokenId, shares, label) {
    if (!clobClient || shares <= 0)
        return true; // Nothing to sell = success
    console.log(`   📤 Market selling ${shares} ${label}...`);
    // Wait for settlement
    await new Promise(r => setTimeout(r, SETTLEMENT_WAIT_MS));
    try {
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: 0.01, // Low price = market sell
            size: shares,
            side: Side.SELL,
        }).catch(e => ({ error: e }));
        const orderId = result && !('error' in result) ? result.orderID : null;
        if (orderId) {
            // Wait for fill
            await new Promise(r => setTimeout(r, 1000));
            const remaining = await getPosition(tokenId);
            if (remaining === 0) {
                console.log(`   ✓ Sold all ${label}`);
                return true;
            }
            else {
                console.log(`   ⚠️ Still have ${remaining} ${label}`);
                return false;
            }
        }
        else {
            const err = result?.error;
            console.log(`   ❌ Sell failed: ${err?.data?.error || err?.message || 'Unknown'}`);
            return false;
        }
    }
    catch (error) {
        console.log(`   ❌ Sell error: ${error.message}`);
        return false;
    }
}
/**
 * Cancel order
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
 * Wait for position
 */
async function waitForFill(tokenId, targetShares, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pos = await getPosition(tokenId);
        if (pos >= targetShares)
            return true;
        await new Promise(r => setTimeout(r, POSITION_CHECK_INTERVAL_MS));
    }
    return false;
}
/**
 * Reverse all positions to get back to 0
 */
async function reverseToZero(upTokenId, downTokenId) {
    console.log(`   🔄 Reversing to 0...`);
    const pos = await getBothPositions(upTokenId, downTokenId);
    let success = true;
    if (pos.up > 0) {
        if (!await marketSell(upTokenId, pos.up, 'UP'))
            success = false;
    }
    if (pos.down > 0) {
        if (!await marketSell(downTokenId, pos.down, 'DOWN'))
            success = false;
    }
    const final = await getBothPositions(upTokenId, downTokenId);
    if (final.up === 0 && final.down === 0) {
        console.log(`   ✅ Back to 0 - can retry`);
        return true;
    }
    else {
        console.log(`   ❌ Reversal failed: ${final.up} UP, ${final.down} DOWN`);
        return false;
    }
}
/**
 * Execute trade - SIMPLE VERSION
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet) {
        console.error('Not initialized');
        return null;
    }
    if (brokenMarkets.has(arb.market_id)) {
        console.log(`   ⛔ Market broken - manual fix needed`);
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
    // Check current positions
    const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    console.log(`   📊 Current: ${startPos.up} UP, ${startPos.down} DOWN`);
    // If imbalanced, auto-reverse FIRST
    if (startPos.up !== startPos.down) {
        console.log(`   ⚠️ Imbalanced - auto-reversing first...`);
        const reversed = await reverseToZero(arb.up_token_id, arb.down_token_id);
        if (!reversed) {
            console.log(`   ❌ Could not reverse - market broken`);
            brokenMarkets.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = 'Reversal failed';
            executedTrades.push(trade);
            return trade;
        }
        // Update start position
        const newStart = await getBothPositions(arb.up_token_id, arb.down_token_id);
        console.log(`   📊 After reversal: ${newStart.up} UP, ${newStart.down} DOWN`);
    }
    // ===== MARKET BUY BOTH SIDES =====
    console.log(`\n   🚀 EXECUTING: Buy ${MIN_SHARES} of each side`);
    // Place both orders
    const downOrderId = await marketBuy(arb.down_token_id, MIN_SHARES, 'DOWN');
    const upOrderId = await marketBuy(arb.up_token_id, MIN_SHARES, 'UP');
    if (!downOrderId && !upOrderId) {
        console.log(`   ❌ Both orders failed`);
        trade.error = 'Both orders failed';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // Wait for fills
    console.log(`   ⏳ Waiting for fills...`);
    await new Promise(r => setTimeout(r, FILL_TIMEOUT_MS));
    // Cancel any unfilled orders
    if (downOrderId)
        await cancelOrder(downOrderId);
    if (upOrderId)
        await cancelOrder(upOrderId);
    // Check final positions
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    console.log(`\n   📊 RESULT: ${finalPos.up} UP, ${finalPos.down} DOWN`);
    // SUCCESS: Equal non-zero positions
    if (finalPos.up === finalPos.down && finalPos.up >= MIN_SHARES) {
        console.log(`   ✅✅ SUCCESS! ${finalPos.up} UP = ${finalPos.down} DOWN`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // PARTIAL SUCCESS: Equal but less than MIN_SHARES
    if (finalPos.up === finalPos.down && finalPos.up > 0) {
        console.log(`   ✅ Partial: ${finalPos.up} each (less than ${MIN_SHARES})`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // ZERO: Nothing filled - can retry
    if (finalPos.up === 0 && finalPos.down === 0) {
        console.log(`   ⚠️ Nothing filled - can retry`);
        trade.error = 'No fills';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // IMBALANCED: Auto-reverse
    console.log(`   🚨 Imbalanced! Auto-reversing...`);
    const reversed = await reverseToZero(arb.up_token_id, arb.down_token_id);
    if (reversed) {
        console.log(`   ✓ Reversed - can retry`);
        trade.error = 'Imbalanced but reversed';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    else {
        console.log(`   ❌ Reversal failed - manual fix needed`);
        brokenMarkets.add(arb.market_id);
        trade.has_exposure = true;
        trade.can_retry = false;
        trade.error = 'Reversal failed';
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