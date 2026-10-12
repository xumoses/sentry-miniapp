/** TextEncoder-compatible UTF-8 bytes without requiring a platform text encoder. */
export function encodeUtf8(input: string): Uint8Array {
  // Each UTF-16 code unit needs at most three bytes. A surrogate pair needs four.
  const bytes = new Uint8Array(input.length * 3);
  let offset = 0;
  for (let index = 0; index < input.length; index++) {
    let point = input.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
        index++;
      } else point = 0xfffd;
    } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd;

    if (point < 0x80) bytes[offset++] = point;
    else if (point < 0x800) {
      bytes[offset++] = 0xc0 | (point >> 6);
      bytes[offset++] = 0x80 | (point & 0x3f);
    } else if (point < 0x10000) {
      bytes[offset++] = 0xe0 | (point >> 12);
      bytes[offset++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (point & 0x3f);
    } else {
      bytes[offset++] = 0xf0 | (point >> 18);
      bytes[offset++] = 0x80 | ((point >> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (point & 0x3f);
    }
  }
  return bytes.slice(0, offset);
}
