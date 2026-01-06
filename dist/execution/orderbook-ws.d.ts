/**
 * REAL-TIME ORDER BOOK via WebSocket
 *
 * Maintains a live cache of order books - no fetch latency
 */
interface OrderBookLevel {
    price: string;
    size: string;
}
interface OrderBook {
    asks: OrderBookLevel[];
    bids: OrderBookLevel[];
    timestamp: number;
}
/**
 * Connect to WebSocket and start receiving order book updates
 */
export declare function connectOrderBookWebSocket(): Promise<boolean>;
/**
 * Subscribe to order book updates for specific tokens
 */
export declare function subscribeToTokens(tokenIds: string[]): void;
/**
 * Get cached order book - INSTANT, no network call
 */
export declare function getCachedOrderBook(tokenId: string): OrderBook | null;
/**
 * Get best ask price from cached order book
 * Returns null if no cache or no asks
 */
export declare function getBestAsk(tokenId: string): {
    price: number;
    size: number;
} | null;
/**
 * Get the price needed to fill N shares from cached order book
 */
export declare function getPriceForShares(tokenId: string, sharesNeeded: number, label: string): {
    price: number;
    available: number;
} | null;
/**
 * Get best bid price from cached order book
 * Returns null if no cache or no bids
 */
export declare function getBestBid(tokenId: string): {
    price: number;
    size: number;
} | null;
/**
 * Check if we have fresh cached data for both tokens
 */
export declare function hasFreshCache(upTokenId: string, downTokenId: string): boolean;
/**
 * Disconnect WebSocket
 */
export declare function disconnectOrderBookWebSocket(): void;
export {};
//# sourceMappingURL=orderbook-ws.d.ts.map