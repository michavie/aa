/**
 * Testable AgentSender extracted from run.ts logic.
 * All external dependencies (HTTP, signing) are stubbed.
 */

export interface SharedState {
  isGreenLight: boolean;
}

export function makeSharedState(isGreenLight: boolean): SharedState {
  return { isGreenLight };
}

interface TestSenderOptions {
  chainNonce: number;
  sharedState?: SharedState;
  batchSize?: number;
  onBuildTx?: (buildCount: number) => void;
}

export class AgentSenderTestable {
  localNonce  = BigInt(0);
  nonceSynced = false;
  statTotal     = 0;
  statPermitted = 0;
  broadcastCalls: any[] = [];

  private txQueue:   any[] = [];
  private building = false;
  private batchSize: number;
  private chainNonce: number;
  private buildCount = 0;
  private onBuildTx?: (count: number) => void;

  constructor(opts: TestSenderOptions) {
    this.chainNonce  = opts.chainNonce;
    this.batchSize   = opts.batchSize ?? 10;
    this.onBuildTx   = opts.onBuildTx;
  }

  // Testable syncNonce — accepts forced chain nonce override for tests
  async syncNonce(force = false, chainNonceOverride?: number): Promise<void> {
    const chainNonce = BigInt(chainNonceOverride ?? this.chainNonce);
    if (force || chainNonce > this.localNonce || !this.nonceSynced) {
      this.localNonce = chainNonce;
      this.nonceSynced = true;
      if (force) this.txQueue = [];
    }
  }

  nextNonce(): bigint { return this.localNonce++; }

  private async buildTx(nonce: bigint): Promise<any> {
    this.buildCount++;
    if (this.onBuildTx) this.onBuildTx(this.buildCount);
    return { nonce: Number(nonce) };
  }

  async fireBatch(state: SharedState): Promise<void> {
    if (!this.nonceSynced) return;

    let batch: any[] = this.txQueue.splice(0, this.batchSize);
    if (batch.length < this.batchSize) {
      const needed = this.batchSize - batch.length;
      for (let i = 0; i < needed; i++) {
        if (!state.isGreenLight) return; // abort if RED mid-build
        batch.push(await this.buildTx(this.nextNonce()));
      }
    }

    const results = await Promise.all(
      batch.map(async (tx) => {
        if (!state.isGreenLight) return false; // don't broadcast if already RED
        this.broadcastCalls.push(tx);
        return true;
      })
    );

    const sent = results.filter(Boolean).length;
    this.statTotal += sent;
    if (state.isGreenLight) this.statPermitted += sent;
  }

  async prefill(state: SharedState): Promise<void> {
    if (this.building || !this.nonceSynced || !state.isGreenLight) return;
    if (this.txQueue.length >= this.batchSize * 2) return;

    this.building = true;
    try {
      const toAdd = this.batchSize * 2 - this.txQueue.length;
      for (let i = 0; i < toAdd; i++) {
        if (!state.isGreenLight) break;
        this.txQueue.push(await this.buildTx(this.nextNonce()));
      }
    } finally {
      this.building = false;
    }
  }
}

export function makeTestSender(opts: TestSenderOptions): AgentSenderTestable {
  return new AgentSenderTestable(opts);
}
