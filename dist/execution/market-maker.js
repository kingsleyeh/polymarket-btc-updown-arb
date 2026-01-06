/**
 * MARKET MAKER STRATEGY
 *
 * Phase 1: Conservative market making with profit protection
 *
 * 1. Place bids for both UP and DOWN at prices that sum to TARGET_COMBINED
 * 2. Wait for fills
 * 3. If one side fills, aggressively complete the other side if still profitable
 * 4. If completing would be unprofitable, cut loss immediately
 */
import { ClobClient, Side, AssetType, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { connectOrderBookWebSocket, subscribeToTokens, getBestAsk, getBestBid, disconnectOrderBookWebSocket } from './orderbook-ws';
// Phase 1 Configuration
const CONFIG = {
    TARGET_COMBINED: 0.97, // 3% profit target
    MAX_COMBINED: 1.005, // Accept up to 0.5% loss to complete (better than cutting)
    SHARES_PER_ORDER: 5, // Small size for learning
    REQUOTE_INTERVAL_MS: 2000, // Update quotes every 2s
    MIN_EDGE_TO_QUOTE: 0.02, // Only quote if potential 2%+ edge exists
    POSITION_CHECK_INTERVAL_MS: 500,
    CUT_LOSS_MAX_ATTEMPTS: 3, // Try selling 3 times before giving up
};
const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';
let clobClient = null;
let wallet = null;
let state = null;
// Stats
const stats = {
    quotesPlaced: 0,
    bothSideFills: 0,
    oneSidedFills: 0,
    aggressiveCompletes: 0,
    cutLosses: 0,
    totalProfit: 0,
    totalLoss: 0,
};
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
        // Connect WebSocket
        await connectOrderBookWebSocket();
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
        return;
    try {
        await clobClient.cancelAll();
    }
    catch { }
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
    catch (error) {
        return null;
    }
}
async function marketBuy(tokenId, shares, maxPrice) {
    if (!clobClient)
        return false;
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: maxPrice,
            size: shares,
            side: Side.BUY,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        return !!result?.orderID;
    }
    catch {
        return false;
    }
}
async function marketSell(tokenId, shares) {
    if (!clobClient || shares <= 0)
        return true;
    // Get current bid price to sell at market
    const bid = getBestBid(tokenId);
    const sellPrice = bid ? Math.max(0.01, bid.price - 0.01) : 0.01; // Slightly below bid to ensure fill
    try {
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: sellPrice,
            size: shares,
            side: Side.SELL,
        });
        const result = await clobClient.postOrder(order, OrderType.GTC);
        return !!result?.orderID;
    }
    catch (error) {
        console.log(`   ⚠️ Sell order failed: ${error.message}`);
        return false;
    }
}
function calculateBidPrices(upAsk, downAsk) {
    // Current combined ask
    const combinedAsk = upAsk + downAsk;
    // If combined ask is already below target, we can be more aggressive
    // If combined ask is above 1.0, we need bigger discounts
    // Calculate mid prices (assume bid is ~2% below ask)
    const upMid = upAsk * 0.98;
    const downMid = downAsk * 0.98;
    const combinedMid = upMid + downMid;
    // How much discount do we need from mid to hit target?
    const discountNeeded = combinedMid - CONFIG.TARGET_COMBINED;
    if (discountNeeded < CONFIG.MIN_EDGE_TO_QUOTE) {
        // Not enough potential edge
        return null;
    }
    // Split discount proportionally based on current prices
    const upWeight = upMid / combinedMid;
    const downWeight = downMid / combinedMid;
    const upBid = Math.max(0.01, upMid - (discountNeeded * upWeight));
    const downBid = Math.max(0.01, downMid - (discountNeeded * downWeight));
    // Sanity check
    if (upBid + downBid > CONFIG.TARGET_COMBINED + 0.01) {
        return null;
    }
    return { upBid, downBid };
}
async function handleOneSidedFill(filledSide, filledPrice, filledShares) {
    if (!state)
        return;
    const otherSide = filledSide === 'UP' ? 'DOWN' : 'UP';
    const otherTokenId = filledSide === 'UP' ? state.downTokenId : state.upTokenId;
    console.log(`\n   ⚠️ ONE-SIDED FILL: ${filledSide} @ $${filledPrice.toFixed(3)}`);
    // Get current ask for other side
    const otherAsk = getBestAsk(otherTokenId);
    if (!otherAsk) {
        console.log(`   ❌ Cannot get ${otherSide} price - cutting loss`);
        await cutLoss(filledSide, filledShares);
        return;
    }
    const wouldPayCombined = filledPrice + otherAsk.price;
    console.log(`   📊 ${otherSide} ask: $${otherAsk.price.toFixed(3)}`);
    console.log(`   📊 Would pay combined: $${wouldPayCombined.toFixed(4)}`);
    if (wouldPayCombined <= CONFIG.MAX_COMBINED) {
        // Acceptable to complete (profit or small loss < 0.5%)
        const profitPct = (1 - wouldPayCombined) * 100;
        if (profitPct > 0) {
            console.log(`   ✅ Completing pair (${profitPct.toFixed(2)}% profit)`);
        }
        else {
            console.log(`   ⚠️ Completing pair (${Math.abs(profitPct).toFixed(2)}% loss - acceptable)`);
        }
        await cancelAllOrders();
        const success = await marketBuy(otherTokenId, filledShares, otherAsk.price + 0.01);
        if (success) {
            // Wait for fill
            await new Promise(r => setTimeout(r, 2000));
            await cancelAllOrders(); // Cancel any remaining orders
            await new Promise(r => setTimeout(r, 1000));
            const upPos = await getPosition(state.upTokenId);
            const downPos = await getPosition(state.downTokenId);
            console.log(`   📊 Positions: ${upPos} UP, ${downPos} DOWN`);
            if (upPos > 0 && downPos > 0 && Math.abs(upPos - downPos) <= 1) {
                const minShares = Math.min(upPos, downPos);
                const actualProfit = (1 - wouldPayCombined) * minShares;
                console.log(`   ✅✅ COMPLETE! ${minShares} shares each`);
                if (actualProfit > 0) {
                    console.log(`   💰 Locked profit: $${actualProfit.toFixed(2)} (${profitPct.toFixed(2)}%)`);
                }
                else {
                    console.log(`   💰 Small loss: $${Math.abs(actualProfit).toFixed(2)} (${Math.abs(profitPct).toFixed(2)}%)`);
                }
                stats.aggressiveCompletes++;
                if (actualProfit > 0) {
                    stats.totalProfit += actualProfit;
                }
                else {
                    stats.totalLoss += Math.abs(actualProfit);
                }
                state.status = 'COMPLETE';
                state.tradesCompleted++;
                state.totalPnL += actualProfit;
            }
            else {
                console.log(`   ⚠️ Positions don't match - may need cleanup`);
                state.status = 'IDLE';
            }
        }
        else {
            console.log(`   ❌ Failed to buy ${otherSide} - cutting loss`);
            await cutLoss(filledSide, filledShares);
        }
    }
    else {
        // Would lose too much (>0.5%) - cut loss
        const wouldLose = (wouldPayCombined - 1) * 100;
        console.log(`   ❌ Would lose ${wouldLose.toFixed(2)}% - cutting loss`);
        await cutLoss(filledSide, filledShares);
    }
}
async function cutLoss(side, shares) {
    if (!state)
        return;
    const tokenId = side === 'UP' ? state.upTokenId : state.downTokenId;
    console.log(`   📤 Selling ${shares} ${side} to cut loss`);
    await cancelAllOrders();
    await new Promise(r => setTimeout(r, 1000)); // Wait for settlement
    // Get current position before selling
    const initialPos = await getPosition(tokenId);
    console.log(`   📊 Current position: ${initialPos} shares`);
    // Try selling multiple times if needed
    for (let attempt = 1; attempt <= CONFIG.CUT_LOSS_MAX_ATTEMPTS; attempt++) {
        const currentPos = await getPosition(tokenId);
        if (currentPos === 0) {
            console.log(`   ✅ Position already closed`);
            stats.cutLosses++;
            state.status = 'IDLE';
            state.tradesCut++;
            return;
        }
        const sharesToSell = Math.min(currentPos, shares);
        console.log(`   📤 Attempt ${attempt}/${CONFIG.CUT_LOSS_MAX_ATTEMPTS}: Selling ${sharesToSell} shares`);
        const success = await marketSell(tokenId, sharesToSell);
        if (success) {
            // Wait for fill and check
            await new Promise(r => setTimeout(r, 2000));
            await cancelAllOrders(); // Cancel any remaining orders
            await new Promise(r => setTimeout(r, 1000));
            const remaining = await getPosition(tokenId);
            console.log(`   📊 Position after sell: ${remaining} shares`);
            if (remaining === 0) {
                const loss = initialPos * 0.02; // Estimate ~2% spread cost
                console.log(`   ✅ Loss cut - position closed (estimated loss: $${loss.toFixed(2)})`);
                stats.cutLosses++;
                stats.totalLoss += loss;
                state.status = 'IDLE';
                state.totalPnL -= loss;
                state.tradesCut++;
                return;
            }
        }
        // Wait before retry
        if (attempt < CONFIG.CUT_LOSS_MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    // Failed to close position after all attempts
    const finalPos = await getPosition(tokenId);
    console.log(`   ❌ Failed to close position - ${finalPos} shares remaining`);
    console.log(`   ⚠️ Bot will continue but position is stuck`);
    state.status = 'IDLE'; // Don't block, just continue
    state.tradesCut++;
}
async function updateQuotes() {
    if (!state || !clobClient)
        return;
    if (state.status !== 'IDLE' && state.status !== 'QUOTING')
        return;
    // Get current market prices from WebSocket cache
    const upAsk = getBestAsk(state.upTokenId);
    const downAsk = getBestAsk(state.downTokenId);
    if (!upAsk || !downAsk) {
        return; // No price data yet
    }
    // Calculate bid prices
    const prices = calculateBidPrices(upAsk.price, downAsk.price);
    if (!prices) {
        // Not enough edge - cancel existing orders
        if (state.status === 'QUOTING') {
            await cancelAllOrders();
            state.status = 'IDLE';
            state.upOrderId = null;
            state.downOrderId = null;
        }
        return;
    }
    // Check if prices changed significantly (>0.5%)
    const priceChanged = Math.abs(prices.upBid - state.upBidPrice) > 0.005 ||
        Math.abs(prices.downBid - state.downBidPrice) > 0.005;
    if (state.status === 'QUOTING' && !priceChanged) {
        return; // No need to update
    }
    // Cancel existing orders and place new ones
    await cancelAllOrders();
    console.log(`\n   📊 Market: UP ask=$${upAsk.price.toFixed(3)}, DOWN ask=$${downAsk.price.toFixed(3)} (combined $${(upAsk.price + downAsk.price).toFixed(4)})`);
    console.log(`   📝 Quoting: UP bid=$${prices.upBid.toFixed(3)}, DOWN bid=$${prices.downBid.toFixed(3)} (target $${CONFIG.TARGET_COMBINED})`);
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
        console.log(`   ✓ Orders placed`);
    }
    else {
        console.log(`   ❌ Failed to place orders`);
    }
}
async function checkFills() {
    if (!state || state.status !== 'QUOTING')
        return;
    const upPos = await getPosition(state.upTokenId);
    const downPos = await getPosition(state.downTokenId);
    // Log positions for debugging
    if (upPos > 0 || downPos > 0) {
        console.log(`   📊 Positions: ${upPos} UP, ${downPos} DOWN`);
    }
    // Both sides filled
    if (upPos >= CONFIG.SHARES_PER_ORDER && downPos >= CONFIG.SHARES_PER_ORDER) {
        const actualCombined = state.upBidPrice + state.downBidPrice;
        const profit = (1 - actualCombined) * Math.min(upPos, downPos);
        console.log(`\n   ✅✅ BOTH SIDES FILLED!`);
        console.log(`   💰 ${upPos} UP + ${downPos} DOWN @ $${actualCombined.toFixed(4)}`);
        console.log(`   💰 Locked profit: $${profit.toFixed(2)} (${((1 - actualCombined) * 100).toFixed(1)}%)`);
        await cancelAllOrders();
        stats.bothSideFills++;
        stats.totalProfit += profit;
        state.status = 'COMPLETE';
        state.tradesCompleted++;
        state.totalPnL += profit;
        state.upOrderId = null;
        state.downOrderId = null;
        return;
    }
    // One side filled
    if (upPos > 0 && downPos === 0) {
        stats.oneSidedFills++;
        state.status = 'ONE_SIDED_UP';
        state.upPosition = upPos;
        await handleOneSidedFill('UP', state.upBidPrice, upPos);
        return;
    }
    if (downPos > 0 && upPos === 0) {
        stats.oneSidedFills++;
        state.status = 'ONE_SIDED_DOWN';
        state.downPosition = downPos;
        await handleOneSidedFill('DOWN', state.downBidPrice, downPos);
        return;
    }
}
export async function startMarketMaker(marketId, upTokenId, downTokenId, marketQuestion) {
    if (!clobClient) {
        console.error('Market maker not initialized');
        return;
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`   MARKET MAKER - Phase 1`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Market: ${marketQuestion}`);
    console.log(`Target combined: $${CONFIG.TARGET_COMBINED} (${((1 - CONFIG.TARGET_COMBINED) * 100).toFixed(0)}% profit)`);
    console.log(`Shares per order: ${CONFIG.SHARES_PER_ORDER}`);
    console.log(`${'='.repeat(60)}\n`);
    // Subscribe to order book updates
    subscribeToTokens([upTokenId, downTokenId]);
    // Initialize state
    state = {
        marketId,
        upTokenId,
        downTokenId,
        upOrderId: null,
        downOrderId: null,
        upBidPrice: 0,
        downBidPrice: 0,
        upPosition: 0,
        downPosition: 0,
        status: 'IDLE',
        totalPnL: 0,
        tradesCompleted: 0,
        tradesCut: 0,
    };
    // Wait for WebSocket data
    console.log('   ⏳ Waiting for order book data...');
    await new Promise(r => setTimeout(r, 3000));
    console.log('   🚀 Starting market maker loop...\n');
    // Main loop
    while (state.status !== 'BLOCKED') {
        try {
            if (state.status === 'COMPLETE') {
                // Reset for next trade
                console.log(`\n   🔄 Resetting for next trade...`);
                state.status = 'IDLE';
                state.upPosition = 0;
                state.downPosition = 0;
                await new Promise(r => setTimeout(r, 2000));
            }
            // Handle one-sided states (should be handled by handleOneSidedFill, but check anyway)
            if (state.status === 'ONE_SIDED_UP' || state.status === 'ONE_SIDED_DOWN') {
                // Already handled, just wait a bit
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            // Update quotes
            await updateQuotes();
            // Check for fills
            if (state.status === 'QUOTING') {
                await new Promise(r => setTimeout(r, CONFIG.POSITION_CHECK_INTERVAL_MS));
                await checkFills();
            }
            // Wait before next iteration
            await new Promise(r => setTimeout(r, CONFIG.REQUOTE_INTERVAL_MS));
        }
        catch (error) {
            console.error(`Error in market maker loop: ${error.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`   MARKET MAKER STOPPED`);
    console.log(`${'='.repeat(60)}`);
    printStats();
}
export function printStats() {
    console.log(`\nStats:`);
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
    if (state) {
        state.status = 'BLOCKED';
    }
    cancelAllOrders();
    disconnectOrderBookWebSocket();
    printStats();
}
//# sourceMappingURL=market-maker.js.map