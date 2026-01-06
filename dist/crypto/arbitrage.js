/**
 * BTC Up/Down Arbitrage Detection
 *
 * Detects opportunities where:
 * buy_up_price + buy_down_price < 1.00 - MIN_EDGE
 *
 * Uses WebSocket cache for instant price access
 */
import axios from 'axios';
import { CLOB_API_URL, MIN_EDGE, EXPIRY_CUTOFF_SECONDS, PAPER_MAX_SHARES } from '../config/constants';
import { getBestAsk, hasFreshCache } from '../execution/orderbook-ws';
// Track active arbitrage opportunities
const activeArbs = new Map();
/**
 * Fetch current prices for a market
 * PRIORITY: WebSocket cache (instant) → REST fallback
 */
export async function fetchMarketPrices(market) {
    // TRY WEBSOCKET CACHE FIRST (instant, no latency)
    if (hasFreshCache(market.up_token_id, market.down_token_id)) {
        const upAsk = getBestAsk(market.up_token_id);
        const downAsk = getBestAsk(market.down_token_id);
        if (upAsk && downAsk) {
            return {
                market_id: market.id,
                up_price: upAsk.price,
                down_price: downAsk.price,
                up_shares_available: upAsk.size,
                down_shares_available: downAsk.size,
                timestamp: Date.now(),
            };
        }
    }
    // FALLBACK TO REST (slower but reliable)
    try {
        const [upBook, downBook] = await Promise.all([
            axios.get(`${CLOB_API_URL}/book`, {
                params: { token_id: market.up_token_id },
                timeout: 2000,
            }),
            axios.get(`${CLOB_API_URL}/book`, {
                params: { token_id: market.down_token_id },
                timeout: 2000,
            }),
        ]);
        // Get best asks (sorted ascending - lowest first)
        const upAsks = (upBook.data?.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        const downAsks = (downBook.data?.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        if (upAsks.length === 0 || downAsks.length === 0) {
            return null;
        }
        const upPrice = parseFloat(upAsks[0].price);
        const downPrice = parseFloat(downAsks[0].price);
        const upShares = parseFloat(upAsks[0].size);
        const downShares = parseFloat(downAsks[0].size);
        return {
            market_id: market.id,
            up_price: upPrice,
            down_price: downPrice,
            up_shares_available: upShares,
            down_shares_available: downShares,
            timestamp: Date.now(),
        };
    }
    catch (error) {
        return null;
    }
}
/**
 * Check if arbitrage opportunity exists
 *
 * Arb condition: up_price + down_price < 1.00 - MIN_EDGE
 */
export function checkArbitrage(market, prices) {
    const now = Date.now();
    const timeToExpiry = (market.expiry_timestamp - now) / 1000;
    // Skip if too close to expiry
    if (timeToExpiry <= EXPIRY_CUTOFF_SECONDS) {
        return null;
    }
    // Skip if either side has zero liquidity
    if (prices.up_shares_available === 0 || prices.down_shares_available === 0) {
        return null;
    }
    const combinedCost = prices.up_price + prices.down_price;
    const threshold = 1.0 - MIN_EDGE;
    // No arbitrage if combined cost >= threshold
    if (combinedCost >= threshold) {
        return null;
    }
    // Calculate profit
    const edge = 1.0 - combinedCost;
    const profitPerShare = edge;
    // Calculate executable shares (limited by liquidity and max)
    const executableShares = Math.min(prices.up_shares_available, prices.down_shares_available, PAPER_MAX_SHARES);
    const totalProfit = executableShares * profitPerShare;
    // Generate unique arb ID
    const arbId = `${market.id}-${now}`;
    return {
        id: arbId,
        market_id: market.id,
        market_title: market.question,
        up_token_id: market.up_token_id,
        down_token_id: market.down_token_id,
        up_price: prices.up_price,
        down_price: prices.down_price,
        combined_cost: combinedCost,
        edge,
        guaranteed_profit_per_share: profitPerShare,
        executable_shares: executableShares,
        total_profit: totalProfit,
        up_shares_available: prices.up_shares_available,
        down_shares_available: prices.down_shares_available,
        expiry_timestamp: market.expiry_timestamp,
        time_to_expiry_seconds: timeToExpiry,
        first_detected_at: now,
        last_seen_at: now,
        consecutive_cycles: 1,
    };
}
/**
 * Update existing arbitrage tracking or create new
 */
export function updateArbTracking(marketId, newArb, prices) {
    const existing = activeArbs.get(marketId);
    // Case 1: No arb exists and none found
    if (!existing && !newArb) {
        return { arb: null, status: 'none' };
    }
    // Case 2: New arb found (none existed before)
    if (!existing && newArb) {
        activeArbs.set(marketId, newArb);
        return { arb: newArb, status: 'new' };
    }
    // Case 3: Arb existed but now gone
    if (existing && !newArb) {
        activeArbs.delete(marketId);
        // Determine close reason
        let closeReason = 'price_moved';
        if (prices) {
            if (prices.up_shares_available === 0 || prices.down_shares_available === 0) {
                closeReason = 'liquidity_exhausted';
            }
        }
        const now = Date.now();
        const timeToExpiry = (existing.expiry_timestamp - now) / 1000;
        if (timeToExpiry <= EXPIRY_CUTOFF_SECONDS) {
            closeReason = 'expiry_cutoff';
        }
        return {
            arb: null,
            status: 'closed',
            closedArb: existing,
            closeReason,
        };
    }
    // Case 4: Arb still exists - update tracking
    if (existing && newArb) {
        const updated = {
            ...newArb,
            id: existing.id, // Keep original ID
            first_detected_at: existing.first_detected_at,
            consecutive_cycles: existing.consecutive_cycles + 1,
        };
        activeArbs.set(marketId, updated);
        return { arb: updated, status: 'updated' };
    }
    return { arb: null, status: 'none' };
}
/**
 * Get all active arbitrage opportunities
 */
export function getActiveArbs() {
    return Array.from(activeArbs.values());
}
/**
 * Clear all tracked arbs
 */
export function clearArbs() {
    activeArbs.clear();
}
/**
 * Get persistence duration in seconds
 */
export function getArbPersistence(arb) {
    return (arb.last_seen_at - arb.first_detected_at) / 1000;
}
//# sourceMappingURL=arbitrage.js.map