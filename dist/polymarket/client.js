"use strict";
/**
 * Polymarket Client
 * Uses official @polymarket/clob-client SDK
 *
 * Supports both EOA and Polymarket.com proxy wallet accounts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolymarketClient = void 0;
exports.getPolymarketClient = getPolymarketClient;
const clob_client_1 = require("@polymarket/clob-client");
const wallet_1 = require("@ethersproject/wallet");
const logger_1 = require("../logger/logger");
// Chain ID for Polygon
const POLYGON_CHAIN_ID = 137;
// Signature types from Polymarket docs
const SIGNATURE_TYPE_EOA = 0;
const SIGNATURE_TYPE_POLY_PROXY = 1;
const SIGNATURE_TYPE_GNOSIS_SAFE = 2;
class PolymarketClient {
    clobClient = null;
    wallet = null;
    errorCount = 0;
    lastErrorTimestamp = 0;
    isReady = false;
    derivedCreds = null;
    constructor() {
        this.initializeClient();
    }
    /**
     * Initialize the CLOB client with credentials
     */
    async initializeClient() {
        const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
        const proxyWalletAddress = process.env.POLYMARKET_PROXY_WALLET;
        const signatureTypeEnv = process.env.POLYMARKET_SIGNATURE_TYPE;
        if (!privateKey) {
            logger_1.logger.error('Missing POLYMARKET_PRIVATE_KEY');
            return;
        }
        try {
            // Create wallet from private key
            const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
            this.wallet = new wallet_1.Wallet(formattedKey);
            logger_1.logger.info('Polymarket wallet initialized', {
                address: this.wallet.address,
            });
            // Determine signature type and funder address
            let signatureType = SIGNATURE_TYPE_EOA;
            let funderAddress = this.wallet.address;
            if (proxyWalletAddress) {
                // User has a proxy wallet (Polymarket.com account)
                funderAddress = proxyWalletAddress;
                signatureType = signatureTypeEnv === '2' ? SIGNATURE_TYPE_GNOSIS_SAFE : SIGNATURE_TYPE_POLY_PROXY;
                logger_1.logger.info('Using proxy wallet configuration', {
                    signatureType,
                    funderAddress,
                });
            }
            else {
                logger_1.logger.info('Using EOA wallet configuration (no proxy wallet set)');
            }
            // First, create client to derive API credentials
            const tempClient = new clob_client_1.ClobClient('https://clob.polymarket.com', POLYGON_CHAIN_ID, this.wallet);
            // Derive API credentials
            try {
                this.derivedCreds = await tempClient.createOrDeriveApiKey();
                logger_1.logger.info('API credentials derived successfully');
            }
            catch (deriveError) {
                logger_1.logger.error('Could not derive API credentials', { error: deriveError.message });
                return;
            }
            // Now create the actual client with proper signature type and funder
            this.clobClient = new clob_client_1.ClobClient('https://clob.polymarket.com', POLYGON_CHAIN_ID, this.wallet, this.derivedCreds, signatureType, funderAddress);
            this.isReady = true;
            logger_1.logger.info('CLOB client initialized successfully', { signatureType, funderAddress });
        }
        catch (error) {
            logger_1.logger.error('Failed to initialize CLOB client', { error });
        }
    }
    /**
     * Ensure client is initialized (async)
     */
    async ensureInitialized() {
        if (this.isReady)
            return true;
        // Wait a bit for async init
        await new Promise(resolve => setTimeout(resolve, 3000));
        return this.isReady;
    }
    /**
     * Get the underlying CLOB client
     */
    getClobClient() {
        return this.clobClient;
    }
    /**
     * Get wallet address
     */
    getWalletAddress() {
        return this.wallet?.address ?? null;
    }
    /**
     * Check if client is properly initialized
     */
    isInitialized() {
        return this.isReady && this.clobClient !== null && this.wallet !== null;
    }
    /**
     * Get current error count
     */
    getErrorCount() {
        return this.errorCount;
    }
    /**
     * Increment error count
     */
    incrementErrorCount() {
        this.errorCount++;
        this.lastErrorTimestamp = Date.now();
    }
    /**
     * Reset error count
     */
    resetErrorCount() {
        this.errorCount = 0;
    }
    /**
     * Check if API is experiencing issues (error spike)
     */
    isExperiencingErrors() {
        const oneMinuteAgo = Date.now() - 60000;
        return this.errorCount >= 3 && this.lastErrorTimestamp > oneMinuteAgo;
    }
}
exports.PolymarketClient = PolymarketClient;
// Singleton instance
let polymarketClientInstance = null;
function getPolymarketClient() {
    if (!polymarketClientInstance) {
        polymarketClientInstance = new PolymarketClient();
    }
    return polymarketClientInstance;
}
//# sourceMappingURL=client.js.map