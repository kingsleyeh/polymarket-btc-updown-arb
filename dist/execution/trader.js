/**
 * FAST MARKET ORDER Execution
 *
 * TRUE market orders: buy at $0.99 to take ANY available ask
 * Minimal waits - speed is everything
 */
import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
const MIN_SHARES = 5;
const SETTLEMENT_WAIT_MS = 1500; // Only needed for sells (token settlement)
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
let clobClient = null;
let wallet = null;
let cachedBalance = 0;
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
            console.log(`   🧹 Cancelling ${openOrders.length} orders...`);
            await Promise.all(openOrders.map(o => clobClient.cancelOrder({ orderID: o.id })));
        }
    }
    catch { }
}
/**
 * TRUE MARKET BUY using FAK (Fill and Kill) - INSTANT execution
 */
async function marketBuy(tokenId, shares, price, label) {
    if (!clobClient)
        return { orderId: null, filled: 0 };
    const startTime = Date.now();
    const startPos = await getPosition(tokenId);
    // For market orders, amount = dollars to spend (price * shares)
    const dollarAmount = price * shares * 1.05; // 5% buffer
    console.log(`   📥 ${label}: MARKET BUY $${dollarAmount.toFixed(2)}`);
    try {
        // Use createAndPostMarketOrder for FAK (Fill and Kill)
        const result = await clobClient.createAndPostMarketOrder({
            tokenID: tokenId,
            amount: dollarAmount,
            side: Side.BUY,
        }, {}, OrderType.FAK).catch(e => ({ error: e }));
        const orderTime = Date.now() - startTime;
        if (!result || 'error' in result) {
            const err = result?.error;
            console.log(`   ❌ ${label}: Failed (${orderTime}ms) - ${err?.data?.error || err?.message || 'Unknown'}`);
            return { orderId: null, filled: 0 };
        }
        // Check position to see what we got
        const endPos = await getPosition(tokenId);
        const filled = endPos - startPos;
        const totalTime = Date.now() - startTime;
        console.log(`   ✓ ${label}: ${filled} shares (${totalTime}ms)`);
        return { orderId: result.orderID || null, filled };
    }
    catch (error) {
        console.log(`   ❌ ${label}: ${error.message}`);
        return { orderId: null, filled: 0 };
    }
}
/**
 * MARKET SELL using FAK - retry up to 3 times with increasing settlement wait
 */
