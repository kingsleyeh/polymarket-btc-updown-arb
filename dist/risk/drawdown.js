"use strict";
/**
 * Drawdown Monitoring Module
 * Tracks drawdown from peak balance
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateBalanceCache = invalidateBalanceCache;
exports.calculateDrawdown = calculateDrawdown;
exports.isDrawdownExceeded = isDrawdownExceeded;
exports.getRemainingDrawdownCapacity = getRemainingDrawdownCapacity;
exports.logDrawdownStatus = logDrawdownStatus;
const balance_1 = require("../polymarket/balance");
const state_1 = require("../engine/state");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
// Cache balance to avoid excessive API calls
let cachedBalance = null;
let lastBalanceFetch = 0;
const BALANCE_CACHE_MS = 30_000; // Refresh balance every 30 seconds
/**
 * Get balance with caching to avoid excessive API calls
 */
async function getCachedBalance() {
    const now = Date.now();
    // Return cached value if still fresh
    if (cachedBalance !== null && (now - lastBalanceFetch) < BALANCE_CACHE_MS) {
        return cachedBalance;
    }
    // Fetch fresh balance
    try {
        const balance = await (0, balance_1.fetchBalance)();
        cachedBalance = balance.total_balance;
        lastBalanceFetch = now;
        // Update state with new balance
        (0, state_1.updateBalance)(cachedBalance);
        return cachedBalance;
    }
    catch (error) {
        // If fetch fails, return cached value or state value
        if (cachedBalance !== null) {
            return cachedBalance;
        }
        return (0, state_1.getState)().current_balance;
    }
}
/**
 * Force refresh balance (call after trades)
 */
function invalidateBalanceCache() {
    cachedBalance = null;
    lastBalanceFetch = 0;
}
/**
 * Calculate current drawdown from peak
 */
async function calculateDrawdown() {
    try {
        const currentBalance = await getCachedBalance();
        const state = (0, state_1.getState)();
        const drawdownAmount = state.peak_balance - currentBalance;
        const drawdownPercent = state.peak_balance > 0 ? drawdownAmount / state.peak_balance : 0;
        return {
            drawdown_amount: drawdownAmount,
            drawdown_percent: drawdownPercent,
            peak_balance: state.peak_balance,
            current_balance: currentBalance,
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to calculate drawdown', { error });
        const state = (0, state_1.getState)();
        return {
            drawdown_amount: 0,
            drawdown_percent: 0,
            peak_balance: state.peak_balance,
            current_balance: state.current_balance,
        };
    }
}
/**
 * Check if drawdown exceeds maximum allowed
 */
async function isDrawdownExceeded() {
    const drawdown = await calculateDrawdown();
    const exceeded = drawdown.drawdown_percent > constants_1.MAX_DRAWDOWN_PERCENT;
    if (exceeded) {
        logger_1.logger.warn('Maximum drawdown exceeded', {
            drawdownPercent: (drawdown.drawdown_percent * 100).toFixed(2) + '%',
            maxPercent: (constants_1.MAX_DRAWDOWN_PERCENT * 100).toFixed(2) + '%',
            drawdownAmount: drawdown.drawdown_amount.toFixed(2),
        });
    }
    return {
        exceeded,
        drawdown_percent: drawdown.drawdown_percent,
        max_percent: constants_1.MAX_DRAWDOWN_PERCENT,
    };
}
/**
 * Get remaining drawdown capacity before halt
 */
async function getRemainingDrawdownCapacity() {
    const state = (0, state_1.getState)();
    const maxDrawdownAmount = state.peak_balance * constants_1.MAX_DRAWDOWN_PERCENT;
    const currentDrawdownAmount = state.peak_balance - state.current_balance;
    const remainingAmount = Math.max(0, maxDrawdownAmount - currentDrawdownAmount);
    const remainingPercent = state.peak_balance > 0 ? remainingAmount / state.peak_balance : 0;
    return {
        remaining_amount: remainingAmount,
        remaining_percent: remainingPercent,
    };
}
/**
 * Log drawdown status
 */
async function logDrawdownStatus() {
    const drawdown = await calculateDrawdown();
    const remaining = await getRemainingDrawdownCapacity();
    logger_1.logger.info('Drawdown status', {
        peakBalance: drawdown.peak_balance.toFixed(2),
        currentBalance: drawdown.current_balance.toFixed(2),
        drawdownPercent: (drawdown.drawdown_percent * 100).toFixed(2) + '%',
        remainingCapacity: remaining.remaining_amount.toFixed(2),
        maxAllowed: (constants_1.MAX_DRAWDOWN_PERCENT * 100).toFixed(2) + '%',
    });
}
//# sourceMappingURL=drawdown.js.map