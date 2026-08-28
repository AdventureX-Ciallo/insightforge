export class SeededPrng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  nextUint32() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  int(exclusiveMaximum: number) {
    if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum <= 0) throw new Error("PRNG maximum must be a positive safe integer");
    return this.nextUint32() % exclusiveMaximum;
  }

  bool() {
    return (this.nextUint32() & 1) === 1;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("PRNG cannot pick from an empty collection");
    return values[this.int(values.length)]!;
  }

  bytes(maximumLength: number, minimumLength = 0) {
    const length = minimumLength + this.int(maximumLength - minimumLength + 1);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = this.nextUint32() & 0xff;
    return bytes;
  }

  token(maximumLength = 24) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_";
    const length = 1 + this.int(maximumLength);
    let value = "";
    for (let index = 0; index < length; index += 1) value += alphabet[this.int(alphabet.length)];
    return value;
  }
}
