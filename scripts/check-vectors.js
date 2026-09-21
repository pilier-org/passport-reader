'use strict';

// Verifies every vector under vectors/: that its declared byte length matches its bytes field,
// that hashing those bytes with blake2-256 reproduces the declared fingerprint, and — for a
// vector whose schema is not null — that decoding those bytes with src/decode.js reproduces the
// declared "parsed" field exactly. Exits nonzero if any vector fails any of these checks, so this
// is safe to wire into continuous integration.
//
// Usage: node scripts/check-vectors.js

const fs = require('fs');
const path = require('path');
const { blake2AsHex, cryptoWaitReady } = require('@polkadot/util-crypto');
const { decodePassportRecordV1, decodeLifecycleEventV1 } = require('../src/decode');

const VECTORS_DIR = path.join(__dirname, '..', 'vectors');

const DECODERS = {
  'PassportRecordV1 (category 0, version 1)': decodePassportRecordV1,
  'LifecycleEventV1 (category 0, version 1)': decodeLifecycleEventV1,
};

function checkVector(vector) {
  const errors = [];

  const byteLength = (vector.bytes.length - 2) / 2;
  if (byteLength !== vector.length_bytes) {
    errors.push(`length_bytes says ${vector.length_bytes} but bytes is ${byteLength} bytes long`);
  }

  const actualFingerprint = blake2AsHex(vector.bytes, 256);
  if (actualFingerprint !== vector.blake2_256_of_bytes) {
    errors.push(
      `blake2_256_of_bytes mismatch: file says ${vector.blake2_256_of_bytes}, computed ${actualFingerprint}`
    );
  }

  if (vector.schema === null) {
    if (vector.parsed !== null) {
      errors.push('schema is null but parsed is not null');
    }
    return errors;
  }

  const decoder = DECODERS[vector.schema];
  if (!decoder) {
    errors.push(`no decoder registered for schema "${vector.schema}"`);
    return errors;
  }

  let decoded;
  try {
    decoded = decoder(vector.bytes);
  } catch (e) {
    errors.push(`decoding threw: ${e.message}`);
    return errors;
  }

  const decodedJson = JSON.stringify(decoded);
  const parsedJson = JSON.stringify(vector.parsed);
  if (decodedJson !== parsedJson) {
    errors.push(`decoded form does not match the "parsed" field:\n    decoded: ${decodedJson}\n    parsed:  ${parsedJson}`);
  }

  return errors;
}

async function main() {
  await cryptoWaitReady();

  const files = fs
    .readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`no vector files found in ${VECTORS_DIR}`);
    process.exit(1);
  }

  let failures = 0;
  for (const file of files) {
    const vector = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, file), 'utf8'));
    const errors = checkVector(vector);
    if (errors.length === 0) {
      console.log(`OK    ${file}`);
    } else {
      failures += 1;
      console.log(`FAIL  ${file}`);
      for (const error of errors) console.log(`      ${error}`);
    }
  }

  console.log(`\n${files.length - failures}/${files.length} vectors passed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
