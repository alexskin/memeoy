// Wraps a Filter whose underlying on-chain fact is monotonic - once it
// passes, it structurally cannot go back to failing. LP burn and mint/freeze
// authority renouncement are both one-way operations on Solana (a burned LP
// supply can't be un-burned; an authority set to None can never be
// reassigned), so once BurnFilter/RenouncedFreezeFilter report ok:true for a
// given pool, every later re-check within the same filter-match loop
// (runFilterMatchLoop calls execute() up to filterCheckDurationMs/
// filterCheckIntervalMs times) is guaranteed to report the same thing. Only
// wrap filters with this property - PoolSizeFilter (liquidity genuinely
// moves) and MutableFilter's hasSocials (an off-chain fetch, not a pure
// on-chain fact) must NOT be wrapped, they need a fresh read every tick.
import { Filter, FilterResult } from './types';

export class StickyPassFilter<TInput> implements Filter<TInput> {
  private cachedPass: FilterResult | null = null;

  constructor(private readonly inner: Filter<TInput>) {}

  get name() {
    return this.inner.name;
  }

  async execute(input: TInput): Promise<FilterResult> {
    if (this.cachedPass) return this.cachedPass;
    const result = await this.inner.execute(input);
    if (result.ok) this.cachedPass = result;
    return result;
  }
}
