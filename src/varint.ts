/**
 * LEB128-style unsigned varint helpers used by the binary pack format.
 *
 * Encoding: 7-bit payload per byte, high bit = "more bytes follow".
 * Values up to 127 take 1 byte, up to 16383 take 2 bytes, and so on. The
 * encoder/decoder pair is allocation-light and Uint8Array-only so it works in
 * every JS runtime without a Buffer polyfill.
 */

export function varintSize(value: number): number {
  let size = 1;
  let v = value >>> 0;
  while (v >= 0x80) {
    v >>>= 7;
    size += 1;
  }
  return size;
}

export class VarintWriter {
  private readonly chunks: Uint8Array[] = [];
  private current: Uint8Array = new Uint8Array(4096);
  private offset = 0;
  private committed = 0;

  get length() {
    return this.committed + this.offset;
  }

  private ensure(minSpace: number) {
    if (this.offset + minSpace <= this.current.length) {
      return;
    }
    if (this.offset > 0) {
      this.chunks.push(this.current.subarray(0, this.offset));
      this.committed += this.offset;
    }
    const size = Math.max(minSpace, Math.min(1 << 20, this.current.length * 2));
    this.current = new Uint8Array(size);
    this.offset = 0;
  }

  writeByte(value: number) {
    this.ensure(1);
    this.current[this.offset++] = value & 0xff;
  }

  writeVarint(value: number) {
    this.ensure(5);
    let v = value >>> 0;
    while (v >= 0x80) {
      this.current[this.offset++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.current[this.offset++] = v & 0x7f;
  }

  writeBytes(bytes: Uint8Array) {
    if (bytes.length === 0) {
      return;
    }
    if (
      bytes.length < 1024 &&
      this.offset + bytes.length <= this.current.length
    ) {
      this.current.set(bytes, this.offset);
      this.offset += bytes.length;
      return;
    }
    if (this.offset > 0) {
      this.chunks.push(this.current.subarray(0, this.offset));
      this.committed += this.offset;
      this.current = new Uint8Array(Math.max(4096, bytes.length));
      this.offset = 0;
    }
    this.chunks.push(bytes);
    this.committed += bytes.length;
  }

  writeUint32LE(value: number) {
    this.ensure(4);
    const v = value >>> 0;
    this.current[this.offset++] = v & 0xff;
    this.current[this.offset++] = (v >>> 8) & 0xff;
    this.current[this.offset++] = (v >>> 16) & 0xff;
    this.current[this.offset++] = (v >>> 24) & 0xff;
  }

  writeUint16LE(value: number) {
    this.ensure(2);
    const v = value & 0xffff;
    this.current[this.offset++] = v & 0xff;
    this.current[this.offset++] = (v >>> 8) & 0xff;
  }

  toUint8Array(): Uint8Array {
    const total = this.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.length;
    }
    if (this.offset > 0) {
      out.set(this.current.subarray(0, this.offset), cursor);
    }
    return out;
  }
}

export class VarintReader {
  private offset = 0;
  constructor(private readonly view: Uint8Array) {}

  get position() {
    return this.offset;
  }

  set position(next: number) {
    this.offset = next;
  }

  get remaining() {
    return this.view.length - this.offset;
  }

  readByte(): number {
    return this.view[this.offset++];
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    const bytes = this.view;
    let next = bytes[this.offset++];
    while (next & 0x80) {
      result |= (next & 0x7f) << shift;
      shift += 7;
      next = bytes[this.offset++];
    }
    result |= next << shift;
    return result >>> 0;
  }

  readBytes(length: number): Uint8Array {
    const slice = this.view.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readUint32LE(): number {
    const bytes = this.view;
    const value =
      bytes[this.offset] |
      (bytes[this.offset + 1] << 8) |
      (bytes[this.offset + 2] << 16) |
      (bytes[this.offset + 3] << 24);
    this.offset += 4;
    return value >>> 0;
  }

  readUint16LE(): number {
    const bytes = this.view;
    const value = bytes[this.offset] | (bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value & 0xffff;
  }
}
