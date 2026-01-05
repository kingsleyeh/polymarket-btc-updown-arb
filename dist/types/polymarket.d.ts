/**
 * Polymarket Data Types
 * Market and order types for Polymarket CLOB API
 */
export interface PolymarketBalance {
    total_balance: number;
    locked_balance: number;
    available_balance: number;
}
export interface PolymarketMarket {
    id: string;
    condition_id: string;
    question: string;
    type: string;
    status: 'open' | 'closed' | 'resolved';
    mapNumber?: number;
    team_a_token_id: string;
    team_b_token_id: string;
    team_a_name: string;
    team_b_name: string;
    liquidity: number;
    volume: number;
}
export interface PolymarketPrice {
    token_id: string;
    yes_price: number;
    no_price: number;
    timestamp: number;
}
export interface PolymarketOrderbook {
    market_id: string;
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
    timestamp: number;
}
export interface OrderbookLevel {
    price: number;
    size: number;
}
export interface PolymarketOrder {
    id: string;
    market_id: string;
    token_id: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    status: 'pending' | 'open' | 'filled' | 'cancelled';
    filled_size: number;
    created_at: number;
}
export interface PolymarketPosition {
    market_id: string;
    token_id: string;
    size: number;
    avg_entry_price: number;
    unrealized_pnl: number;
}
export interface PolymarketEvent {
    id: string;
    slug: string;
    title: string;
    markets: PolymarketMarket[];
}
export interface OrderRequest {
    market_id: string;
    token_id: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
}
export interface OrderResponse {
    success: boolean;
    order_id?: string;
    error?: string;
}
//# sourceMappingURL=polymarket.d.ts.map