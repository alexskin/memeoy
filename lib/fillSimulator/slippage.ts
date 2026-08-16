// Wraps the Raydium SDK's real reserve-based pricing math (the same
// Liquidity.fetchInfo/computeAmountOut calls repo-reference/bot.ts uses to
// build a real swap). getSimulatedQuote/createRaydiumPriceSource's getQuote
// only ever read - never build or sign a transaction. Prices are derived
// directly from amountIn/amountOut plus known decimals rather than from the
// SDK's Price/Percent objects, so the direction (quote-per-base) stays
// unambiguous for both buy and sell.
//
// executeSwap below is the one exception - it's the real instruction-
// building path, ported from repo-reference/bot.ts's own swap() method
// (already a proven, working implementation there), only ever invoked when
// StrategyConfig.tradingMode === 'live' (see fillSimulator.ts).
import { ComputeBudgetProgram, Connection, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeys, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import BN from 'bn.js';
import { LiveSwapResult, PriceSource, QuoteResult, SwapDirection } from '../priceSource/types';
import { getLiveWallet } from '../solana/wallet';
import { executeAndConfirm } from '../solana/liveTransactionExecutor';
import { StrategyConfig } from '../types';
import { logger } from '../logger';

export async function getSimulatedQuote(
  connection: Connection,
  poolKeys: LiquidityPoolKeys,
  direction: SwapDirection,
  currencyOut: Token,
  amountIn: TokenAmount,
  slippagePct: number,
  baseDecimals: number,
  quoteDecimals: number,
): Promise<QuoteResult> {
  const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });

  const baseReserveUi = Number(poolInfo.baseReserve.toString()) / 10 ** baseDecimals;
  const quoteReserveUi = Number(poolInfo.quoteReserve.toString()) / 10 ** quoteDecimals;
  const midPrice = quoteReserveUi / baseReserveUi;

  const slippage = new Percent(Math.max(0, Math.round(slippagePct * 100)), 10_000);
  const computed = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut,
    slippage,
  });

  const amountInUi = Number(amountIn.raw.toString()) / 10 ** (direction === 'buy' ? quoteDecimals : baseDecimals);
  const amountOutUi =
    Number(computed.amountOut.raw.toString()) / 10 ** (direction === 'buy' ? baseDecimals : quoteDecimals);
  const executionPrice = direction === 'buy' ? amountInUi / amountOutUi : amountOutUi / amountInUi;

  return {
    midPrice,
    executionPrice,
    amountOutRaw: computed.amountOut.raw.toString(),
    minAmountOutRaw: computed.minAmountOut.raw.toString(),
  };
}

// PriceSource adapter - the only place fillSimulator.ts/positionMonitor.ts
// used to reach into Raydium directly. amountInRaw is always expressed in
// the *input* token's raw units (quote for a buy, base for a sell).
export function createRaydiumPriceSource(
  connection: Connection,
  poolKeys: LiquidityPoolKeys,
  quoteToken: Token,
  baseToken: Token,
): PriceSource {
  return {
    venue: 'raydium',
    baseMint: poolKeys.baseMint.toString(),
    baseDecimals: poolKeys.baseDecimals,
    quoteDecimals: poolKeys.quoteDecimals,
    async getQuote(direction, amountInRaw, slippagePct) {
      const inToken = direction === 'buy' ? quoteToken : baseToken;
      const outToken = direction === 'buy' ? baseToken : quoteToken;
      const amountIn = new TokenAmount(inToken, amountInRaw, true);
      return getSimulatedQuote(
        connection,
        poolKeys,
        direction,
        outToken,
        amountIn,
        slippagePct,
        poolKeys.baseDecimals,
        poolKeys.quoteDecimals,
      );
    },

    async executeSwap(direction, amountInRaw, minAmountOutRaw, feeParams): Promise<LiveSwapResult> {
      const wallet = getLiveWallet();

      const [quoteAta, baseAta] = await Promise.all([
        getAssociatedTokenAddress(quoteToken.mint, wallet.publicKey),
        getAssociatedTokenAddress(baseToken.mint, wallet.publicKey),
      ]);
      const ataIn = direction === 'buy' ? quoteAta : baseAta;
      const ataOut = direction === 'buy' ? baseAta : quoteAta;

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys,
          userKeys: { tokenAccountIn: ataIn, tokenAccountOut: ataOut, owner: wallet.publicKey },
          amountIn: new BN(amountInRaw),
          minAmountOut: new BN(minAmountOutRaw),
        },
        poolKeys.version,
      );

      const latestBlockhash = await connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feeParams.computeUnitPriceMicroLamports }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: feeParams.computeUnitLimit }),
          // Buy: the destination (base token) ATA may not exist yet on a
          // brand-new mint - idempotent so it's a no-op if it already does.
          ...(direction === 'buy'
            ? [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, baseAta, wallet.publicKey, baseToken.mint)]
            : []),
          ...innerTransaction.instructions,
          // Sell: the base ATA is empty after this - close it to reclaim rent,
          // same as repo-reference/bot.ts does.
          ...(direction === 'sell' ? [createCloseAccountInstruction(baseAta, wallet.publicKey, wallet.publicKey)] : []),
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);

      const result = await executeAndConfirm(connection, transaction, latestBlockhash);
      if (!result.confirmed) {
        logger.warn({ mint: poolKeys.baseMint.toString(), direction, signature: result.signature, error: result.error }, 'Live Raydium swap did not confirm');
        return result;
      }

      // Read back the actual executed amount from the transaction's own
      // pre/post token balances (the authoritative source for what actually
      // happened) - the destination ATA may have held a pre-existing balance
      // (e.g. re-buying a mint, or the WSOL account on a sell), so this
      // needs the DELTA, not the raw post-balance, same pattern already used
      // by lib/walletTracker/walletLogsListener.ts.
      const outMintStr = (direction === 'buy' ? baseToken : quoteToken).mint.toString();
      const outDecimals = direction === 'buy' ? poolKeys.baseDecimals : poolKeys.quoteDecimals;
      const parsedTx = await connection.getParsedTransaction(result.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      const pre = parsedTx?.meta?.preTokenBalances ?? [];
      const post = parsedTx?.meta?.postTokenBalances ?? [];
      const outPost = post.find((b) => b.mint === outMintStr && b.owner === wallet.publicKey.toString());
      const outPre = outPost ? pre.find((b) => b.accountIndex === outPost.accountIndex) : undefined;
      const amountOutRawBig = outPost ? BigInt(outPost.uiTokenAmount.amount) - BigInt(outPre?.uiTokenAmount.amount ?? '0') : undefined;
      const amountOutRaw = amountOutRawBig !== undefined && amountOutRawBig > 0n ? amountOutRawBig.toString() : undefined;
      const amountInUi = Number(amountInRaw) / 10 ** (direction === 'buy' ? poolKeys.quoteDecimals : poolKeys.baseDecimals);
      const amountOutUi = amountOutRaw ? Number(amountOutRaw) / 10 ** outDecimals : undefined;
      const executionPrice = amountOutUi ? (direction === 'buy' ? amountInUi / amountOutUi : amountOutUi / amountInUi) : undefined;

      return { ...result, amountOutRaw, executionPrice };
    },
  };
}
