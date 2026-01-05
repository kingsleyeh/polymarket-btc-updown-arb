/**
 * Drawdown Monitoring Module
 * Tracks drawdown from peak balance
 */
/**
 * Force refresh balance (call after trades)
 */
export declare function invalidateBalanceCache(): void;
/**
 * Calculate current drawdown from peak
 */
export declare function calculateDrawdown(): Promise<{
    drawdown_amount: number;
    drawdown_percent: number;
    peak_balance: number;
    current_balance: number;
}>;
/**
 * Check if drawdown exceeds maximum allowed
 */
export declare function isDrawdownExceeded(): Promise<{
    exceeded: boolean;
    drawdown_percent: number;
    max_percent: number;
}>;
/**
 * Get remaining drawdown capacity before halt
 */
export declare function getRemainingDrawdownCapacity(): Promise<{
    remaining_amount: number;
    remaining_percent: number;
}>;
/**
 * Log drawdown status
 */
export declare function logDrawdownStatus(): Promise<void>;
//# sourceMappingURL=drawdown.d.ts.map