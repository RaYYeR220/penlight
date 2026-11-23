import { sha256 } from "@noble/hashes/sha2";

const U64_MAX = (1n << 64n) - 1n;

/** Same expansion as the program: sha256(seed ‖ tag ‖ counter_le32), first 8 bytes LE. */
export class Stream {
  private counter = 0;
  constructor(private readonly seed: Uint8Array, private readonly tag: number) {}

  nextU64(): bigint {
    const buf = new Uint8Array(32 + 1 + 4);
    buf.set(this.seed, 0);
    buf[32] = this.tag;
    new DataView(buf.buffer).setUint32(33, this.counter, true);
    this.counter += 1;
    const out = sha256(buf);
    return new DataView(out.buffer, out.byteOffset, 8).getBigUint64(0, true);
  }

  below(n: bigint): bigint {
    const zone = U64_MAX - (U64_MAX % n);
    for (;;) {
      const v = this.nextU64();
      if (v < zone) return v % n;
    }
  }
}

export function derive(seed: Uint8Array, label: Uint8Array): Uint8Array {
  const buf = new Uint8Array(seed.length + label.length);
  buf.set(seed, 0);
  buf.set(label, seed.length);
  return sha256(buf);
}
