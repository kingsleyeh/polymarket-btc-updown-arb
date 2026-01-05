"use strict";
/**
 * Real Trade Execution
 *
 * Executes actual trades on Polymarket using CLOB client
 * Fixed $5 per trade
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTrader = initializeTrader;
exports.executeTrade = executeTrade;
exports.getExecutedTrades = getExecutedTrades;
exports.getExecutionStats = getExecutionStats;
exports.isTraderReady = isTraderReady;
const clob_client_1 = require("@polymarket/clob-client");
const ethers_1 = require("ethers");
// Trade size
const TRADE_SIZE_USD = 5; // $5 per trade
// Polymarket chain ID (Polygon)
const CHAIN_ID = 137;
// CLOB API
const CLOB_HOST = 'https://clob.polymarket.com';
// Client singleton
let clobClient = null;
let wallet = null;
const executedTrades = [];
/**
 * Initialize the CLOB client with wallet
 *
 * Per Polymarket docs:
 * - funder = Polymarket Profile Address (proxy wallet) where you send USDC
 * - signer = Private key wallet that signs transactions
 * - signatureType: 0 = Browser Wallet, 1 = Magic/Email Login
 * - Always derive API keys rather than creating new ones
 */
async function initializeTrader() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) {
        console.error('ERROR: POLYMARKET_PRIVATE_KEY not set');
        return false;
    }
    // Polymarket Profile Address (where USDC balance is)
    const funder = process.env.POLYMARKET_PROXY_WALLET || '';
    // 0 = Browser/Metamask, 1 = Magic/Email Login
    const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
    try {
        // Create signer wallet from private key
        wallet = new ethers_1.ethers.Wallet(privateKey);
        console.log(`Signer wallet: ${wallet.address}`);
        console.log(`Funder (profile): ${funder || 'not set'}`);
        console.log(`Signature type: ${signatureType} (${signatureType === 1 ? 'Magic/Email' : 'Browser'})`);
        // Step 1: Create basic client to derive API credentials
        console.log('Deriving API credentials...');
        const basicClient = new clob_client_1.ClobClient(CLOB_HOST, CHAIN_ID, wallet);
        const creds = await basicClient.createOrDeriveApiKey();
        console.log(`API Key: ${creds.key?.slice(0, 8)}...`);
        // Step 2: Create full client with credentials, signature type, and funder
        clobClient = new clob_client_1.ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, signatureType, funder);
        // Verify by checking balance
        try {
            const balance = await clobClient.getBalanceAllowance({ asset_type: clob_client_1.AssetType.COLLATERAL });
            const usdBalance = parseFloat(balance.balance || '0') / 1_000_000;
            console.log(`Balance: $${usdBalance.toFixed(2)} USDC`);
            if (usdBalance < TRADE_SIZE_USD) {
                console.warn(`WARNING: Low balance. Need $${TRADE_SIZE_USD}, have $${usdBalance.toFixed(2)}`);
                // Continue anyway - balance might be in a different format or we might still be able to trade
            }
        }
        catch (balanceError) {
            console.warn(`WARNING: Could not fetch balance: ${balanceError.message}`);
            console.log('Continuing anyway - will check balance on trade execution');
        }
        return true;
    }
    catch (error) {
        console.error('Failed to initialize trader:', error.message);
        return false;
    }
}
/**
 * Execute arbitrage trade - buy both Up and Down
 */
