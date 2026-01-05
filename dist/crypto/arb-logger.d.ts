/**
 * Arbitrage Logger
 *
 * Writes arb data to CSV and JSON files for offline analysis
 */
import { ArbitrageLogEntry, ScanStats, PaperTrade } from '../types/arbitrage';
/**
 * Initialize log files
 */
export declare function initializeLogFiles(): void;
/**
 * Log an arbitrage entry
 */
export declare function logArbitrage(entry: ArbitrageLogEntry): void;
/**
 * Log a paper trade
 */
export declare function logPaperTrade(trade: PaperTrade): void;
/**
 * Increment scan count
 */
export declare function incrementScanCount(marketsScanned: number): void;
/**
 * Increment arb count
 */
export declare function incrementArbCount(): void;
/**
 * Get current scan stats
 */
export declare function getScanStats(): ScanStats;
/**
 * Get all logged arbs
 */
export declare function getLoggedArbs(): ArbitrageLogEntry[];
/**
 * Reset stats for new session
 */
export declare function resetStats(): void;
//# sourceMappingURL=arb-logger.d.ts.map