/**
 * Nonce management tests
 *
 * The most critical correctness concern: stale nonces after GREEN→RED→GREEN
 * transitions must not cause duplicate or invalid nonce errors.
 */

import { AgentSenderTestable, makeTestSender } from "./helpers/sender";

describe("Nonce management", () => {
  test("startup sync sets localNonce from chain", async () => {
    const sender = makeTestSender({ chainNonce: 5 });
    await sender.syncNonce();
    expect(sender.localNonce).toBe(5n);
    expect(sender.nonceSynced).toBe(true);
  });

  test("normal sync never moves nonce backward (pending TXs in-flight)", async () => {
    const sender = makeTestSender({ chainNonce: 3 });
    sender.localNonce = 10n;
    sender.nonceSynced = true;
    await sender.syncNonce();          // force=false (default)
    expect(sender.localNonce).toBe(10n); // stays at 10
  });

  test("force sync always accepts chain nonce even if lower than local", async () => {
    const sender = makeTestSender({ chainNonce: 3 });
    sender.localNonce = 10n;
    sender.nonceSynced = true;
    await sender.syncNonce(true);      // force=true (post-RED)
    expect(sender.localNonce).toBe(3n);
  });

  test("force sync clears the pre-built TX queue", async () => {
    const sender = makeTestSender({ chainNonce: 5 });
    sender.localNonce = 10n;
    sender.nonceSynced = true;
    // Simulate pre-built TXs in queue
    (sender as any).txQueue = [{ nonce: 10 }, { nonce: 11 }];
    await sender.syncNonce(true);
    expect((sender as any).txQueue).toHaveLength(0);
    expect(sender.localNonce).toBe(5n);
  });

  test("nonces are sequential and never duplicated across multiple nextNonce calls", () => {
    const sender = makeTestSender({ chainNonce: 0 });
    sender.localNonce = 100n;
    sender.nonceSynced = true;
    const nonces = Array.from({ length: 20 }, () => (sender as any).nextNonce());
    const expected = Array.from({ length: 20 }, (_, i) => BigInt(100 + i));
    expect(nonces).toEqual(expected);
    expect(sender.localNonce).toBe(120n);
  });

  test("after force sync, nextNonce starts from chain nonce (no stale nonces reused)", async () => {
    const sender = makeTestSender({ chainNonce: 7 });
    sender.localNonce = 50n;
    sender.nonceSynced = true;
    (sender as any).txQueue = [{ nonce: 50 }, { nonce: 51 }]; // stale
    await sender.syncNonce(true);
    // Queue cleared, localNonce = 7
    const next = (sender as any).nextNonce();
    expect(next).toBe(7n); // starts clean from chain nonce
  });
});
