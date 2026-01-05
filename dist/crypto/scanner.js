/**
 * BTC Up/Down 15-Minute Market Scanner
 *
 * Finds ONLY the CURRENT BTC 15-minute Up/Down market on Polymarket
 * Series 10192 = Bitcoin 15-minute markets
 */
import axios from 'axios';
import { GAMMA_API_URL, EXPIRY_CUTOFF_SECONDS } from '../config/constants';
/**
 * Check if a market title indicates a 15-minute window (has time range like "12:45PM-1:00PM")
 */
function is15MinuteMarket(question) {
    // 15-minute markets have time ranges like "12:30PM-12:45PM" or "1:00PM-1:15PM"
    const timeRangePattern = /\d{1,2}:\d{2}[AP]M-\d{1,2}:\d{2}[AP]M/i;
    return timeRangePattern.test(question);
}
/**
 * Scan for the CURRENT BTC 15-minute Up/Down market only
 */
export async function scanBTCUpDownMarkets() {
    const markets = [];
    const now = Date.now();
    try {
        // Series 10192 = BTC 15-minute Up/Down markets
        const response = await axios.get(`${GAMMA_API_URL}/events`, {
            params: {
                series_id: 10192,
                active: true,
                closed: false,
                limit: 20,
            },
            timeout: 10000,
        });
        for (const event of response.data || []) {
            const market = event.markets?.[0];
            if (!market)
                continue;
            const question = market.question || event.title || '';
            // MUST be a 15-minute market (has time range in title)
            if (!is15MinuteMarket(question))
                continue;
            // MUST be Bitcoin
            const qLower = question.toLowerCase();
            if (!qLower.includes('bitcoin') && !qLower.includes('btc'))
                continue;
            // Parse outcomes
            let outcomes;
            try {
                outcomes = typeof market.outcomes === 'string'
                    ? JSON.parse(market.outcomes)
                    : market.outcomes || [];
            }
            catch {
                continue;
            }
            if (outcomes.length !== 2)
                continue;
            const hasUp = outcomes.some(o => o.toLowerCase() === 'up');
            const hasDown = outcomes.some(o => o.toLowerCase() === 'down');
            if (!hasUp || !hasDown)
                continue;
            // Get expiry
            const endDate = market.endDate || event.endDate;
            if (!endDate)
                continue;
            const expiryTimestamp = new Date(endDate).getTime();
            const timeToExpiry = (expiryTimestamp - now) / 1000;
            // Skip if already expired or too close to expiry
            if (timeToExpiry <= EXPIRY_CUTOFF_SECONDS)
                continue;
            // Parse tokens
            let tokenIds;
            try {
                tokenIds = typeof market.clobTokenIds === 'string'
                    ? JSON.parse(market.clobTokenIds)
                    : market.clobTokenIds || [];
            }
            catch {
                continue;
            }
            if (tokenIds.length < 2)
                continue;
            const upIndex = outcomes.findIndex(o => o.toLowerCase() === 'up');
            const downIndex = outcomes.findIndex(o => o.toLowerCase() === 'down');
            if (upIndex === -1 || downIndex === -1)
                continue;
            markets.push({
                id: market.id || market.conditionId,
                conditionId: market.conditionId,
                question: question,
                up_token_id: tokenIds[upIndex],
                down_token_id: tokenIds[downIndex],
                expiry_timestamp: expiryTimestamp,
                volume: parseFloat(market.volume || '0'),
                created_at: market.createdAt || '',
            });
        }
    }
    catch (error) {
        console.error('Market scan error:', error.message);
    }
    // Sort by expiry (soonest first) and return only the CURRENT one
    markets.sort((a, b) => a.expiry_timestamp - b.expiry_timestamp);
    // Return only the next upcoming market (the one we can trade)
    return markets.slice(0, 1);
}
/**
 * Get market summary
 */
export function getMarketSummary(markets) {
    const now = Date.now();
    let totalTime = 0;
    let expiringSoon = 0;
    for (const m of markets) {
        const timeToExpiry = (m.expiry_timestamp - now) / 1000;
        totalTime += timeToExpiry;
        if (timeToExpiry < 600)
            expiringSoon++; // < 10 minutes
    }
    return {
        total: markets.length,
        expiring_soon: expiringSoon,
        avg_time_to_expiry: markets.length > 0 ? totalTime / markets.length : 0,
    };
}
//# sourceMappingURL=scanner.js.map