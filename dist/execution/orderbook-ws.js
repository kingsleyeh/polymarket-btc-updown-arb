/**
 * REAL-TIME ORDER BOOK via WebSocket
 *
 * Maintains a live cache of order books - no fetch latency
 */
import WebSocket from 'ws';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
// Cache of order books by token ID
const orderBookCache = new Map();
let ws = null;
let subscribedTokens = new Set();
let isConnected = false;
let reconnectTimeout = null;
/**
 * Connect to WebSocket and start receiving order book updates
 */
export function connectOrderBookWebSocket() {
    return new Promise((resolve) => {
        if (ws && isConnected) {
            resolve(true);
            return;
        }
        try {
            ws = new WebSocket(WS_URL);
            ws.on('open', () => {
                console.log('   📡 Order book WebSocket connected');
                isConnected = true;
                // Re-subscribe to any tokens we were watching
                if (subscribedTokens.size > 0) {
                    subscribeToTokens([...subscribedTokens]);
                }
                resolve(true);
            });
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    handleMessage(message);
                }
                catch (e) {
                    // Ignore parse errors
                }
            });
            ws.on('close', () => {
                console.log('   📡 Order book WebSocket disconnected');
                isConnected = false;
                ws = null;
                // Reconnect after 2 seconds
                if (!reconnectTimeout) {
                    reconnectTimeout = setTimeout(() => {
                        reconnectTimeout = null;
                        connectOrderBookWebSocket();
                    }, 2000);
                }
            });
            ws.on('error', (error) => {
                console.log(`   ⚠️ WebSocket error: ${error.message}`);
                isConnected = false;
            });
            // Timeout if connection takes too long
            setTimeout(() => {
                if (!isConnected) {
                    resolve(false);
                }
            }, 5000);
        }
        catch (error) {
            console.log('   ❌ WebSocket connection failed');
            resolve(false);
        }
    });
}
/**
 * Handle incoming WebSocket message
 */
function handleMessage(message) {
    // Order book update message format
    if (message.event_type === 'book' && message.asset_id) {
        const tokenId = message.asset_id;
        orderBookCache.set(tokenId, {
            asks: message.asks || [],
            bids: message.bids || [],
            timestamp: Date.now(),
        });
    }
    // Price update can also update our cache
    if (message.event_type === 'price_change' && message.asset_id) {
        // Update best bid/ask from price change
        const existing = orderBookCache.get(message.asset_id);
        if (existing && message.price) {
            existing.timestamp = Date.now();
        }
    }
}
/**
 * Subscribe to order book updates for specific tokens
 */
export function subscribeToTokens(tokenIds) {
    if (!ws || !isConnected) {
        // Queue for when we connect
        tokenIds.forEach(id => subscribedTokens.add(id));
        return;
    }
    // Add to our tracked set
    tokenIds.forEach(id => subscribedTokens.add(id));
    // Subscribe via WebSocket
    const subscribeMsg = {
        type: 'market',
        assets_ids: tokenIds,
    };
    try {
        ws.send(JSON.stringify(subscribeMsg));
        console.log(`   📡 Subscribed to ${tokenIds.length} order books`);
    }
    catch (e) {
        console.log('   ⚠️ Failed to subscribe');
    }
}
/**
 * Get cached order book - INSTANT, no network call
 */
export function getCachedOrderBook(tokenId) {
    const cached = orderBookCache.get(tokenId);
    if (!cached) {
        return null;
    }
    // Consider stale if older than 5 seconds
    const age = Date.now() - cached.timestamp;
    if (age > 5000) {
        return null;
    }
    return cached;
}
/**
 * Get best ask price from cached order book
 * Returns null if no cache or no asks
 */
export function getBestAsk(tokenId) {
    const book = getCachedOrderBook(tokenId);
    if (!book || !book.asks || book.asks.length === 0) {
        return null;
    }
    // Asks are sorted descending (highest first), so reverse to get best (lowest)
    const sortedAsks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    const bestAsk = sortedAsks[0];
    return {
        price: parseFloat(bestAsk.price),
        size: parseFloat(bestAsk.size),
    };
}
/**
 * Get the price needed to fill N shares from cached order book
 */
export function getPriceForShares(tokenId, sharesNeeded, label) {
    const book = getCachedOrderBook(tokenId);
    if (!book || !book.asks || book.asks.length === 0) {
        return null;
    }
    // Sort asks ascending (best/lowest first)
    const sortedAsks = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    let sharesAccum = 0;
    let worstPriceNeeded = 0;
    for (const ask of sortedAsks) {
        const askPrice = parseFloat(ask.price);
        const askSize = parseFloat(ask.size);
        sharesAccum += askSize;
        worstPriceNeeded = askPrice;
        if (sharesAccum >= sharesNeeded) {
            console.log(`   📖 ${label}: $${worstPriceNeeded.toFixed(3)} for ${sharesNeeded} shares (${sharesAccum.toFixed(0)} available)`);
            return { price: worstPriceNeeded, available: sharesAccum };
        }
    }
    // Not enough liquidity
    console.log(`   ⚠️ ${label}: Only ${sharesAccum.toFixed(1)} shares available at $${worstPriceNeeded.toFixed(3)}`);
    return { price: worstPriceNeeded, available: sharesAccum };
}
/**
 * Check if we have fresh cached data for both tokens
 */
export function hasFreshCache(upTokenId, downTokenId) {
    const upBook = getCachedOrderBook(upTokenId);
    const downBook = getCachedOrderBook(downTokenId);
    return upBook !== null && downBook !== null;
}
/**
 * Disconnect WebSocket
 */
export function disconnectOrderBookWebSocket() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    isConnected = false;
    orderBookCache.clear();
    subscribedTokens.clear();
}
//# sourceMappingURL=orderbook-ws.js.map