/**
 * Sender tests — fireBatch, prefill, and the GREEN→RED→GREEN transition
 */

import { makeTestSender, makeSharedState } from "./helpers/sender";

describe("fireBatch", () => {
  test("does not send if nonce not synced", async () => {
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 0, sharedState: st });
    sender.nonceSynced = false;
    await sender.fireBatch(st);
    expect(sender.broadcastCalls).toHaveLength(0);
  });

  test("sends BATCH_SIZE transactions when green", async () => {
    const BATCH = 5;
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 0, sharedState: st, batchSize: BATCH });
    sender.nonceSynced = true;
    await sender.fireBatch(st);
    expect(sender.broadcastCalls).toHaveLength(BATCH);
  });

  test("transactions have sequential nonces", async () => {
    const BATCH = 5;
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 10, sharedState: st, batchSize: BATCH });
    sender.localNonce = 10n;
    sender.nonceSynced = true;
    await sender.fireBatch(st);
    const nonces = sender.broadcastCalls.map(tx => tx.nonce);
    expect(nonces).toEqual([10, 11, 12, 13, 14]);
  });

  test("aborts mid-build if state flips to RED", async () => {
    const st = makeSharedState(true);
    const sender = makeTestSender({
      chainNonce: 0,
      sharedState: st,
      batchSize: 5,
      // Flip to RED after 3rd TX is built
      onBuildTx: (count: number) => { if (count >= 3) st.isGreenLight = false; },
    });
    sender.nonceSynced = true;
    await sender.fireBatch(st);
    // Should have aborted before sending anything
    expect(sender.broadcastCalls).toHaveLength(0);
  });

  test("uses pre-built TXs from queue first", async () => {
    const BATCH = 4;
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 0, sharedState: st, batchSize: BATCH });
    sender.nonceSynced = true;
    // Pre-populate queue with 2 TXs
    (sender as any).txQueue = [{ nonce: 0, _prebuilt: true }, { nonce: 1, _prebuilt: true }];
    sender.localNonce = 2n; // queue consumed 0,1; next fresh nonce is 2
    await sender.fireBatch(st);
    // First 2 from queue, next 2 built fresh
    expect(sender.broadcastCalls[0]._prebuilt).toBe(true);
    expect(sender.broadcastCalls[1]._prebuilt).toBe(true);
    expect(sender.broadcastCalls[2]._prebuilt).toBeUndefined();
    expect(sender.broadcastCalls[2].nonce).toBe(2);
  });

  test("increments statPermitted only during green", async () => {
    const BATCH = 3;
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 0, sharedState: st, batchSize: BATCH });
    sender.nonceSynced = true;
    await sender.fireBatch(st);
    expect(sender.statPermitted).toBe(3);
    expect(sender.statTotal).toBe(3);
  });
});

describe("GREEN→RED→GREEN transition", () => {
  test("after force sync, no stale nonces from queue are reused", async () => {
    const st = makeSharedState(true);
    const sender = makeTestSender({ chainNonce: 0, sharedState: st, batchSize: 5 });
    sender.nonceSynced = true;

    // Green window: send 5 TXs (nonces 0-4), prefill builds 5 more in queue (5-9)
    await sender.fireBatch(st);
    (sender as any).txQueue = [
      { nonce: 5 }, { nonce: 6 }, { nonce: 7 }, { nonce: 8 }, { nonce: 9 },
    ];
    sender.localNonce = 10n;

    // Go RED — only 3 TXs confirmed on chain (nonces 0-2)
    st.isGreenLight = false;
    sender.broadcastCalls = [];

    // Force resync: chain confirms nonce = 3
    await sender.syncNonce(true, 3);
    expect(sender.localNonce).toBe(3n);
    expect((sender as any).txQueue).toHaveLength(0); // queue cleared

    // Go GREEN again
    st.isGreenLight = true;
    await sender.fireBatch(st);

    // All 5 TXs must have nonces 3, 4, 5, 6, 7 — no gaps, no reuse of old nonces
    const nonces = sender.broadcastCalls.map(tx => tx.nonce);
    expect(nonces).toEqual([3, 4, 5, 6, 7]);
  });
});
