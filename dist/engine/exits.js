"use strict";
/**
 * Exit Logic Module
 * Determines when to exit positions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkExit = checkExit;
exports.getExitReasonDescription = getExitReasonDescription;
const markets_1 = require("../polymarket/markets");
const markets_2 = require("../polymarket/markets");
const client_1 = require("../hltv/client");
const parser_1 = require("../hltv/parser");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
/**
 * Check if a position should be exited
 */
async function checkExit(trade, hltvState) {
    const noExit = { should_exit: false };
    // Check each exit condition
    // 1. Profit target (+8% to +15%)
    const profitCheck = await checkProfitTarget(trade);
    if (profitCheck.should_exit) {
        return profitCheck;
    }
    // 2. Next round completed without repricing
    const roundCheck = checkNextRoundNoReprice(trade, hltvState);
    if (roundCheck.should_exit) {
        return roundCheck;
    }
    // 3. Feed becomes stale
    const feedCheck = checkFeedStale();
    if (feedCheck.should_exit) {
        return feedCheck;
    }
    // 4. Market suspended
    const marketCheck = await checkMarketSuspended(trade.market_id);
    if (marketCheck.should_exit) {
        return marketCheck;
    }
    // 5. Overtime begins
    const overtimeCheck = checkOvertime(hltvState);
    if (overtimeCheck.should_exit) {
        return overtimeCheck;
    }
    return noExit;
}
/**
 * Check profit target exit (+8% to +15%)
 */
async function checkProfitTarget(trade) {
    try {
        const currentPrice = await (0, markets_1.fetchPrice)(trade.token_id);
        const priceChange = currentPrice.yes_price - trade.entry_price;
        const percentChange = priceChange / trade.entry_price;
        // Exit if profit is between 8% and 15%
        if (percentChange >= constants_1.PROFIT_TARGET_MIN && percentChange <= constants_1.PROFIT_TARGET_MAX) {
            logger_1.logger.info('Profit target reached', {
                tradeId: trade.id,
                entryPrice: trade.entry_price,
                currentPrice: currentPrice.yes_price,
                percentChange: (percentChange * 100).toFixed(2) + '%',
            });
            return {
                should_exit: true,
                reason: 'profit_target',
                current_price: currentPrice.yes_price,
            };
        }
        // Also exit if profit exceeds max target
        if (percentChange > constants_1.PROFIT_TARGET_MAX) {
            logger_1.logger.info('Profit exceeds target, taking profit', {
                tradeId: trade.id,
                percentChange: (percentChange * 100).toFixed(2) + '%',
            });
            return {
                should_exit: true,
                reason: 'profit_target',
                current_price: currentPrice.yes_price,
            };
        }
        return { should_exit: false };
    }
    catch (error) {
        logger_1.logger.error('Failed to check profit target', { error, tradeId: trade.id });
        return { should_exit: false };
    }
}
/**
 * Check if next round completed without market repricing
 */
function checkNextRoundNoReprice(trade, hltvState) {
    // If we've moved to a new round since entry
    if (hltvState.round_number > trade.entry_round) {
        // Check if significant time has passed (indicating no reprice)
        const timeSinceEntry = Date.now() - trade.entry_timestamp;
        // If round completed and more than 30 seconds have passed, likely no reprice
        if (timeSinceEntry > 30000) {
            logger_1.logger.info('Next round no reprice - exiting', {
                tradeId: trade.id,
                entryRound: trade.entry_round,
                currentRound: hltvState.round_number,
                timeSinceEntry: timeSinceEntry,
            });
            return {
                should_exit: true,
                reason: 'next_round_no_reprice',
            };
        }
    }
    return { should_exit: false };
}
/**
 * Check if HLTV feed is stale
 */
function checkFeedStale() {
    const hltvClient = (0, client_1.getHLTVClient)();
    if (!hltvClient.isFeedFresh()) {
        logger_1.logger.warn('Feed stale - exiting position');
        return {
            should_exit: true,
            reason: 'feed_stale',
        };
    }
    return { should_exit: false };
}
/**
 * Check if market is suspended
 */
async function checkMarketSuspended(marketId) {
    try {
        const isOpen = await (0, markets_2.isMarketOpen)(marketId);
        if (!isOpen) {
            logger_1.logger.warn('Market suspended - exiting position', { marketId });
            return {
                should_exit: true,
                reason: 'market_suspended',
            };
        }
        return { should_exit: false };
    }
    catch (error) {
        // If we can't check market status, assume it's suspended for safety
        logger_1.logger.error('Failed to check market status', { error, marketId });
        return {
            should_exit: true,
            reason: 'market_suspended',
        };
    }
}
/**
 * Check if overtime has begun
 */
function checkOvertime(hltvState) {
    if ((0, parser_1.isOvertime)(hltvState)) {
        logger_1.logger.warn('Overtime detected - exiting position');
        return {
            should_exit: true,
            reason: 'overtime',
        };
    }
    return { should_exit: false };
}
/**
 * Get exit reason description
 */
function getExitReasonDescription(reason) {
    switch (reason) {
        case 'profit_target':
            return 'Profit target reached (+8% to +15%)';
        case 'next_round_no_reprice':
            return 'Next round completed without market repricing';
        case 'feed_stale':
            return 'HLTV feed became stale';
        case 'market_suspended':
            return 'Market was suspended';
        case 'overtime':
            return 'Overtime began';
        case 'manual':
            return 'Manual exit';
        default:
            return 'Unknown reason';
    }
}
//# sourceMappingURL=exits.js.map