async function executeTrade(arb) {
    if (!clobClient || !wallet) {
        console.error('Trader not initialized');
        return null;
    }
    const now = Date.now();
    // Calculate shares to buy with $5
    // We need to buy BOTH sides, so split the $5
    // Actually no - we buy $5 worth of EACH side
    // Total cost = shares * (up_price + down_price)
    // We want total cost = $5
    // shares = $5 / combined_cost
    const shares = Math.floor(TRADE_SIZE_USD / arb.combined_cost);
    if (shares < 1) {
        console.log('Trade too small - skipping');
        return null;
    }
    const trade = {
        id: `trade-${now}`,
        market_id: arb.market_id,
        market_title: arb.market_title,
        up_order_id: null,
        down_order_id: null,
        up_price: arb.up_price,
        down_price: arb.down_price,
        combined_cost: arb.combined_cost,
        shares,
        cost_usd: shares * arb.combined_cost,
        guaranteed_payout: shares * 1.0, // $1 per share at expiry
        profit_usd: shares * (1.0 - arb.combined_cost),
        timestamp: now,
        expiry_timestamp: arb.expiry_timestamp,
        status: 'pending',
    };
    try {
        console.log(`\n💰 EXECUTING TRADE: ${arb.market_title}`);
        console.log(`   Buying ${shares} shares @ $${arb.combined_cost.toFixed(4)}`);
        console.log(`   Cost: $${trade.cost_usd.toFixed(2)} | Payout: $${trade.guaranteed_payout.toFixed(2)} | Profit: $${trade.profit_usd.toFixed(2)}`);
        // Buy UP shares
        console.log(`   Buying UP @ $${arb.up_price.toFixed(3)}...`);
        let upOrder;
        try {
            upOrder = await clobClient.createAndPostOrder({
                tokenID: arb.up_token_id,
                price: arb.up_price,
                size: shares,
                side: clob_client_1.Side.BUY,
            });
            if (!upOrder || !upOrder.orderID) {
                throw new Error('No order ID returned');
            }
            trade.up_order_id = upOrder.orderID;
            console.log(`   ✓ UP order: ${trade.up_order_id}`);
        }
        catch (upError) {
            const errMsg = upError.message || 'Unknown error';
            if (errMsg.includes('403') || errMsg.includes('blocked') || errMsg.includes('Cloudflare')) {
                console.error(`   ❌ UP order BLOCKED by Cloudflare - Replit IPs are blocked`);
                console.error(`   ⚠️  Run this bot locally or on a VPS to execute trades`);
            }
            else {
                console.error(`   ❌ UP order failed: ${errMsg}`);
            }
            throw upError;
        }
        // Buy DOWN shares
        console.log(`   Buying DOWN @ $${arb.down_price.toFixed(3)}...`);
        let downOrder;
        try {
            downOrder = await clobClient.createAndPostOrder({
                tokenID: arb.down_token_id,
                price: arb.down_price,
                size: shares,
                side: clob_client_1.Side.BUY,
            });
            if (!downOrder || !downOrder.orderID) {
                throw new Error('No order ID returned');
            }
            trade.down_order_id = downOrder.orderID;
            console.log(`   ✓ DOWN order: ${trade.down_order_id}`);
        }
        catch (downError) {
            const errMsg = downError.message || 'Unknown error';
            if (errMsg.includes('403') || errMsg.includes('blocked') || errMsg.includes('Cloudflare')) {
                console.error(`   ❌ DOWN order BLOCKED by Cloudflare - Replit IPs are blocked`);
                console.error(`   ⚠️  Run this bot locally or on a VPS to execute trades`);
            }
            else {
                console.error(`   ❌ DOWN order failed: ${errMsg}`);
            }
            throw downError;
        }
        trade.status = 'filled';
        console.log(`   ✅ TRADE COMPLETE - Profit locked: $${trade.profit_usd.toFixed(2)}`);
    }
    catch (error) {
        trade.status = 'failed';
        trade.error = error.message;
        console.error(`   ❌ TRADE FAILED: ${error.message}`);
    }
    executedTrades.push(trade);
    return trade;
}
/**
 * Get all executed trades
 */
function getExecutedTrades() {
    return [...executedTrades];
}
/**
 * Get execution stats
 */
function getExecutionStats() {
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
function isTraderReady() {
    return clobClient !== null && wallet !== null;
}
//# sourceMappingURL=trader.js.map