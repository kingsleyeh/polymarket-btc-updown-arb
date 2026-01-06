/**
 * ORDER BOOK TAKER Execution
 *
 * When arb spotted:
 * 1. Fetch order books for UP and DOWN
 * 2. See what ASK prices are available (what sellers are offering)
 * 3. TAKE that liquidity immediately (market buy at ask)
 * 4. Auto-reverse any imbalance
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
// Track broken markets
const brokenMarkets = new Set();
const completedMarkets = new Set();
const executedTrades = [];
export function canTradeMarket(marketId) {
    if (brokenMarkets.has(marketId))
        return false;
    if (completedMarkets.has(marketId))
        return false;
    return true;
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
/**
 * Get best ASK from order book (price sellers are offering)
 */
async function getBestAsk(tokenId) {
    if (!clobClient)
        return null;
    try {
        const book = await clobClient.getOrderBook(tokenId);
        // Asks are sell orders - what we can buy at
        if (book.asks && book.asks.length > 0) {
            // Asks are sorted low to high, first is best (lowest price to buy)
            const bestAsk = book.asks[0];
            return {
                price: parseFloat(bestAsk.price),
                size: parseFloat(bestAsk.size)
            };
        }
        return null;
    }
    catch (error) {
        return null;
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
async function getBothPositions(upTokenId, downTokenId) {
    const [up, down] = await Promise.all([
        getPosition(upTokenId),
        getPosition(downTokenId)
    ]);
    return { up, down };
}
/**
 * TAKE liquidity - buy at the ask price (or slightly above to ensure fill)
 */
async function takeAsk(tokenId, shares, askPrice, label) {
    if (!clobClient)
        return null;
    // Buy at ask price + tiny buffer to ensure we take the liquidity
    const takePrice = Math.min(askPrice + 0.001, 0.99);
    try {
        console.log(`   📥 TAKING ${shares} ${label} @ $${takePrice.toFixed(3)} (ask: $${askPrice.toFixed(3)})`);
        const result = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: takePrice,
            size: shares,
            side: Side.BUY,
        }).catch(e => ({ error: e }));
        const orderId = result && !('error' in result) ? result.orderID : null;
        if (orderId) {
            console.log(`   ✓ ${label} order filled`);
        }
        else {
            const err = result?.error;
            console.log(`   ❌ ${label} failed: ${err?.data?.error || err?.message || 'Unknown'}`);
        }
        return orderId;
    }
    catch (error) {
        console.log(`   ❌ ${label} error: ${error.message}`);
        return null;
    }
}
/**
 * Market sell
 */
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
            await new Promise(r => setTimeout(r, 1000));
            const remaining = await getPosition(tokenId);
            if (remaining === 0) {
                console.log(`   ✓ Sold all ${label}`);
                return true;
            }
        }
        return false;
    }
    catch {
        return false;
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
async function reverseToZero(upTokenId, downTokenId) {
    console.log(`   🔄 Reversing to 0...`);
    const pos = await getBothPositions(upTokenId, downTokenId);
    if (pos.up > 0)
        await marketSell(upTokenId, pos.up, 'UP');
    if (pos.down > 0)
        await marketSell(downTokenId, pos.down, 'DOWN');
    const final = await getBothPositions(upTokenId, downTokenId);
    if (final.up === 0 && final.down === 0) {
        console.log(`   ✅ Back to 0`);
        return true;
    }
    console.log(`   ❌ Reversal failed: ${final.up} UP, ${final.down} DOWN`);
    return false;
}
/**
 * Execute trade - ORDER BOOK TAKER
 */
export async function executeTrade(arb) {
    if (!clobClient || !wallet)
        return null;
    if (brokenMarkets.has(arb.market_id) || completedMarkets.has(arb.market_id)) {
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
    // Auto-reverse if imbalanced
    if (startPos.up !== startPos.down) {
        console.log(`   ⚠️ Imbalanced - reversing first...`);
        if (!await reverseToZero(arb.up_token_id, arb.down_token_id)) {
            brokenMarkets.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = 'Reversal failed';
            executedTrades.push(trade);
            return trade;
        }
    }
    // ===== FETCH ORDER BOOKS =====
    console.log(`\n   📖 Checking order books...`);
    const [upAsk, downAsk] = await Promise.all([
        getBestAsk(arb.up_token_id),
        getBestAsk(arb.down_token_id)
    ]);
    if (!upAsk || !downAsk) {
        console.log(`   ❌ Could not fetch order books`);
        trade.error = 'No order book data';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    const combinedAsk = upAsk.price + downAsk.price;
    console.log(`   UP ask: $${upAsk.price.toFixed(3)} (${upAsk.size} avail)`);
    console.log(`   DOWN ask: $${downAsk.price.toFixed(3)} (${downAsk.size} avail)`);
    console.log(`   Combined: $${combinedAsk.toFixed(3)}`);
    // Verify arb still exists
    if (combinedAsk >= 1.0) {
        console.log(`   ❌ Arb gone - combined ask >= $1.00`);
        trade.error = 'Arb disappeared';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // Check liquidity
    const availableShares = Math.min(upAsk.size, downAsk.size);
    const sharesToBuy = Math.min(MIN_SHARES, Math.floor(availableShares));
    if (sharesToBuy < MIN_SHARES) {
        console.log(`   ❌ Not enough liquidity: ${availableShares.toFixed(1)} available, need ${MIN_SHARES}`);
        trade.error = 'Insufficient liquidity';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // ===== TAKE THE LIQUIDITY =====
    const totalCost = (upAsk.price + downAsk.price) * sharesToBuy;
    const profit = sharesToBuy - totalCost;
    console.log(`\n   🚀 TAKING ${sharesToBuy} shares @ $${combinedAsk.toFixed(3)} = $${totalCost.toFixed(2)} → profit $${profit.toFixed(2)}`);
    // Take both sides simultaneously
    const [downOrderId, upOrderId] = await Promise.all([
        takeAsk(arb.down_token_id, sharesToBuy, downAsk.price, 'DOWN'),
        takeAsk(arb.up_token_id, sharesToBuy, upAsk.price, 'UP')
    ]);
    if (!downOrderId && !upOrderId) {
        console.log(`   ❌ Both orders failed`);
        trade.error = 'Both orders failed';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // Wait for fills
    await new Promise(r => setTimeout(r, FILL_TIMEOUT_MS));
    // Cancel any unfilled
    if (downOrderId)
        await cancelOrder(downOrderId);
    if (upOrderId)
        await cancelOrder(upOrderId);
    // Check result
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    console.log(`\n   📊 RESULT: ${finalPos.up} UP, ${finalPos.down} DOWN`);
    if (finalPos.up === finalPos.down && finalPos.up >= sharesToBuy) {
        console.log(`   ✅✅ SUCCESS! ${finalPos.up} UP = ${finalPos.down} DOWN`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    if (finalPos.up === finalPos.down && finalPos.up > 0) {
        console.log(`   ✅ Partial success: ${finalPos.up} each`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        executedTrades.push(trade);
        return trade;
    }
    if (finalPos.up === 0 && finalPos.down === 0) {
        console.log(`   ⚠️ Nothing filled - can retry`);
        trade.error = 'No fills';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // Imbalanced - reverse
    console.log(`   🚨 Imbalanced! Reversing...`);
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