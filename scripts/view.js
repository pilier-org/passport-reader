'use strict';

// Fetches one digital product passport from the live chain and renders it into a single,
// self-contained static HTML file — no build step, no bundler, openable straight from disk in
// any browser, with the fetched data embedded rather than fetched live by the page itself. That
// keeps the page simple: it never has to talk to the chain, only display what this script
// already read.
//
// Usage:
//   node scripts/view.js [companyRegistrationNumber] [gs1Id] [--endpoint wss://...] [--out file.html]
//
// With no arguments, reads the passport pallet's own worked example from
// https://pilier.dev/docs/pallets/dpp-pallet — key (DOCS-EXAMPLE-0001, 00000000000017) — off the
// public testnet endpoint.

const fs = require('fs');
const path = require('path');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const { connect, readPassport } = require('../src/reader');

const DEFAULT_ENDPOINT = 'wss://rpc.pilier.dev';
const DEFAULT_CRN = 'DOCS-EXAMPLE-0001';
const DEFAULT_GS1 = '00000000000017';
const DEFAULT_OUT = 'viewer-output.html';

function parseArgs(argv) {
  const positional = [];
  let endpoint = DEFAULT_ENDPOINT;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--endpoint') {
      endpoint = argv[++i];
    } else if (argv[i] === '--out') {
      out = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return {
    companyRegistrationNumber: positional[0] || DEFAULT_CRN,
    gs1Id: positional[1] || DEFAULT_GS1,
    endpoint,
    out,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderComposition(composition) {
  if (!composition || composition.length === 0) return '<p><em>none</em></p>';
  const rows = composition
    .map((line) => `<tr><td>${escapeHtml(line.fibre)}</td><td>${line.percentage_bps} bps</td></tr>`)
    .join('\n');
  return `<table><thead><tr><th>Fibre</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFiles(files) {
  const fingerprints = Object.keys(files);
  if (fingerprints.length === 0) return '<p><em>this body cites no certificate fingerprints</em></p>';
  const rows = fingerprints
    .map((fp) => {
      const f = files[fp];
      if (!f.registered) {
        return `<tr><td><code>${escapeHtml(fp)}</code></td><td colspan="4"><em>not registered in the documents pallet</em></td></tr>`;
      }
      const address = f.address ? escapeHtml(f.address) : '<em>unresolved</em>';
      return `<tr><td><code>${escapeHtml(fp)}</code></td><td>${f.registered_by_project}</td><td>${escapeHtml(f.content_type)}</td><td>${f.registered_at_block}</td><td>${address}</td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>Fingerprint</th><th>Project</th><th>Content type</th><th>Registered at block</th><th>Address (not proof — see note below)</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="note">An address is only where a copy can currently be fetched from. The fingerprint, not the address, is what the passport pallet actually checked.</p>`;
}

function renderEvents(events) {
  if (events.length === 0) return '<p><em>no lifecycle events appended yet</em></p>';
  const rows = events
    .map((e) => {
      if (e.error) return `<tr><td>${e.index}</td><td colspan="3"><em>${escapeHtml(e.error)}</em></td></tr>`;
      const parsed = e.parsed
        ? `type ${e.parsed.event_type}, occurred at ${e.parsed.occurred_at_unix_ms} ms (Unix), hash <code>${escapeHtml(e.parsed.gs1_event_hash)}</code>`
        : `<em>${e.decode_error ? escapeHtml(e.decode_error) : 'no decoder registered for this schema category'}</em>`;
      return `<tr><td>${e.index}</td><td>${e.recorded_at_block}</td><td><code>${escapeHtml(e.body_hex)}</code></td><td>${parsed}</td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>#</th><th>Recorded at block</th><th>Body (hex)</th><th>Parsed</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtml(passport, endpoint) {
  const { key, head, schema, parsed_body, body_decode_error, files, events } = passport;
  const bodySection = parsed_body
    ? `<p>Count: ${parsed_body.count}. Composition source: ${parsed_body.composition_source === 0 ? 'computed' : 'hand-entered'}.</p>
       ${renderComposition(parsed_body.composition)}`
    : `<p><em>${body_decode_error ? escapeHtml(body_decode_error) : `no decoder registered for schema category ${schema.category}`}</em></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Passport ${escapeHtml(key.company_registration_number)} / ${escapeHtml(key.gs1_id)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  code { font-size: 0.85em; word-break: break-all; }
  .note { color: #666; font-size: 0.85rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Digital product passport</h1>
<p>Company registration number <code>${escapeHtml(key.company_registration_number)}</code>, GS1 identifier <code>${escapeHtml(key.gs1_id)}</code>.</p>

<h2>Head record</h2>
<table>
  <tr><th>Schema</th><td>${schema.id} (category ${schema.category}, version ${schema.version})</td></tr>
  <tr><th>Project</th><td>${head.project_id}</td></tr>
  <tr><th>Published at block</th><td>${head.published_at_block}</td></tr>
  <tr><th>Version</th><td>${head.version}</td></tr>
  <tr><th>Previous body fingerprint</th><td>${head.previous_body_fingerprint ? `<code>${escapeHtml(head.previous_body_fingerprint)}</code>` : '<em>none — this is version 1</em>'}</td></tr>
  <tr><th>Body (hex)</th><td><code>${escapeHtml(head.body_hex)}</code></td></tr>
</table>

<h2>Schema</h2>
<table>
  <tr><th>Description</th><td>${escapeHtml(schema.description)}</td></tr>
  <tr><th>Fingerprint</th><td><code>${escapeHtml(schema.fingerprint)}</code></td></tr>
</table>

<h2>Parsed body</h2>
${bodySection}

<h2>Cited certificate files</h2>
${renderFiles(files)}

<h2>Lifecycle events</h2>
${renderEvents(events)}

<footer>
  Generated ${new Date().toISOString()} by <code>passport-reader</code> (scripts/view.js) against
  <code>${escapeHtml(endpoint)}</code>. This is a snapshot, not a live view — re-run the script for
  current chain state. Read the schemas and registries this page relies on straight from the chain
  itself, not from this repository: see
  <a href="https://pilier.dev/docs/pallets/dpp-pallet">pilier.dev/docs/pallets/dpp-pallet</a>.
</footer>
</body>
</html>
`;
}

async function main() {
  const { companyRegistrationNumber, gs1Id, endpoint, out } = parseArgs(process.argv.slice(2));

  await cryptoWaitReady();
  console.log(`connecting to ${endpoint} ...`);
  const api = await connect(endpoint);

  try {
    console.log(`reading (${companyRegistrationNumber}, ${gs1Id}) ...`);
    const passport = await readPassport(api, companyRegistrationNumber, gs1Id);

    console.log('head:', JSON.stringify(passport.head));
    console.log('schema:', JSON.stringify(passport.schema));
    console.log('parsed body:', JSON.stringify(passport.parsed_body));
    console.log('files:', JSON.stringify(passport.files));
    console.log('events:', JSON.stringify(passport.events));

    const html = renderHtml(passport, endpoint);
    const outPath = path.resolve(process.cwd(), out);
    fs.writeFileSync(outPath, html);
    console.log(`\nwrote ${outPath}`);
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
