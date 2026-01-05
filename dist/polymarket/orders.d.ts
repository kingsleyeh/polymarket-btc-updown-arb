/**
 * Polymarket Orders Module
 * Handles order placement using official SDK
 */
import { PolymarketOrder, PolymarketPosition, OrderRequest, OrderResponse } from '../types/polymarket';
/**
 * Place a buy order
 */
export declare function placeBuyOrder(request: OrderRequest): Promise<OrderResponse>;
/**
 * Place a sell order
 */
export declare function placeSellOrder(request: OrderRequest): Promise<OrderResponse>;
/**
 * Cancel an order
 */
export declare function cancelOrder(orderId: string): Promise<boolean>;
/**
 * Get order status
 */
export declare function getOrderStatus(orderId: string): Promise<PolymarketOrder | null>;
/**
 * Get all open orders
 */
export declare function getOpenOrders(): Promise<PolymarketOrder[]>;
/**
 * Get positions for a market
 */
export declare function getPositions(marketId?: string): Promise<PolymarketPosition[]>;
/**
 * Check if there's an existing position on a market
 */
export declare function hasOpenPosition(marketId: string): Promise<boolean>;
/**
 * Cancel all open orders
 */
export declare function cancelAllOrders(): Promise<boolean>;
/**
 * Wait for order to fill with timeout
 */
export declare function waitForFill(orderId: string, timeoutMs?: number): Promise<PolymarketOrder | null>;
//# sourceMappingURL=orders.d.ts.map