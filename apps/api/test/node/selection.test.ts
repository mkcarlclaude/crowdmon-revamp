import { describe, expect, it } from "vitest";
import { hammingDistance, selectDiverse } from "../../src/selection";

/**
 * A 16-character hex phash whose set bits are exactly `bits` — the same
 * rendering `frames.Hash.Hex()` writes into `images.phash`
 * (`worker/internal/frames/frames.go`), built here from a bit count so a test
 * can state "these two differ in 3 places" instead of asserting on a magic
 * literal.
 */
function phash(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

/** A hash with the low `n` bits set: distance from `phash(0n)` is exactly n. */
function lowBits(n: number): string {
  return phash((1n << BigInt(n)) - 1n);
}

describe("hammingDistance", () => {
  it("is zero for identical hashes", () => {
    expect(hammingDistance("00000000deadbeef", "00000000deadbeef")).toBe(0);
  });

  it("counts every differing bit across the full 64", () => {
    expect(hammingDistance(phash(0n), phash(0xffffffffffffffffn))).toBe(64);
  });

  // The high word is the half a 32-bit implementation silently drops, which
  // is why it is asserted separately from the low one: `0x8000000000000000`
  // and `0` are identical under `Number` bitwise ops (which truncate to 32
  // bits) and differ by exactly one bit in truth.
  it("counts bits in the high word, not just the low 32", () => {
    expect(hammingDistance(phash(0n), phash(1n << 63n))).toBe(1);
    expect(hammingDistance(phash(0n), phash(1n << 31n))).toBe(1);
  });

  // The bit-counting inside `hammingDistance` is SWAR — branchless, and
  // exactly the kind of code that is off by one bit for one input class and
  // right for every case a hand-written test happens to pick. This pins it
  // against the naive definition (Go's `popcount` in
  // `worker/internal/frames/frames.go`, transcribed) over hashes spanning the
  // full 64-bit range, so the optimisation cannot drift from the definition
  // it replaced.
  it("agrees with a naive bit count across the whole 64-bit range", () => {
    function naive(a: string, b: string): number {
      let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
      let bits = 0;
      while (diff !== 0n) {
        diff &= diff - 1n;
        bits++;
      }
      return bits;
    }

    // A deterministic spread rather than `Math.random()`: a property test
    // that fails only on some runs is a test nobody can act on.
    const hashes = Array.from({ length: 200 }, (_, i) =>
      ((BigInt(i) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn).toString(16).padStart(16, "0"),
    );

    for (const a of hashes) {
      for (const b of hashes) {
        expect(hammingDistance(a, b)).toBe(naive(a, b));
      }
    }
  });

  it("is symmetric", () => {
    expect(hammingDistance("0f0f0f0f0f0f0f0f", "00ff00ff00ff00ff")).toBe(
      hammingDistance("00ff00ff00ff00ff", "0f0f0f0f0f0f0f0f"),
    );
  });
});

describe("selectDiverse", () => {
  it("returns nothing when there are no candidates", () => {
    expect(selectDiverse({ candidates: [], reference: [], budget: 10 })).toEqual([]);
  });

  it("returns every candidate when the budget exceeds the pool", () => {
    const candidates = [
      { id: 1, phash: lowBits(1) },
      { id: 2, phash: lowBits(2) },
    ];
    expect(selectDiverse({ candidates, reference: [], budget: 10 }).map((c) => c.id)).toEqual([
      1, 2,
    ]);
  });

  it("picks the candidate farthest from the reference set first", () => {
    const candidates = [
      { id: 1, phash: lowBits(2) }, // 2 bits from the reference
      { id: 2, phash: lowBits(40) }, // 40 bits from the reference
      { id: 3, phash: lowBits(6) }, // 6 bits from the reference
    ];
    const picked = selectDiverse({
      candidates,
      reference: [phash(0n)],
      budget: 1,
    });
    expect(picked.map((c) => c.id)).toEqual([2]);
  });

  // The failure mode the plan names: a selector that only maximises distance
  // from the *reference* set returns the same far-away frame N times over,
  // because every near-duplicate of it scores identically well. Each pick has
  // to join the set the next pick is measured against.
  it("does not fill the budget with near-duplicates of its own first pick", () => {
    const candidates = [
      { id: 1, phash: lowBits(40) }, // 40 bits from the reference: picked first
      { id: 2, phash: lowBits(39) }, // one bit from id 1
      { id: 3, phash: lowBits(38) }, // two bits from id 1
      { id: 4, phash: lowBits(20) }, // 20 bits from every one of the above
    ];
    const picked = selectDiverse({
      candidates,
      reference: [phash(0n)],
      budget: 2,
    });
    expect(picked.map((c) => c.id)).toEqual([1, 4]);
  });

  it("spreads across the pool when there is no reference set at all", () => {
    // A first-ever pass over a video nothing has sampled: with no reference
    // to be far from, the first pick is arbitrary (the pool's own head) and
    // every pick after it is farthest-from-the-picks.
    const candidates = [
      { id: 1, phash: lowBits(0) },
      { id: 2, phash: lowBits(1) },
      { id: 3, phash: lowBits(64) },
    ];
    const picked = selectDiverse({ candidates, reference: [], budget: 2 });
    expect(picked.map((c) => c.id)).toEqual([1, 3]);
  });

  it("is deterministic for the same pool, reference and budget", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      phash: phash(BigInt(i) * 0x0123456789abcdefn),
    }));
    const reference = [phash(0n), phash(0xffff0000ffff0000n)];
    const first = selectDiverse({ candidates, reference, budget: 12 });
    const second = selectDiverse({ candidates, reference, budget: 12 });
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(first).toHaveLength(12);
  });

  it("never returns the same candidate twice", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      // Deliberately degenerate: every candidate is the identical frame, so
      // every distance is zero and the greedy pick has no signal to order by.
      // It must still return 8 distinct rows rather than one row eight times.
      phash: phash(0x1234123412341234n),
    }));
    const picked = selectDiverse({ candidates, reference: [], budget: 8 });
    expect(new Set(picked.map((c) => c.id)).size).toBe(8);
  });

  it("rejects a phash the Go side could not have written", () => {
    expect(() => hammingDistance("not-a-hash", phash(0n))).toThrow(/not a 16-character hex hash/);
  });
});
