/**
 * Dashboard Web Server
 * BTC Up/Down Arbitrage Bot
 */
import express from 'express';
import { EventEmitter } from 'events';
export declare const dashboardEvents: EventEmitter<[never]>;
export interface DashboardStats {
    status: 'running' | 'stopped' | 'initializing';
    startTime: number;
    scanCount: number;
    marketsCount: number;
    arbsFound: number;
    paperTrades: number;
    totalProfit: number;
    totalCost: number;
    pendingPayout: number;
    bestArb: {
        market: string;
        profit: number;
    } | null;
    lastScan: string;
}
/**
 * Push a log message
 */
export declare function pushLog(message: string): void;
/**
 * Update stats
 */
export declare function updateStats(update: Partial<DashboardStats>): void;
/**
 * Get current stats
 */
export declare function getStats(): DashboardStats;
/**
 * Start dashboard server
 */
export declare function startDashboardServer(port?: number): express.Application;
//# sourceMappingURL=server.d.ts.map