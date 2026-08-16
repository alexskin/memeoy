# Memeoy

> [!WARNING]
> ## ⚠ DO NOT RUN THIS `main` BRANCH LOCALLY ⚠
> **`main` is the branch meant for the public Vercel dashboard deployment only.** It's what a live public link should point at.
>
> **If you want to self-host the full bot (the worker + dashboard on your own machine), switch to the [`local`](../../tree/local) branch instead.** Running `main` locally works too (the code doesn't actually differ), but `local` is where local setup is documented and intended — use it to avoid confusing yourself about which environment you're in.

An AI-watched Solana memecoin trading bot. Paper mode by default, real market data, zero real funds until you explicitly turn it on.

## What it is

Memeoy watches new Raydium and PumpSwap pools as they're created, runs a chain of safety filters and momentum/revival checks against live DexScreener data, and hands every candidate that clears them to an AI judgment layer before it ever buys: a "degen score" on the token's social presence, a strength score on whether it's a genuine reviving trend or a bait pump, and a final buy/skip call with a written reason. Every decision — bought or skipped — is logged and stays visible, so you can see why the bot did what it did, not just what it did.

Everything runs in **paper mode** by default: simulated fills computed from real on-chain prices, no wallet, no private key, no real transaction ever sent. A self-tuning agent watches the closed trades and adjusts thresholds over time.

## Setup

1. **Clone and install**
   ```bash
   git clone <this-repo-url>
   cd memeoy
   npm install
   ```

2. **Get an RPC endpoint.** The public Solana RPC gets rate-limited almost immediately under this bot's load. Get a free-tier key from [Helius](https://helius.dev), [QuickNode](https://quicknode.com), or [Triton](https://triton.one) — you need both the HTTPS and WSS URLs.

3. **Configure environment**
   ```bash
   cp .env.example .env.local
   ```
   Fill in `RPC_ENDPOINT` and `RPC_WEBSOCKET_ENDPOINT` from step 2. Everything else in `.env.example` is optional — see the comments in that file.

4. **Create the database**
   ```bash
   npm run migrate
   ```

5. **Start the worker** (the always-on process that watches the chain and trades on paper)
   ```bash
   npm run worker
   ```

6. **Start the dashboard**, in a second terminal
   ```bash
   npm run dev -- -p 3010
   ```
   Open [http://localhost:3010](http://localhost:3010).

## Usage

The dashboard has four tabs:

- **Watcher** — the AI pipeline itself, one row per detected pool: filters, momentum, revival pattern (with a strength score), degen score, the final decision with its reasoning, and the outcome. This is the tab to watch.
- **Portfolio** — equity curve, open positions, closed trade history.
- **Strategy** — the live strategy configuration (editable, saved as a new version every time) and the self-tuning agent's proposed changes, which you accept or reject.
- **Wallet Alerts** — add any Solana wallet address to get an advisory notification whenever it buys something, with a suggested stop-loss/target framework. This never opens a position on its own.

The header has four controls: **PAUSE** (stop opening new positions, keep managing open ones), **STOP** (fully unsubscribe from the chain — a harder halt), **START** (resume), and **SELL ALL** (force-close every open position right now, with a confirmation step).

## Run paper mode first

Run it in paper mode for a while before you'd ever consider connecting a real wallet. The self-tuning agent needs a real sample of closed trades to have anything to learn from, and the AI decision layer's judgment quality is easiest to trust once you've watched a few dozen of its calls — bought and skipped both — play out. There's no rush; nothing here has a real-money clock running while you do.

## Going live (optional, real funds)

When you're ready, in the dashboard's **Strategy** tab, change **Trading mode** from `paper` to `live` and save. Before doing that:

1. Set `WALLET_PRIVATE_KEY` in `.env.local` — the secret key of a dedicated wallet you're willing to trade with, as a base58 string or a JSON byte array (the two formats Phantom/Solflare export directly). It's read only when a live swap is actually about to execute, never logged, and never sent anywhere except the local transaction-signing call.
2. That wallet needs an existing **wrapped SOL (WSOL) token account** with the SOL you want to trade with already wrapped into it — wrap some SOL first (Phantom's swap screen, or `spl-token wrap`).
3. Restart the worker after switching modes, so it can seed the dashboard's balance display from your wallet's real balance.

## Public read-only dashboard on Vercel (optional)

You can host a public, read-only mirror of the dashboard on Vercel - useful for showing the bot's paper-trading results to anyone without exposing any controls or requiring a wallet anywhere near it. **Vercel cannot run the worker** (no persistent processes there), so this only ever deploys the dashboard; your worker keeps running wherever it already runs today, and pushes a copy of its data to a small hosted database the Vercel deployment reads from.

1. Create a free [Turso](https://turso.tech) database - either via the [Turso web dashboard](https://app.turso.tech) (create a database, open it, its connection URL is shown on the database's detail page, and you can generate an auth token from there too) or the CLI (`turso db create`, then `turso db show --url` and `turso db tokens create`). Either way you end up with a `libsql://...` URL and a token.
2. Run the one-time schema setup: `npx tsx --env-file=.env.local scripts/migrateTurso.ts` (after adding the two vars below to `.env.local`).
3. Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to your **local** `.env.local` too - this is what turns on your local worker's periodic sync job (every 20s, purely additive, never touches the trading logic).
4. Push this repo to GitHub if you haven't already, then `git checkout -b prod && git push -u origin prod`. This branch is meant to stay in sync with `main` (`git checkout prod && git merge main && git push` to ship an update) - the dashboard code doesn't differ between branches, only which env vars are set where.
5. Create a Vercel project from your GitHub repo, pointed at the `prod` branch. In the Vercel project's environment variables, set:
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - same values as step 3
   - `NEXT_PUBLIC_READ_ONLY=true` - hides every control (PAUSE/STOP/SELL ALL, Strategy editing, wallet add/remove, agent accept/reject)
   - `NEXT_PUBLIC_DISABLE_WS=true` - skips trying to reach your local worker's WebSocket server, which obviously isn't reachable from Vercel; the dashboard still refreshes every 30 seconds via polling
6. Deploy. No wallet, no `WALLET_PRIVATE_KEY`, ever needs to go near Vercel - the public deployment only ever displays paper-trading data your local worker already produced.

This also happens to cost nothing extra in Vercel usage regardless of how much traffic the public link gets: every API route on the dashboard only ever reads Turso, never Solana RPC, so it can't consume your Helius quota no matter how many people load the page.

**Live execution currently only works on Raydium pools.** PumpSwap is the more common venue in practice, but this project has no verified, tested instruction format for its swap instruction — rather than guess at an encoding for a real-money transaction, PumpSwap candidates are skipped with a clear log line in live mode until that's built and verified. Everything else (filters, momentum, revival detection, the AI decision layer, the self-tuning agent) works identically across both modes.

## Disclaimer

Memecoin trading is extremely high risk. This project is not financial advice, carries no warranty, and the authors take no responsibility for losses incurred using it. If and when you connect a real wallet, you are trading with your own funds at your own risk — start small.
