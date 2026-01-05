"use strict";
/**
 * Polymarket Orders Module
 * Handles order placement using official SDK
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.placeBuyOrder = placeBuyOrder;
exports.placeSellOrder = placeSellOrder;
exports.cancelOrder = cancelOrder;
exports.getOrderStatus = getOrderStatus;
exports.getOpenOrders = getOpenOrders;
exports.getPositions = getPositions;
exports.hasOpenPosition = hasOpenPosition;
exports.cancelAllOrders = cancelAllOrders;
exports.waitForFill = waitForFill;
const clob_client_1 = require("@polymarket/clob-client");
const client_1 = require("./client");
const logger_1 = require("../logger/logger");
/**
 * Place a buy order
 */
async function placeBuyOrder(request) {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return { success: false, error: 'CLOB client not initialized' };
    }
    try {
        logger_1.logger.info('Placing buy order', {
            market: request.market_id,
            token: request.token_id,
            price: request.price,
            size: request.size,
        });
        // Use CLOB client to create and place order
        const order = await clobClient.createAndPostOrder({
            tokenID: request.token_id,
            price: request.price,
            size: request.size,
            side: clob_client_1.Side.BUY,
        });
        return {
            success: true,
            order_id: order?.id || 'unknown',
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to place buy order', { error, request });
        client.incrementErrorCount();
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Place a sell order
 */
async function placeSellOrder(request) {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return { success: false, error: 'CLOB client not initialized' };
    }
    try {
        logger_1.logger.info('Placing sell order', {
            market: request.market_id,
            token: request.token_id,
            price: request.price,
            size: request.size,
        });
        const order = await clobClient.createAndPostOrder({
            tokenID: request.token_id,
            price: request.price,
            size: request.size,
            side: clob_client_1.Side.SELL,
        });
        return {
            success: true,
            order_id: order?.id || 'unknown',
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to place sell order', { error, request });
        client.incrementErrorCount();
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Cancel an order
 */
async function cancelOrder(orderId) {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return false;
    }
    try {
        await clobClient.cancelOrder({ orderID: orderId });
        logger_1.logger.info('Order cancelled', { orderId });
        return true;
    }
    catch (error) {
        logger_1.logger.error('Failed to cancel order', { error, orderId });
        return false;
    }
}
/**
 * Get order status
 */
async function getOrderStatus(orderId) {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return null;
    }
    try {
        const order = await clobClient.getOrder(orderId);
        if (!order)
            return null;
        return {
            id: order.id,
            market_id: order.market || '',
            token_id: order.asset_id || '',
            side: order.side === clob_client_1.Side.BUY ? 'buy' : 'sell',
            price: parseFloat(order.price || '0'),
            size: parseFloat(order.original_size || '0'),
            status: (order.status || 'open').toLowerCase(),
            filled_size: parseFloat(order.size_matched || '0'),
            created_at: order.created_at ? new Date(order.created_at).getTime() : Date.now(),
        };
    }
    catch (error) {
        logger_1.logger.error('Failed to get order status', { error, orderId });
        return null;
    }
}
/**
 * Get all open orders
 */
async function getOpenOrders() {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return [];
    }
    try {
        const orders = await clobClient.getOpenOrders();
        return (orders || []).map((o) => ({
            id: o.id,
            market_id: o.market || '',
            token_id: o.asset_id || '',
            side: o.side === clob_client_1.Side.BUY ? 'buy' : 'sell',
            price: parseFloat(o.price || '0'),
            size: parseFloat(o.original_size || '0'),
            status: 'open',
            filled_size: parseFloat(o.size_matched || '0'),
            created_at: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
        }));
    }
    catch (error) {
        logger_1.logger.error('Failed to get open orders', { error });
        return [];
    }
}
/**
 * Get positions for a market
 */
async function getPositions(marketId) {
    // Positions need to be fetched from Data API
    return [];
}
/**
 * Check if there's an existing position on a market
 */
async function hasOpenPosition(marketId) {
    const positions = await getPositions(marketId);
    return positions.some((p) => p.size > 0);
}
/**
 * Cancel all open orders
 */
async function cancelAllOrders() {
    const client = (0, client_1.getPolymarketClient)();
    const clobClient = client.getClobClient();
    if (!clobClient) {
        return false;
    }
    try {
        await clobClient.cancelAll();
        logger_1.logger.info('All orders cancelled');
        return true;
    }
    catch (error) {
        logger_1.logger.error('Failed to cancel all orders', { error });
        return false;
    }
}
/**
 * Wait for order to fill with timeout
 */
async function waitForFill(orderId, timeoutMs = 5000) {
    const startTime = Date.now();
    const pollInterval = 200;
    while (Date.now() - startTime < timeoutMs) {
        const order = await getOrderStatus(orderId);
        if (!order) {
            return null;
        }
        if (order.status === 'filled') {
            return order;
        }
        if (order.status === 'cancelled') {
            return order;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    logger_1.logger.warn('Order fill timeout, cancelling', { orderId });
    await cancelOrder(orderId);
    return null;
}
//# sourceMappingURL=orders.js.map