/**
 * Exposure Management Module
 * Tracks and limits position exposure
 */
import { RiskState } from '../types/state';
/**
 * Check if exposure constraints allow trading
 */
export declare function checkExposure(): Promise<{
    can_trade: boolean;
    reason?: string;
    current_exposure: number;
    max_exposure: number;
}>;
/**
 * Calculate current exposure percentage
 */
export declare function getExposurePercent(): Promise<number>;
/**
 * Get remaining exposure capacity
 */
export declare function getRemainingExposureCapacity(): Promise<number>;
/**
 * Get full risk state
 */
export declare function getRiskState(): Promise<RiskState>;
/**
 * Validate proposed trade size against exposure limits
 */
export declare function validateTradeSize(proposedSize: number): Promise<{
    valid: boolean;
    adjusted_size?: number;
    reason?: string;
}>;
//# sourceMappingURL=exposure.d.ts.map