'use strict';

// Reference decoder for the passport pallet's category-0 example schema. This pallet stores a
// passport's `body` (and an event's own `body`) as an opaque byte string: it never parses it.
// The schema registered under `schema_id` is what fixes the layout, and category 0 is described
// on the passport pallet's own documentation page (https://pilier.dev/docs/pallets/dpp-pallet)
// as two structures, encoded with the SCALE codec:
//
//   struct CompositionLine {
//       fibre: Vec<u8>,
//       percentage_bps: u16,
//   }
//
//   struct PassportRecordV1 {
//       count: u32,
//       composition: Vec<CompositionLine>,
//       composition_source: u8,
//       certificate_fingerprints: Vec<[u8; 32]>,
//   }
//
//   struct LifecycleEventV1 {
//       event_type: u8,
//       occurred_at_unix_ms: u64,
//       gs1_event_hash: [u8; 32],
//   }
//
// This file follows the same four encoding rules the documentation page states: fixed-width
// integers are little-endian with no length prefix; a `Vec<T>` starts with a compact-length
// prefix; a fixed-size array has no prefix at all; a struct is simply its fields concatenated in
// order. The documentation page only spells out the compact-length prefix's single-byte form
// (count under 64), because every field in its worked example fits that form — but this
// package's own "ceiling" vector does not: reaching the pallet's configured body-length ceiling
// takes well over 64 certificate fingerprints, which pushes the prefix into its two-byte form.
// `decodeCompactLength` below implements both, plus the four-byte form, for the same reason: a
// decoder that only handled the common case would fail on exactly the vector meant to stress it.

function toBytes(hexOrBytes) {
  if (hexOrBytes instanceof Uint8Array) return hexOrBytes;
  const hex = hexOrBytes.startsWith('0x') ? hexOrBytes.slice(2) : hexOrBytes;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function toHex(bytes) {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Decodes a compact-length prefix. The low two bits of the first byte pick the mode: 0b00 is a
// single byte holding counts 0..63 (`count << 2`); 0b01 is a two-byte little-endian value holding
// counts up to 16383; 0b10 is four bytes, up to 2**30 - 1. No vector in this schema ever needs
// the fourth mode (a big-integer encoding of the byte length itself), since that would mean well
// over a billion elements, so that mode throws rather than guessing at it.
function decodeCompactLength(bytes, offset) {
  const first = bytes[offset];
  const mode = first & 0b11;

  if (mode === 0b00) {
    return { value: first >> 2, bytesRead: 1 };
  }

  if (mode === 0b01) {
    const raw = first | (bytes[offset + 1] << 8);
    return { value: raw >>> 2, bytesRead: 2 };
  }

  if (mode === 0b10) {
    const raw =
      (first | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    return { value: raw >>> 2, bytesRead: 4 };
  }

  throw new Error(
    `compact-length prefix at offset ${offset} uses the big-integer mode (byte 0x${first.toString(16)}); ` +
      'no vector in this schema is ever large enough to need it'
  );
}

function decodeU8(bytes, offset) {
  return { value: bytes[offset], bytesRead: 1 };
}

function decodeU16LE(bytes, offset) {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return { value, bytesRead: 2 };
}

function decodeU32LE(bytes, offset) {
  const value =
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  return { value, bytesRead: 4 };
}

// Decoded as a plain JS number, not a BigInt: every value this schema actually carries is a
// millisecond Unix timestamp, far below Number.MAX_SAFE_INTEGER (the year 2255 is where a
// millisecond timestamp would first exceed it). A general SCALE decoder would use a BigInt here.
function decodeU64LE(bytes, offset) {
  let value = 0;
  for (let i = 7; i >= 0; i--) {
    value = value * 256 + bytes[offset + i];
  }
  return { value, bytesRead: 8 };
}

function decodeFixedBytes(bytes, offset, length) {
  return { value: bytes.slice(offset, offset + length), bytesRead: length };
}

function decodeVecU8(bytes, offset) {
  const { value: length, bytesRead: prefixLen } = decodeCompactLength(bytes, offset);
  const start = offset + prefixLen;
  return { value: bytes.slice(start, start + length), bytesRead: prefixLen + length };
}

function decodeCompositionLine(bytes, offset) {
  let pos = offset;
  const fibreBytes = decodeVecU8(bytes, pos);
  pos += fibreBytes.bytesRead;
  const percentageBps = decodeU16LE(bytes, pos);
  pos += percentageBps.bytesRead;
  return {
    value: {
      fibre: Buffer.from(fibreBytes.value).toString('utf8'),
      percentage_bps: percentageBps.value,
    },
    bytesRead: pos - offset,
  };
}

// Decodes a `PassportRecordV1` body. `bytes` may be a `0x...` hex string or a Uint8Array, and
// must be exactly the record's body (for example the `body` field read back from
// `dpp.heads(companyRegistrationNumber, gs1Id)`) — this function does not know how to find the
// body inside a wider structure.
function decodePassportRecordV1(bytesOrHex) {
  const bytes = toBytes(bytesOrHex);
  let pos = 0;

  const count = decodeU32LE(bytes, pos);
  pos += count.bytesRead;

  const compositionLen = decodeCompactLength(bytes, pos);
  pos += compositionLen.bytesRead;
  const composition = [];
  for (let i = 0; i < compositionLen.value; i++) {
    const line = decodeCompositionLine(bytes, pos);
    pos += line.bytesRead;
    composition.push(line.value);
  }

  const compositionSource = decodeU8(bytes, pos);
  pos += compositionSource.bytesRead;

  const fingerprintsLen = decodeCompactLength(bytes, pos);
  pos += fingerprintsLen.bytesRead;
  const certificateFingerprints = [];
  for (let i = 0; i < fingerprintsLen.value; i++) {
    const fp = decodeFixedBytes(bytes, pos, 32);
    pos += fp.bytesRead;
    certificateFingerprints.push(toHex(fp.value));
  }

  if (pos !== bytes.length) {
    throw new Error(`decoded ${pos} of ${bytes.length} bytes; the input is longer than one PassportRecordV1`);
  }

  return {
    count: count.value,
    composition,
    composition_source: compositionSource.value,
    certificate_fingerprints: certificateFingerprints,
  };
}

// Decodes a `LifecycleEventV1` body. Always exactly 41 bytes, for any field values: this
// structure has no variable-length field, unlike `PassportRecordV1`.
function decodeLifecycleEventV1(bytesOrHex) {
  const bytes = toBytes(bytesOrHex);
  let pos = 0;

  const eventType = decodeU8(bytes, pos);
  pos += eventType.bytesRead;

  const occurredAt = decodeU64LE(bytes, pos);
  pos += occurredAt.bytesRead;

  const gs1EventHash = decodeFixedBytes(bytes, pos, 32);
  pos += gs1EventHash.bytesRead;

  if (pos !== bytes.length) {
    throw new Error(`decoded ${pos} of ${bytes.length} bytes; the input is longer than one LifecycleEventV1`);
  }

  return {
    event_type: eventType.value,
    occurred_at_unix_ms: occurredAt.value,
    gs1_event_hash: toHex(gs1EventHash.value),
  };
}

module.exports = {
  toBytes,
  toHex,
  decodePassportRecordV1,
  decodeLifecycleEventV1,
};
