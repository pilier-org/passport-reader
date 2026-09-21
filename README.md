# passport-reader

A reference decoder, a set of verification vectors, and a minimal developer viewer for digital
product passports on the [Pilier](https://pilier.dev) blockchain.

## What this is not

This repository does not define anything. Every schema, every registry entry, every storage
endpoint and every project's write permission lives on chain, in the passport pallet, the
registry pallet and the documents pallet — read directly from `wss://rpc.pilier.dev`, with no
signing key required. What is here is code that reads that on-chain state and a set of byte-exact
examples of it, kept only so a third party can check their own implementation against something
concrete instead of against prose. If this repository and the chain ever disagree, the chain is
right.

The authoritative description of the pallets themselves is on
[pilier.dev/docs/pallets](https://pilier.dev/docs/pallets/dpp-pallet):

- [Passport pallet](https://pilier.dev/docs/pallets/dpp-pallet) — head records and lifecycle events.
- [Registry pallet](https://pilier.dev/docs/pallets/registry-pallet) — projects, write permissions, schemas, storage endpoints.
- [Documents pallet](https://pilier.dev/docs/pallets/documents-pallet) — the evidence-file fingerprint table.

## Contents

| Path                        | What it is                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `src/decode.js`               | A dependency-free reference decoder for the category-0 body schemas (`PassportRecordV1`, `LifecycleEventV1`). |
| `src/reader.js`               | Reads one passport straight from the chain: the head record, its schema, its lifecycle events, and every cited certificate file's registration and resolved address. |
| `scripts/view.js`             | Command-line tool built on `src/reader.js` that renders a passport into a static HTML page. |
| `scripts/check-vectors.js`    | Verifies every file under `vectors/` against its own declared length, fingerprint, and parsed form. |
| `vectors/*.json`              | Verification vectors — see below. |

## Quickstart

```sh
npm install
npm run check-vectors   # decode every vector and confirm it matches its own declared parsed form
npm run view             # render the passport pallet's own worked example to viewer-output.html
```

`npm run view` takes an optional company registration number and GS1 identifier, and an optional
endpoint:

```sh
node scripts/view.js DOCS-EXAMPLE-0001 00000000000017 --endpoint wss://rpc.pilier.dev --out example.html
```

With no arguments it reads the same worked example the passport pallet's own documentation page
uses, off the public testnet.

## The decoder

`src/decode.js` implements the four encoding rules the passport pallet's documentation states —
fixed-width integers little-endian with no prefix, a `Vec<T>` prefixed by a SCALE compact-length
integer, a fixed-size array with no prefix, a struct as its fields concatenated in declared order
— against the two structures category 0 defines:

```rust
struct CompositionLine {
    fibre: Vec<u8>,
    percentage_bps: u16,
}

struct PassportRecordV1 {
    count: u32,
    composition: Vec<CompositionLine>,
    composition_source: u8,
    certificate_fingerprints: Vec<[u8; 32]>,
}

struct LifecycleEventV1 {
    event_type: u8,
    occurred_at_unix_ms: u64,
    gs1_event_hash: [u8; 32],
}
```

A passport's body is opaque to the passport pallet itself — the schema named by its `schema_id`,
read from the registry pallet, is what fixes its layout. Category 0 is the convention the
worked example on pilier.dev uses; a different schema category needs its own decoder, which this
package does not attempt to guess at. `src/reader.js` reflects that honestly: for any category
other than 0, it still resolves the head record, the schema, the events and the cited files, and
leaves the parsed body and parsed events `null` rather than guessing.

## Verification vectors

Each file under `vectors/` is one encoded value together with everything needed to check a
decoder against it, independent of this repository's own decoder:

```json
{
  "name": "typical",
  "schema": "PassportRecordV1 (category 0, version 1)",
  "bytes": "0x...",
  "length_bytes": 113,
  "parsed": { "count": 500, "composition": [ ... ], ... },
  "blake2_256_of_bytes": "0x...",
  "provenance": { "generated_by": "...", "source_commit": "...", "runtime_spec_version": 105, "notes": "..." }
}
```

Three sizes exist for each of the two schemas: `minimal` (every variable-length field empty),
`typical`, and `ceiling` (padded to the passport pallet's own configured maximum body or event
length). The `typical` record and event vectors are not synthetic: they are the passport pallet's
own worked example, permanently published on the live testnet — the same bytes `dpp-pallet.md`
describes and the same bytes `npm run view` reads back live. `event-ceiling.json` has a `null`
schema and `null` parsed form on purpose: `LifecycleEventV1` encodes to a fixed 41 bytes for any
field values, so a ceiling-sized *decodable* event does not exist — this vector demonstrates only
the pallet's own raw length ceiling on an event body, the same way the pallet's own test suite
does.

`npm run check-vectors` re-derives the fingerprint of every vector's bytes and, where a schema is
named, decodes those bytes and compares the result against the vector's own `parsed` field —
wired into this repository's own continuous integration, so a vector and a decoder can never
silently drift apart here.

## The viewer

`scripts/view.js` connects to a Pilier node over its public RPC endpoint, reads one passport by
its key, and writes a single self-contained HTML file — no build step, no further network calls
once written, openable straight from disk. It is a snapshot of one read, not a live page: re-run
it for current chain state.

## License

MIT — see `LICENSE`.
