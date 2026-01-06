/**
 * MARKET MAKER STRATEGY - Multi-Market
 *
 * Watches and trades BOTH markets simultaneously:
 *   - LIVE (≤15 min to expiry): Target 3% edge
 *   - PREMARKET (15-30 min to expiry): Target 2% edge
 *
 * Each market has independent state and can trade independently.
 * Once a position is filled on a market, hold until expiry.
 */
import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { subscribeToTokens, getBestAsk, getBestBid } from './orderbook-ws';
// Strategy-specific configuration
const STRATEGY_CONFIG = {
    LIVE: {
        TARGET_COMBINED: 0.97, // 3% profit target
        MIN_EDGE_TO_QUOTE: 0.02, // 2% minimum edge
    },
    PREMARKET: {
        TARGET_COMBINED: 0.98, // 2% profit target
        MIN_EDGE_TO_QUOTE: 0.015, // 1.5% minimum edge
    },
};
// Shared configuration
const CONFIG = {
    MAX_COMBINED: 1.02, // Accept up to 2% loss to complete (was 0.5%)
    SHARES_PER_ORDER: 5,
    REQUOTE_INTERVAL_MS: 2000,
    POSITION_CHECK_INTERVAL_MS: 500,
    CUT_LOSS_MAX_ATTEMPTS: 3,
    STOP_QUOTING_BEFORE_EXPIRY_MS: 5 * 60 * 1000, // Stop new quotes <5 min to expiry
    VOLATILITY_THRESHOLD: 0.80, // Skip if UP or DOWN >= 80¢
    AGGRESSIVE_COMPLETE_WAIT_MS: 30000, // Wait 30s for aggressive complete (was 5s)
    PRICE_IMPROVEMENT_WAIT_MS: 30000, // Wait 30s for prices to improve before cutting
};
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
let clobClient = null;
let wallet = null;
// Map of market ID -> state
const marketStates = new Map();
// Stats (global)
const stats = {
    quotesPlaced: 0,
    bothSideFills: 0,
    oneSidedFills: 0,
    aggressiveCompletes: 0,
    cutLosses: 0,
    totalProfit: 0,
    totalLoss: 0,
};
let isRunning = true;
export async function initializeMarketMaker() {
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
        const balanceUsd = parseFloat(balance.balance || '0') / 1_000_000;
        console.log(`Balance: $${balanceUsd.toFixed(2)} USDC`);
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
async function cancelAllOrders() {
    if (!clobClient)
        return false;
    try {
        await clobClient.cancelAll();
        await new Promise(r => setTimeout(r, 500));
        const orders = await clobClient.getOpenOrders();
        return !orders || orders.length === 0;
    }
    catch {
        return false;
    }
}
async function placeLimitBuy(tokenId, shares, price) {
    if (!clobClient)
        return null;
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: price,
            size: shares,
            side: Side.BUY,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        return result?.orderID || null;
    }
    catch {
        return null;
    }
}
async function marketSell(tokenId, shares) {
    if (!clobClient || shares <= 0)
        return { success: true };
    // Check actual position before trying to sell
    const actualPos = await getPosition(tokenId);
    if (actualPos === 0) {
        return { success: true, error: 'No position to sell' };
    }
    // Use actual position, not requested shares
    const sharesToSell = Math.min(actualPos, shares);
    const bid = getBestBid(tokenId);
    const sellPrice = bid ? Math.max(0.01, bid.price - 0.01) : 0.01;
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: sellPrice,
            size: sharesToSell,
            side: Side.SELL,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        return { success: !!result?.orderID };
    }
    catch (error) {
        const errorMsg = error?.response?.data?.error || error?.message || 'Unknown error';
        // "not enough balance / allowance" means we don't have the tokens
        if (errorMsg.includes('not enough balance') || errorMsg.includes('allowance')) {
            return { success: true, error: 'No balance - position already closed' };
        }
        return { success: false, error: errorMsg };
    }
}
function calculateBidPrices(upAsk, downAsk, targetCombined, minEdge) {
    const upMid = upAsk * 0.98;
    const downMid = downAsk * 0.98;
    const combinedMid = upMid + downMid;
    const discountNeeded = combinedMid - targetCombined;
    if (discountNeeded < minEdge) {
        return null;
    }
    const upWeight = upMid / combinedMid;
    const downWeight = downMid / combinedMid;
    const upBid = Math.max(0.01, upMid - (discountNeeded * upWeight));
    const downBid = Math.max(0.01, downMid - (discountNeeded * downWeight));
    if (upBid + downBid > targetCombined + 0.01) {
        return null;
    }
    return { upBid, downBid };
}
async function handleOneSidedFill(state, filledSide, filledPrice, filledShares) {
    const otherSide = filledSide === 'UP' ? 'DOWN' : 'UP';
    const otherTokenId = filledSide === 'UP' ? state.downTokenId : state.upTokenId;
    console.log(`   [${state.strategy}] ⚠️ ONE-SIDED FILL: ${filledSide} @ $${filledPrice.toFixed(3)} (${filledShares} shares)`);
    // CRITICAL: Only complete up to SHARES_PER_ORDER (5 shares), not the full position
    // If we have more than 5 shares, something went wrong (duplicate orders?)
    const sharesToComplete = Math.min(filledShares, CONFIG.SHARES_PER_ORDER);
    if (filledShares > CONFIG.SHARES_PER_ORDER) {
        console.log(`   [${state.strategy}] ⚠️ WARNING: Position has ${filledShares} shares (expected ${CONFIG.SHARES_PER_ORDER}) - only completing ${sharesToComplete}`);
    }
    const otherAsk = getBestAsk(otherTokenId);
    if (!otherAsk) {
        console.log(`   [${state.strategy}] ❌ Cannot get ${otherSide} price - cutting loss`);
        await cutLoss(state, filledSide, filledShares);
        return;
    }
    const wouldPayCombined = filledPrice + otherAsk.price;
    const wouldLosePct = (wouldPayCombined - 1) * 100;
    console.log(`   [${state.strategy}] 📊 ${otherSide} ask: $${otherAsk.price.toFixed(3)}`);
    console.log(`   [${state.strategy}] 📊 Would pay combined: $${wouldPayCombined.toFixed(4)} (${wouldLosePct >= 0 ? '+' : ''}${wouldLosePct.toFixed(2)}%)`);
    // Always try to complete first, even if it would lose a bit
    if (wouldPayCombined <= CONFIG.MAX_COMBINED) {
        const profitPct = (1 - wouldPayCombined) * 100;
        if (profitPct > 0) {
            console.log(`   [${state.strategy}] ✅ Completing pair (${profitPct.toFixed(2)}% profit)`);
        }
        else {
            console.log(`   [${state.strategy}] ⚠️ Completing pair (${Math.abs(profitPct).toFixed(2)}% loss - acceptable)`);
        }
        await cancelAllOrders();
        state.status = 'AGGRESSIVE_COMPLETE';
        // Only complete up to SHARES_PER_ORDER (5 shares)
        const completeOrderId = await placeLimitBuy(otherTokenId, sharesToComplete, otherAsk.price + 0.01);
        if (completeOrderId) {
            console.log(`   [${state.strategy}] ⏳ Waiting up to ${CONFIG.AGGRESSIVE_COMPLETE_WAIT_MS / 1000}s for fill...`);
            // Wait longer for fill (30 seconds total)
            const waitIterations = CONFIG.AGGRESSIVE_COMPLETE_WAIT_MS / 1000;
            for (let i = 0; i < waitIterations; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const upPos = await getPosition(state.upTokenId);
                const downPos = await getPosition(state.downTokenId);
                if (upPos > 0 && downPos > 0 && Math.abs(upPos - downPos) <= 1) {
                    const minShares = Math.min(upPos, downPos);
                    const actualProfit = (1 - wouldPayCombined) * minShares;
                    console.log(`   [${state.strategy}] ✅✅ COMPLETE! ${minShares} shares each`);
                    if (actualProfit > 0) {
                        console.log(`   [${state.strategy}] 💰 Profit: $${actualProfit.toFixed(2)}`);
                    }
                    else {
                        console.log(`   [${state.strategy}] 💰 Small loss: $${Math.abs(actualProfit).toFixed(2)}`);
                    }
                    await cancelAllOrders();
                    stats.aggressiveCompletes++;
                    stats.totalProfit += Math.max(0, actualProfit);
                    stats.totalLoss += Math.max(0, -actualProfit);
                    state.status = 'HOLDING';
                    state.upPosition = upPos;
                    state.downPosition = downPos;
                    return;
                }
            }
            // Didn't fill - cut loss
            await cancelAllOrders();
            console.log(`   [${state.strategy}] ❌ Aggressive complete didn't fill after ${CONFIG.AGGRESSIVE_COMPLETE_WAIT_MS / 1000}s`);
        }
        await cutLoss(state, filledSide, filledShares);
    }
    else {
        // Would lose >2% - wait for prices to improve before cutting
        console.log(`   [${state.strategy}] ⚠️ Would lose ${wouldLosePct.toFixed(2)}% - waiting ${CONFIG.PRICE_IMPROVEMENT_WAIT_MS / 1000}s for prices to improve...`);
        const startTime = Date.now();
        let bestCombined = wouldPayCombined;
        let bestOtherAsk = otherAsk.price;
        // Wait and monitor for price improvement
        while (Date.now() - startTime < CONFIG.PRICE_IMPROVEMENT_WAIT_MS) {
            await new Promise(r => setTimeout(r, 2000)); // Check every 2s
            const currentOtherAsk = getBestAsk(otherTokenId);
            if (currentOtherAsk && currentOtherAsk.price < bestOtherAsk) {
                const newCombined = filledPrice + currentOtherAsk.price;
                if (newCombined < bestCombined) {
                    bestCombined = newCombined;
                    bestOtherAsk = currentOtherAsk.price;
                    console.log(`   [${state.strategy}] 📉 Price improved: ${otherSide} now $${currentOtherAsk.price.toFixed(3)} (combined $${newCombined.toFixed(4)})`);
                    // If now acceptable, try to complete
                    if (newCombined <= CONFIG.MAX_COMBINED) {
                        console.log(`   [${state.strategy}] ✅ Price improved enough - attempting complete`);
                        await cancelAllOrders();
                        state.status = 'AGGRESSIVE_COMPLETE';
                        const completeOrderId = await placeLimitBuy(otherTokenId, filledShares, currentOtherAsk.price + 0.01);
                        if (completeOrderId) {
                            // Wait for fill
                            for (let i = 0; i < CONFIG.AGGRESSIVE_COMPLETE_WAIT_MS / 1000; i++) {
                                await new Promise(r => setTimeout(r, 1000));
                                const upPos = await getPosition(state.upTokenId);
                                const downPos = await getPosition(state.downTokenId);
                                if (upPos > 0 && downPos > 0 && Math.abs(upPos - downPos) <= 1) {
                                    const minShares = Math.min(upPos, downPos);
                                    const actualProfit = (1 - newCombined) * minShares;
                                    console.log(`   [${state.strategy}] ✅✅ COMPLETE! ${minShares} shares each`);
                                    console.log(`   [${state.strategy}] 💰 ${actualProfit > 0 ? 'Profit' : 'Loss'}: $${Math.abs(actualProfit).toFixed(2)}`);
                                    await cancelAllOrders();
                                    stats.aggressiveCompletes++;
                                    stats.totalProfit += Math.max(0, actualProfit);
                                    stats.totalLoss += Math.max(0, -actualProfit);
                                    state.status = 'HOLDING';
                                    state.upPosition = upPos;
                                    state.downPosition = downPos;
                                    return;
                                }
                            }
                        }
                        // Didn't fill - continue to cut loss
                        await cancelAllOrders();
                    }
                }
            }
        }
        // Still unprofitable after waiting - cut loss
        const finalOtherAsk = getBestAsk(otherTokenId);
        const finalCombined = finalOtherAsk ? filledPrice + finalOtherAsk.price : wouldPayCombined;
        const finalLoss = (finalCombined - 1) * 100;
        console.log(`   [${state.strategy}] ❌ Still unprofitable after waiting (${finalLoss.toFixed(2)}% loss) - cutting loss`);
        await cutLoss(state, filledSide, filledShares);
    }
}
async function cutLoss(state, side, shares) {
    const tokenId = side === 'UP' ? state.upTokenId : state.downTokenId;
    console.log(`   [${state.strategy}] 📤 Selling ${shares} ${side} to cut loss`);
    await cancelAllOrders();
    await new Promise(r => setTimeout(r, 1000));
    const currentPos = await getPosition(tokenId);
    console.log(`   [${state.strategy}] 📊 Actual position: ${currentPos} ${side}`);
    if (currentPos === 0) {
        console.log(`   [${state.strategy}] ✅ Position already closed (no balance)`);
        stats.cutLosses++;
        state.status = 'IDLE';
        return;
    }
    for (let attempt = 1; attempt <= CONFIG.CUT_LOSS_MAX_ATTEMPTS; attempt++) {
        const result = await marketSell(tokenId, currentPos);
        if (result.error && result.error.includes('already closed')) {
            console.log(`   [${state.strategy}] ✅ Position already closed`);
            stats.cutLosses++;
            state.status = 'IDLE';
            return;
        }
        if (result.success) {
            await new Promise(r => setTimeout(r, 2000));
            await cancelAllOrders();
            const remaining = await getPosition(tokenId);
            console.log(`   [${state.strategy}] 📊 Position after sell: ${remaining} ${side}`);
            if (remaining === 0) {
                console.log(`   [${state.strategy}] ✅ Loss cut successfully`);
                stats.cutLosses++;
                stats.totalLoss += currentPos * 0.03; // Estimate 3% loss
                state.status = 'IDLE';
                return;
            }
        }
        else {
            console.log(`   [${state.strategy}] ⚠️ Sell attempt ${attempt} failed: ${result.error || 'Unknown error'}`);
        }
        if (attempt < CONFIG.CUT_LOSS_MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    // Final check - maybe position was sold by someone else
    const finalPos = await getPosition(tokenId);
    if (finalPos === 0) {
        console.log(`   [${state.strategy}] ✅ Position closed (final check)`);
        stats.cutLosses++;
        state.status = 'IDLE';
        return;
    }
    console.log(`   [${state.strategy}] ⚠️ Failed to close position - ${finalPos} ${side} remaining`);
    state.status = 'IDLE'; // Don't block, but mark as IDLE so we can try again
}
async function processMarket(state) {
    if (!clobClient)
        return;
    // Skip if holding or in aggressive complete
    if (state.status === 'HOLDING' || state.status === 'AGGRESSIVE_COMPLETE')
        return;
    const now = Date.now();
    const timeToExpiry = state.expiryTimestamp - now;
    // Check expiry
    if (timeToExpiry <= 60000) {
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        if (upPos > 0 || downPos > 0) {
            console.log(`   [${state.strategy}] ⏰ Holding ${upPos} UP + ${downPos} DOWN until expiry`);
            state.status = 'HOLDING';
            state.upPosition = upPos;
            state.downPosition = downPos;
        }
        return;
    }
    // ALWAYS check positions first
    const upPos = await getPosition(state.upTokenId);
    const downPos = await getPosition(state.downTokenId);
    // Update state positions for logging
    state.upPosition = upPos;
    state.downPosition = downPos;
    // Both filled - set to HOLDING, don't trade again
    if (upPos >= CONFIG.SHARES_PER_ORDER && downPos >= CONFIG.SHARES_PER_ORDER) {
        const profit = (1 - (state.upBidPrice + state.downBidPrice)) * Math.min(upPos, downPos);
        console.log(`   [${state.strategy}] ✅✅ BOTH FILLED! ${upPos} UP + ${downPos} DOWN`);
        console.log(`   [${state.strategy}] 💰 Profit: $${profit.toFixed(2)}`);
        await cancelAllOrders();
        stats.bothSideFills++;
        stats.totalProfit += profit;
        state.status = 'HOLDING';
        return;
    }
    // One-sided position - handle it, but then set to HOLDING (don't trade again)
    if (upPos > 0 && downPos === 0) {
        console.log(`   [${state.strategy}] ⚠️ One-sided UP position: ${upPos} UP, 0 DOWN`);
        stats.oneSidedFills++;
        const upAsk = getBestAsk(state.upTokenId);
        await handleOneSidedFill(state, 'UP', state.upBidPrice || (upAsk?.price || 0.5), upPos);
        // After handling, always set to HOLDING (don't trade this market again)
        state.status = 'HOLDING';
        return;
    }
    if (downPos > 0 && upPos === 0) {
        console.log(`   [${state.strategy}] ⚠️ One-sided DOWN position: 0 UP, ${downPos} DOWN`);
        stats.oneSidedFills++;
        const downAsk = getBestAsk(state.downTokenId);
        await handleOneSidedFill(state, 'DOWN', state.downBidPrice || (downAsk?.price || 0.5), downPos);
        // After handling, always set to HOLDING (don't trade this market again)
        state.status = 'HOLDING';
        return;
    }
    // CRITICAL: If we have ANY position (even partial), we've already traded - DON'T TRADE AGAIN
    if (upPos > 0 || downPos > 0) {
        console.log(`   [${state.strategy}] 📦 Position exists (${upPos} UP, ${downPos} DOWN) - holding, no more trading`);
        state.status = 'HOLDING';
        await cancelAllOrders();
        return; // Don't place new quotes if we already have a position
    }
    // Get prices for new quotes (only if no positions)
    const upAsk = getBestAsk(state.upTokenId);
    const downAsk = getBestAsk(state.downTokenId);
    if (!upAsk || !downAsk)
        return;
    // Stop taking new quotes <5 min before expiry
    if (timeToExpiry <= CONFIG.STOP_QUOTING_BEFORE_EXPIRY_MS) {
        if (state.status === 'QUOTING') {
            console.log(`   [${state.strategy}] ⏸️ <5 min to expiry - no new quotes`);
            await cancelAllOrders();
            state.status = 'IDLE';
        }
        return;
    }
    // Volatility filter - skip if UP or DOWN >= 80¢
    if (upAsk.price >= CONFIG.VOLATILITY_THRESHOLD || downAsk.price >= CONFIG.VOLATILITY_THRESHOLD) {
        console.log(`   [${state.strategy}] ⏸️ Volatility: UP=$${upAsk.price.toFixed(2)}, DOWN=$${downAsk.price.toFixed(2)}`);
        // Cancel any open orders
        await cancelAllOrders();
        // Check if we have a one-sided position that needs handling
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        if (upPos > 0 && downPos === 0) {
            console.log(`   [${state.strategy}] ⚠️ One-sided UP during volatility - handling`);
            stats.oneSidedFills++;
            await handleOneSidedFill(state, 'UP', state.upBidPrice || upAsk.price, upPos);
            return;
        }
        if (downPos > 0 && upPos === 0) {
            console.log(`   [${state.strategy}] ⚠️ One-sided DOWN during volatility - handling`);
            stats.oneSidedFills++;
            await handleOneSidedFill(state, 'DOWN', state.downBidPrice || downAsk.price, downPos);
            return;
        }
        // No position - just pause
        state.status = 'IDLE';
        return;
    }
    // Calculate prices
    const strategyConfig = STRATEGY_CONFIG[state.strategy];
    const prices = calculateBidPrices(upAsk.price, downAsk.price, strategyConfig.TARGET_COMBINED, strategyConfig.MIN_EDGE_TO_QUOTE);
    if (!prices) {
        if (state.status === 'QUOTING') {
            state.status = 'IDLE';
        }
        return;
    }
    // Check if prices changed significantly
    const priceChanged = state.upBidPrice === 0 ||
        Math.abs(prices.upBid - state.upBidPrice) > 0.005 ||
        Math.abs(prices.downBid - state.downBidPrice) > 0.005;
    if (state.status === 'QUOTING' && !priceChanged)
        return;
    // Place orders
    console.log(`   [${state.strategy}] 📊 UP=$${upAsk.price.toFixed(3)}, DOWN=$${downAsk.price.toFixed(3)} (${(upAsk.price + downAsk.price).toFixed(3)})`);
    console.log(`   [${state.strategy}] 📝 Quoting: UP bid=$${prices.upBid.toFixed(3)}, DOWN bid=$${prices.downBid.toFixed(3)}`);
    const [upOrderId, downOrderId] = await Promise.all([
        placeLimitBuy(state.upTokenId, CONFIG.SHARES_PER_ORDER, prices.upBid),
        placeLimitBuy(state.downTokenId, CONFIG.SHARES_PER_ORDER, prices.downBid),
    ]);
    if (upOrderId && downOrderId) {
        state.upOrderId = upOrderId;
        state.downOrderId = downOrderId;
        state.upBidPrice = prices.upBid;
        state.downBidPrice = prices.downBid;
        state.status = 'QUOTING';
        stats.quotesPlaced++;
        console.log(`   [${state.strategy}] ✓ Orders placed`);
    }
}
export async function addMarket(market) {
    if (marketStates.has(market.id))
        return;
    console.log(`\n📈 Adding ${market.strategy} market: ${market.question}`);
    console.log(`   Time to expiry: ${Math.round(market.timeToExpirySec / 60)} min`);
    subscribeToTokens([market.up_token_id, market.down_token_id]);
    marketStates.set(market.id, {
        marketId: market.id,
        marketQuestion: market.question,
        upTokenId: market.up_token_id,
        downTokenId: market.down_token_id,
        upOrderId: null,
        downOrderId: null,
        upBidPrice: 0,
        downBidPrice: 0,
        upPosition: 0,
        downPosition: 0,
        status: 'IDLE',
        aggressiveCompleteOrderId: null,
        strategy: market.strategy,
        expiryTimestamp: market.expiry_timestamp,
    });
}
export function removeExpiredMarkets() {
    const now = Date.now();
    for (const [id, state] of marketStates) {
        const timeToExpiry = state.expiryTimestamp - now;
        if (timeToExpiry <= 0) {
            console.log(`   🗑️ Removing expired: ${state.marketQuestion.slice(0, 40)}...`);
            marketStates.delete(id);
        }
    }
}
export async function runMarketMakerLoop() {
    if (!clobClient)
        return;
    console.log('\n🚀 Starting multi-market maker loop...\n');
    while (isRunning) {
        try {
            // Process each active market
            for (const state of marketStates.values()) {
                await processMarket(state);
            }
            // Remove expired markets
            removeExpiredMarkets();
            // Wait before next iteration
            await new Promise(r => setTimeout(r, CONFIG.REQUOTE_INTERVAL_MS));
        }
        catch (error) {
            console.error(`Loop error: ${error.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}
export function getActiveMarkets() {
    return marketStates;
}
export async function refreshMarketPositions() {
    for (const state of marketStates.values()) {
        const upPos = await getPosition(state.upTokenId);
        const downPos = await getPosition(state.downTokenId);
        state.upPosition = upPos;
        state.downPosition = downPos;
    }
}
export function isAnyMarketHolding() {
    for (const state of marketStates.values()) {
        if (state.status === 'HOLDING')
            return true;
    }
    return false;
}
export function printStats() {
    console.log(`\nStats:`);
    console.log(`  Active markets: ${marketStates.size}`);
    console.log(`  Quotes placed: ${stats.quotesPlaced}`);
    console.log(`  Both-side fills: ${stats.bothSideFills}`);
    console.log(`  One-sided fills: ${stats.oneSidedFills}`);
    console.log(`  Aggressive completes: ${stats.aggressiveCompletes}`);
    console.log(`  Cut losses: ${stats.cutLosses}`);
    console.log(`  Total profit: $${stats.totalProfit.toFixed(2)}`);
    console.log(`  Total loss: $${stats.totalLoss.toFixed(2)}`);
    console.log(`  Net P&L: $${(stats.totalProfit - stats.totalLoss).toFixed(2)}`);
}
export function stopMarketMaker() {
    isRunning = false;
    cancelAllOrders();
}
//# sourceMappingURL=market-maker.js.map