async function marketSell(tokenId, shares, label) {
    if (!clobClient || shares <= 0)
        return true;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const waitTime = attempt * 2000; // 2s, 4s, 6s
        console.log(`   📤 ${label}: SELL ${shares} (attempt ${attempt}, wait ${waitTime}ms)`);
        // Must wait for settlement - increases with each retry
        await new Promise(r => setTimeout(r, waitTime));
        try {
            // For SELL, amount = number of shares
            const result = await clobClient.createAndPostMarketOrder({
                tokenID: tokenId,
                amount: shares,
                side: Side.SELL,
            }, {}, OrderType.FAK).catch(e => ({ error: e }));
            if (!result || 'error' in result) {
                const err = result?.error;
                const errMsg = err?.data?.error || err?.message || 'Unknown';
                console.log(`   ❌ ${label}: Failed - ${errMsg}`);
                // If it's a balance/allowance error, wait longer and retry
                if (errMsg.includes('balance') || errMsg.includes('allowance')) {
                    console.log(`   ⏳ Token not settled yet, retrying...`);
                    continue;
                }
                continue; // Try again anyway
            }
            console.log(`   ✓ ${label}: Sell order executed`);
            const remaining = await getPosition(tokenId);
            if (remaining === 0) {
                console.log(`   ✅ ${label}: Sold all`);
                return true;
            }
            else if (remaining < shares) {
                console.log(`   ⚠️ ${label}: Partial - ${remaining} remaining, retrying...`);
                shares = remaining;
                continue;
            }
            else {
                console.log(`   ⚠️ ${label}: ${remaining} remaining`);
                continue;
            }
        }
        catch (e) {
            console.log(`   ❌ ${label}: ${e.message}`);
        }
    }
    const finalRemaining = await getPosition(tokenId);
    return finalRemaining === 0;
}
async function reverseToZero(upTokenId, downTokenId) {
    await cancelAllOrders();
    const pos = await getBothPositions(upTokenId, downTokenId);
    console.log(`   🔄 Reversing: ${pos.up} UP, ${pos.down} DOWN`);
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
        console.log(`   ✅ Reversed to 0`);
        return true;
    }
    console.log(`   ❌ Still have: ${final.up} UP, ${final.down} DOWN`);
    return false;
}
/**
 * FAST SEQUENTIAL EXECUTE
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
    await cancelAllOrders();
    // Check starting position
    const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    if (startPos.up !== startPos.down) {
        console.log(`   ⚠️ Pre-existing imbalance: ${startPos.up} UP, ${startPos.down} DOWN`);
        if (!await reverseToZero(arb.up_token_id, arb.down_token_id)) {
            brokenMarkets.add(arb.market_id);
            trade.has_exposure = true;
            trade.can_retry = false;
            trade.error = 'Could not reverse';
            executedTrades.push(trade);
            return trade;
        }
    }
    console.log(`\n   ⚡ PARALLEL MARKET ORDERS: ${MIN_SHARES} shares BOTH sides`);
    // Buy BOTH at the SAME TIME - FAK orders execute instantly
    const [downResult, upResult] = await Promise.all([
        marketBuy(arb.down_token_id, MIN_SHARES, arb.down_price, 'DOWN'),
        marketBuy(arb.up_token_id, MIN_SHARES, arb.up_price, 'UP')
    ]);
    // FINAL CHECK
    const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
    const totalTime = Date.now() - startTime;
    console.log(`\n   📊 FINAL: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms)`);
    // SUCCESS - equal positions
    if (finalPos.up === finalPos.down && finalPos.up > 0) {
        console.log(`   ✅✅ SUCCESS! ${finalPos.up} each`);
        completedMarkets.add(arb.market_id);
        trade.status = 'filled';
        trade.shares = finalPos.up;
        trade.has_exposure = false;
        trade.can_retry = false;
        executedTrades.push(trade);
        return trade;
    }
    // NOTHING FILLED - can retry
    if (finalPos.up === 0 && finalPos.down === 0) {
        console.log(`   ⚠️ Nothing filled - can retry`);
        trade.error = 'No fills';
        trade.can_retry = true;
        executedTrades.push(trade);
        return trade;
    }
    // IMBALANCED - smart balance (sell excess, keep matched portion)
    console.log(`   ⚖️ Imbalanced! Smart balancing...`);
    if (finalPos.down > finalPos.up && finalPos.up > 0) {
        // More DOWN than UP - sell excess DOWN
        const excess = finalPos.down - finalPos.up;
        console.log(`   📤 Selling ${excess} excess DOWN to match ${finalPos.up} UP`);
        await marketSell(arb.down_token_id, excess, 'DOWN');
        const afterBalance = await getBothPositions(arb.up_token_id, arb.down_token_id);
        if (afterBalance.up === afterBalance.down && afterBalance.up > 0) {
            console.log(`   ✅ Balanced! ${afterBalance.up} each`);
            completedMarkets.add(arb.market_id);
            trade.status = 'filled';
            trade.shares = afterBalance.up;
            trade.has_exposure = false;
            trade.can_retry = false;
            executedTrades.push(trade);
            return trade;
        }
    }
    else if (finalPos.up > finalPos.down && finalPos.down > 0) {
        // More UP than DOWN - sell excess UP
        const excess = finalPos.up - finalPos.down;
        console.log(`   📤 Selling ${excess} excess UP to match ${finalPos.down} DOWN`);
        await marketSell(arb.up_token_id, excess, 'UP');
        const afterBalance = await getBothPositions(arb.up_token_id, arb.down_token_id);
        if (afterBalance.up === afterBalance.down && afterBalance.up > 0) {
            console.log(`   ✅ Balanced! ${afterBalance.up} each`);
            completedMarkets.add(arb.market_id);
            trade.status = 'filled';
            trade.shares = afterBalance.up;
            trade.has_exposure = false;
            trade.can_retry = false;
            executedTrades.push(trade);
            return trade;
        }
    }
    // Smart balance failed - try full reversal
    console.log(`   🚨 Smart balance failed, reversing all...`);
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