"use strict";
/**
 * Polymarket Balance Module
 * Handles balance queries using official SDK and Data API
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBalance = fetchBalance;
exports.getAvailableBalance = getAvailableBalance;
exports.getTotalBalance = getTotalBalance;
exports.getLockedBalance = getLockedBalance;
exports.calculateTradeSize = calculateTradeSize;
exports.hasSufficientBalance = hasSufficientBalance;
const axios_1 = __importDefault(require("axios"));
const client_1 = require("./client");
const logger_1 = require("../logger/logger");
// Data API for balance/positions
const DATA_API_URL = 'https://data-api.polymarket.com';
/**
 * Fetch current balance from Polymarket
 * Tries multiple methods to get balance
 */
async function fetchBalance() {
    const client = (0, client_1.getPolymarketClient)();
    const walletAddress = client.getWalletAddress();
    if (!walletAddress) {
        throw new Error('Wallet not initialized');
    }
    // Method 1: Try CLOB client's getBalanceAllowance with COLLATERAL asset type
    try {
        const clobClient = client.getClobClient();
        if (clobClient) {
            // Query COLLATERAL (USDC) balance
            const balanceAllowance = await clobClient.getBalanceAllowance({
                asset_type: 'COLLATERAL',
            });
            // Check if it's an error response
            const result = balanceAllowance;
            if (result?.error) {
                logger_1.logger.warn('CLOB balance returned error', { error: result.error });
            }
            else if (result?.balance !== undefined) {
                // Balance is in smallest units (6 decimals for USDC)
                const rawBalance = parseFloat(result.balance || '0');
                const balance = rawBalance / 1_000_000; // Convert to dollars
                logger_1.logger.info('Balance fetched successfully', {
                    rawBalance,
                    balanceUSD: balance.toFixed(2)
                });
                return {
                    total_balance: balance,
                    locked_balance: 0,
                    available_balance: balance,
                };
            }
        }
    }
    catch (clobError) {
        logger_1.logger.debug('CLOB balance method failed, trying Data API', { error: clobError.message });
    }
    // Method 2: Try Data API with different endpoints
    const endpoints = [
        `${DATA_API_URL}/users/${walletAddress.toLowerCase()}`,
        `${DATA_API_URL}/positions?user=${walletAddress.toLowerCase()}`,
    ];
    for (const url of endpoints) {
        try {
            const response = await axios_1.default.get(url, { timeout: 10000 });
            const data = response.data;
            // Try to extract balance from response
            if (data) {
                const balance = parseFloat(data.balance || data.collateral || data.usdc || '0');
                if (balance > 0 || data.balance !== undefined) {
                    return {
                        total_balance: balance,
                        locked_balance: 0,
                        available_balance: balance,
                    };
                }
            }
        }
        catch (apiError) {
            continue; // Try next endpoint
        }
    }
    // Method 3: If all else fails, return zero balance but don't crash
    // This allows the bot to at least start and scan for markets
    logger_1.logger.warn('Could not fetch balance from any source, using zero balance');
    return {
        total_balance: 0,
        locked_balance: 0,
        available_balance: 0,
    };
}
/**
 * Get available balance for trading
 */
async function getAvailableBalance() {
    const balance = await fetchBalance();
    return balance.available_balance;
}
/**
 * Get total balance
 */
async function getTotalBalance() {
    const balance = await fetchBalance();
    return balance.total_balance;
}
/**
 * Get locked balance
 */
async function getLockedBalance() {
    const balance = await fetchBalance();
    return balance.locked_balance;
}
/**
 * Calculate trade size based on available balance and position size percent
 */
async function calculateTradeSize(positionSizePercent) {
    const available = await getAvailableBalance();
    return available * positionSizePercent;
}
/**
 * Check if sufficient balance exists for a trade
 */
async function hasSufficientBalance(requiredAmount) {
    const available = await getAvailableBalance();
    return available >= requiredAmount;
}
//# sourceMappingURL=balance.js.map