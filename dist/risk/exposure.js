"use strict";
/**
 * Exposure Management Module
 * Tracks and limits position exposure
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkExposure = checkExposure;
exports.getExposurePercent = getExposurePercent;
exports.getRemainingExposureCapacity = getRemainingExposureCapacity;
exports.getRiskState = getRiskState;
exports.validateTradeSize = validateTradeSize;
const balance_1 = require("../polymarket/balance");
const state_1 = require("../engine/state");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
/**
 * Check if exposure constraints allow trading
 */
async function checkExposure() {
    try {
        const balance = await (0, balance_1.fetchBalance)();
        const currentExposure = (0, state_1.getTotalOpenExposure)();
        const maxExposure = balance.total_balance * constants_1.MAX_EXPOSURE_PERCENT;
        const proposedTradeSize = balance.available_balance * constants_1.POSITION_SIZE_PERCENT;
        // Check if adding this trade would exceed max exposure
        if (currentExposure + proposedTradeSize > maxExposure) {
            logger_1.logger.warn('Exposure limit would be exceeded', {
                currentExposure,
                proposedTradeSize,
                maxExposure,
                totalBalance: balance.total_balance,
            });
            return {
                can_trade: false,
                reason: `Exposure limit: current ${currentExposure.toFixed(2)} + proposed ${proposedTradeSize.toFixed(2)} > max ${maxExposure.toFixed(2)}`,
                current_exposure: currentExposure,
                max_exposure: maxExposure,
            };
        }
        return {
            can_trade: true,
            current_exposure: currentExposure,
            max_exposure: maxExposure,
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to check exposure', { error });
        // Default to no trade on error
        return {
            can_trade: false,
            reason: 'Failed to fetch balance for exposure check',
            current_exposure: 0,
            max_exposure: 0,
        };
    }
}
/**
 * Calculate current exposure percentage
 */
async function getExposurePercent() {
    try {
        const balance = await (0, balance_1.fetchBalance)();
        const currentExposure = (0, state_1.getTotalOpenExposure)();
        if (balance.total_balance === 0) {
            return 0;
        }
        return currentExposure / balance.total_balance;
    }
    catch (error) {
        logger_1.logger.error('Failed to calculate exposure percent', { error });
        return 0;
    }
}
/**
 * Get remaining exposure capacity
 */
async function getRemainingExposureCapacity() {
    try {
        const balance = await (0, balance_1.fetchBalance)();
        const currentExposure = (0, state_1.getTotalOpenExposure)();
        const maxExposure = balance.total_balance * constants_1.MAX_EXPOSURE_PERCENT;
        return Math.max(0, maxExposure - currentExposure);
    }
    catch (error) {
        logger_1.logger.error('Failed to calculate remaining exposure capacity', { error });
        return 0;
    }
}
/**
 * Get full risk state
 */
async function getRiskState() {
    try {
        const balance = await (0, balance_1.fetchBalance)();
        const state = (0, state_1.getState)();
        const currentExposure = (0, state_1.getTotalOpenExposure)();
        const maxExposure = balance.total_balance * constants_1.MAX_EXPOSURE_PERCENT;
        const exposurePercent = balance.total_balance > 0 ? currentExposure / balance.total_balance : 0;
        const drawdownPercent = state.peak_balance > 0
            ? (state.peak_balance - balance.total_balance) / state.peak_balance
            : 0;
        const canTrade = exposurePercent < constants_1.MAX_EXPOSURE_PERCENT;
        return {
            total_exposure: currentExposure,
            exposure_percent: exposurePercent,
            drawdown_percent: drawdownPercent,
            can_trade: canTrade,
            reason: canTrade ? undefined : 'Exposure limit reached',
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to get risk state', { error });
        return {
            total_exposure: 0,
            exposure_percent: 0,
            drawdown_percent: 0,
            can_trade: false,
            reason: 'Failed to fetch risk state',
        };
    }
}
/**
 * Validate proposed trade size against exposure limits
 */
async function validateTradeSize(proposedSize) {
    try {
        const remainingCapacity = await getRemainingExposureCapacity();
        if (proposedSize <= remainingCapacity) {
            return { valid: true };
        }
        // If proposed size exceeds capacity, adjust or reject
        if (remainingCapacity > 0) {
            logger_1.logger.warn('Trade size adjusted to fit exposure limit', {
                proposedSize,
                adjustedSize: remainingCapacity,
            });
            return {
                valid: true,
                adjusted_size: remainingCapacity,
                reason: 'Size adjusted to fit exposure limit',
            };
        }
        return {
            valid: false,
            reason: 'No remaining exposure capacity',
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to validate trade size', { error });
        return {
            valid: false,
            reason: 'Failed to validate trade size',
        };
    }
}
//# sourceMappingURL=exposure.js.map