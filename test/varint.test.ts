import { describe, expect, it } from "vitest";
import { VarintReader, VarintWriter, varintSize } from "../src/varint";

describe("varintSize", () => {
  it("returns 1 byte for values 0..127", () => {
    expect(varintSize(0)).toBe(1);
    expect(varintSize(127)).toBe(1);
  });
  it("returns 2 bytes for 128..16383", () => {
    expect(varintSize(128)).toBe(2);
    expect(varintSize(16383)).toBe(2);
  });
  it("returns 5 bytes for u32 max", () => {
    expect(varintSize(0xffffffff)).toBe(5);
  });
});

describe("VarintWriter / VarintReader", () => {
  it("round-trips a sequence of varints", () => {
    const writer = new VarintWriter();
    const values = [0, 1, 127, 128, 16383, 16384, 0x7fffffff, 0xffffffff];
    for (const value of values) {
      writer.writeVarint(value);
    }
    const reader = new VarintReader(writer.toUint8Array());
    for (const expected of values) {
      expect(reader.readVarint()).toBe(expected);
    }
    expect(reader.remaining).toBe(0);
  });

  it("round-trips fixed-width LE integers", () => {
    const writer = new VarintWriter();
    writer.writeUint32LE(0x01020304);
    writer.writeUint16LE(0xbeef);
    writer.writeByte(0x42);
    const reader = new VarintReader(writer.toUint8Array());
    expect(reader.readUint32LE()).toBe(0x01020304);
    expect(reader.readUint16LE()).toBe(0xbeef);
    expect(reader.readByte()).toBe(0x42);
  });

  it("round-trips byte slices including ones larger than its internal buffer", () => {
    const writer = new VarintWriter();
    const big = new Uint8Array(8192);
    for (let index = 0; index < big.length; index += 1) {
      big[index] = index & 0xff;
    }
    writer.writeBytes(big);
    writer.writeVarint(0xdead);
    const reader = new VarintReader(writer.toUint8Array());
    const out = reader.readBytes(big.length);
    expect(Array.from(out.slice(0, 16))).toEqual(
      Array.from(big.slice(0, 16)),
    );
    expect(out.length).toBe(big.length);
    expect(reader.readVarint()).toBe(0xdead);
  });
});
