"use strict";
/**
 * Polymarket Markets Module
 * Handles market discovery and price fetching using official APIs
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchEventMarkets = fetchEventMarkets;
exports.fetchPrice = fetchPrice;
exports.fetchOrderbook = fetchOrderbook;
exports.calculateLiquidity = calculateLiquidity;
exports.findMapWinnerMarket = findMapWinnerMarket;
exports.isMarketOpen = isMarketOpen;
exports.getBestBidPrice = getBestBidPrice;
exports.getBestAskPrice = getBestAskPrice;
const axios_1 = __importDefault(require("axios"));
const markets_1 = require("../config/markets");
const logger_1 = require("../logger/logger");
// API endpoints
const CLOB_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
/**
 * Fetch all markets for a CS2 event
 */
async function fetchEventMarkets(eventId) {
    try {
        const response = await axios_1.default.get(`${GAMMA_API_URL}/events/${eventId}`, {
            timeout: 10000,
        });
        const event = response.data;
        const markets = (event.markets || []).map((m) => {
            const mapNumber = (0, markets_1.extractMapNumberFromQuestion)(m.question || '');
            return {
                id: m.id || m.conditionId,
                condition_id: m.conditionId || m.id,
                question: m.question || '',
                type: m.marketType || 'unknown',
                status: m.closed ? 'closed' : m.active !== false ? 'open' : 'closed',
                mapNumber: mapNumber ?? undefined,
                team_a_token_id: m.clobTokenIds?.[0] || '',
                team_b_token_id: m.clobTokenIds?.[1] || '',
                team_a_name: m.outcomes?.[0] || '',
                team_b_name: m.outcomes?.[1] || '',
                liquidity: parseFloat(m.liquidity || '0'),
                volume: parseFloat(m.volume || '0'),
            };
        });
        logger_1.logger.debug('Fetched event markets', { eventId, count: markets.length });
        return markets;
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch event markets', { error, eventId });
        return [];
    }
}
/**
 * Fetch current price for a market token
 */
async function fetchPrice(tokenId) {
    try {
        // Use REST API for price
        const response = await axios_1.default.get(`${CLOB_API_URL}/price`, {
            params: { token_id: tokenId },
            timeout: 5000,
        });
        const yesPrice = parseFloat(response.data?.price || '0.5');
        return {
            token_id: tokenId,
            yes_price: yesPrice,
            no_price: 1 - yesPrice,
            timestamp: Date.now(),
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch price', { error, tokenId });
        return {
            token_id: tokenId,
            yes_price: 0.5,
            no_price: 0.5,
            timestamp: Date.now(),
        };
    }
}
/**
 * Fetch orderbook for a market
 */
async function fetchOrderbook(tokenId) {
    try {
        const response = await axios_1.default.get(`${CLOB_API_URL}/book`, {
            params: { token_id: tokenId },
            timeout: 5000,
        });
        return {
            market_id: tokenId,
            bids: (response.data?.bids || []).map((b) => ({
                price: parseFloat(b.price || '0'),
                size: parseFloat(b.size || '0'),
            })),
            asks: (response.data?.asks || []).map((a) => ({
                price: parseFloat(a.price || '0'),
                size: parseFloat(a.size || '0'),
            })),
            timestamp: Date.now(),
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch orderbook', { error, tokenId });
        return {
            market_id: tokenId,
            bids: [],
            asks: [],
            timestamp: Date.now(),
        };
    }
}
/**
 * Calculate liquidity from orderbook
 */
function calculateLiquidity(orderbook) {
    const bidLiquidity = orderbook.bids.reduce((sum, b) => sum + b.size * b.price, 0);
    const askLiquidity = orderbook.asks.reduce((sum, a) => sum + a.size * a.price, 0);
    return bidLiquidity + askLiquidity;
}
/**
 * Find valid Map Winner market for current map
 */
async function findMapWinnerMarket(eventId, currentMapNumber) {
    const markets = await fetchEventMarkets(eventId);
    for (const market of markets) {
        if (market.type === 'Map Winner' &&
            market.status === 'open' &&
            market.mapNumber === currentMapNumber) {
            try {
                const orderbook = await fetchOrderbook(market.team_a_token_id);
                market.liquidity = calculateLiquidity(orderbook);
                if ((0, markets_1.isValidMapWinnerMarket)(market, currentMapNumber)) {
                    logger_1.logger.info('Found valid Map Winner market', {
                        marketId: market.id,
                        mapNumber: currentMapNumber,
                        liquidity: market.liquidity,
                    });
                    return market;
                }
            }
            catch (error) {
                logger_1.logger.warn('Failed to fetch liquidity for market', { marketId: market.id });
            }
        }
    }
    logger_1.logger.debug('No valid Map Winner market found', { eventId, currentMapNumber });
    return null;
}
/**
 * Check if market is open
 */
async function isMarketOpen(marketId) {
    try {
        const response = await axios_1.default.get(`${GAMMA_API_URL}/markets/${marketId}`, {
            timeout: 5000,
        });
        return response.data?.active === true && response.data?.closed !== true;
    }
    catch (error) {
        logger_1.logger.error('Failed to check market status', { error, marketId });
        return false;
    }
}
/**
 * Get best bid price for a token
 */
async function getBestBidPrice(tokenId) {
    try {
        const orderbook = await fetchOrderbook(tokenId);
        if (orderbook.bids.length === 0) {
            return null;
        }
        return orderbook.bids[0].price;
    }
    catch (error) {
        return null;
    }
}
/**
 * Get best ask price for a token
 */
async function getBestAskPrice(tokenId) {
    try {
        const orderbook = await fetchOrderbook(tokenId);
        if (orderbook.asks.length === 0) {
            return null;
        }
        return orderbook.asks[0].price;
    }
    catch (error) {
        return null;
    }
}
//# sourceMappingURL=markets.js.map