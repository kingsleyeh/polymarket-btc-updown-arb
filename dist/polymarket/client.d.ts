/**
 * Polymarket Client
 * Uses official @polymarket/clob-client SDK
 *
 * Supports both EOA and Polymarket.com proxy wallet accounts
 */
import { ClobClient } from '@polymarket/clob-client';
export declare class PolymarketClient {
    private clobClient;
    private wallet;
    private errorCount;
    private lastErrorTimestamp;
    private isReady;
    private derivedCreds;
    constructor();
    /**
     * Initialize the CLOB client with credentials
     */
    private initializeClient;
    /**
     * Ensure client is initialized (async)
     */
    ensureInitialized(): Promise<boolean>;
    /**
     * Get the underlying CLOB client
     */
    getClobClient(): ClobClient | null;
    /**
     * Get wallet address
     */
    getWalletAddress(): string | null;
    /**
     * Check if client is properly initialized
     */
    isInitialized(): boolean;
    /**
     * Get current error count
     */
    getErrorCount(): number;
    /**
     * Increment error count
     */
    incrementErrorCount(): void;
    /**
     * Reset error count
     */
    resetErrorCount(): void;
    /**
     * Check if API is experiencing issues (error spike)
     */
    isExperiencingErrors(): boolean;
}
export declare function getPolymarketClient(): PolymarketClient;
//# sourceMappingURL=client.d.ts.map