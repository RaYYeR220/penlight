/**
 * The browser Buffer that Next bundles predates the 64-bit BigInt accessors
 * the SDK uses (lot ids are u64 seeds). Add them where they're missing.
 */
import { Buffer as BufferPolyfill } from "buffer";
// The copy Next injects wherever a module uses `Buffer` without importing it.
import { Buffer as NextBuffer } from "next/dist/compiled/buffer";

type Buf = Uint8Array & Record<string, unknown>;

function patch(proto: Buf | undefined) {
  if (!proto || typeof proto.writeBigUInt64LE === "function") return;
  Object.assign(proto, {
    writeBigUInt64LE(this: Uint8Array, value: bigint, offset = 0) {
      let v = BigInt.asUintN(64, BigInt(value));
      for (let i = 0; i < 8; i++) {
        this[offset + i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return offset + 8;
    },
    writeBigUInt64BE(this: Uint8Array, value: bigint, offset = 0) {
      let v = BigInt.asUintN(64, BigInt(value));
      for (let i = 7; i >= 0; i--) {
        this[offset + i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return offset + 8;
    },
    writeBigInt64LE(this: Uint8Array & { writeBigUInt64LE(v: bigint, o?: number): number }, value: bigint, offset = 0) {
      return this.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), offset);
    },
    readBigUInt64LE(this: Uint8Array, offset = 0) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this[offset + i]);
      return v;
    },
    readBigUInt64BE(this: Uint8Array, offset = 0) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this[offset + i]);
      return v;
    },
    readBigInt64LE(this: Uint8Array & { readBigUInt64LE(o?: number): bigint }, offset = 0) {
      return BigInt.asIntN(64, this.readBigUInt64LE(offset));
    },
  });
}

patch(BufferPolyfill.prototype as unknown as Buf);
patch(NextBuffer.prototype as unknown as Buf);
const g = globalThis as unknown as { Buffer?: { prototype: Buf } };
if (g.Buffer) patch(g.Buffer.prototype);
else g.Buffer = BufferPolyfill as unknown as { prototype: Buf };

export {};
