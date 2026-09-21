'use strict';

// Reads one digital product passport straight from the live chain and assembles it into a
// single plain object: the head record and its lifecycle events from the passport pallet, the
// schema that names the body's own encoding from the registry pallet, and — for every
// certificate fingerprint a category-0 body cites — that file's registration from the documents
// pallet plus the storage endpoint address it resolves to. A viewer can render the result
// without knowing anything about how any of this is laid out in chain storage.
//
// This package only ships a decoder for category 0 (`PassportRecordV1` / `LifecycleEventV1`,
// see src/decode.js). A passport written against any other schema category still comes back
// with its head, its schema, its events and its files resolved — only `parsed_body` and each
// event's `parsed` stay null, with `decode_error` left unset because there was no decoder to
// fail, not because one failed.

const { ApiPromise, WsProvider } = require('@polkadot/api');
const { decodePassportRecordV1, decodeLifecycleEventV1 } = require('./decode');

const CATEGORY_0 = 0;

function connect(endpoint) {
  return ApiPromise.create({ provider: new WsProvider(endpoint) });
}

async function resolveFile(api, fingerprint) {
  const fileInfoOpt = await api.query.documents.files(fingerprint);
  if (fileInfoOpt.isNone) {
    return { fingerprint, registered: false };
  }
  const fileInfo = fileInfoOpt.unwrap();
  const storageEndpointId = fileInfo.storageEndpointId.toNumber();
  const path = fileInfo.path.toUtf8();
  const contentType = fileInfo.contentType.toUtf8();

  const endpointOpt = await api.query.registry.storageEndpoints(storageEndpointId);
  const address = endpointOpt.isSome ? endpointOpt.unwrap().address.toUtf8() + path : null;

  return {
    fingerprint,
    registered: true,
    registered_by_project: fileInfo.registeredBy.toNumber(),
    storage_endpoint_id: storageEndpointId,
    path,
    content_type: contentType,
    registered_at_block: fileInfo.registeredAt.toNumber(),
    address,
    address_note:
      address === null
        ? `storage endpoint ${storageEndpointId} was not found in the registry pallet`
        : 'not proof the address still serves this content — only the fingerprint is proof; see the documents pallet documentation',
  };
}

function decodeBody(decoder, bodyHex) {
  if (!decoder) return { parsed: null, decode_error: undefined };
  try {
    return { parsed: decoder(bodyHex), decode_error: undefined };
  } catch (e) {
    return { parsed: null, decode_error: e.message };
  }
}

async function readPassport(api, companyRegistrationNumber, gs1Id) {
  const headOpt = await api.query.dpp.heads(companyRegistrationNumber, gs1Id);
  if (headOpt.isNone) {
    throw new Error(`no head record at (${companyRegistrationNumber}, ${gs1Id})`);
  }
  const head = headOpt.unwrap();
  const schemaId = head.schemaId.toNumber();

  const schemaOpt = await api.query.registry.schemas(schemaId);
  if (schemaOpt.isNone) {
    throw new Error(`head record cites schema ${schemaId}, which the registry pallet does not have`);
  }
  const schema = schemaOpt.unwrap();
  const category = schema.category.toNumber();
  const recordDecoder = category === CATEGORY_0 ? decodePassportRecordV1 : null;
  const eventDecoder = category === CATEGORY_0 ? decodeLifecycleEventV1 : null;

  const bodyHex = head.body.toHex();
  const { parsed: parsedBody, decode_error: bodyDecodeError } = decodeBody(recordDecoder, bodyHex);

  const files = {};
  if (parsedBody && Array.isArray(parsedBody.certificate_fingerprints)) {
    for (const fingerprint of parsedBody.certificate_fingerprints) {
      if (!(fingerprint in files)) {
        files[fingerprint] = await resolveFile(api, fingerprint);
      }
    }
  }

  const eventCount = (await api.query.dpp.eventCounts(companyRegistrationNumber, gs1Id)).toNumber();
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    const eventOpt = await api.query.dpp.events(companyRegistrationNumber, gs1Id, i);
    if (eventOpt.isNone) {
      events.push({ index: i, error: 'eventCounts names this index but no event is stored there' });
      continue;
    }
    const event = eventOpt.unwrap();
    const eventBodyHex = event.body.toHex();
    const { parsed, decode_error } = decodeBody(eventDecoder, eventBodyHex);
    events.push({
      index: i,
      recorded_at_block: event.recordedAt.toNumber(),
      body_hex: eventBodyHex,
      parsed,
      decode_error,
    });
  }

  return {
    key: { company_registration_number: companyRegistrationNumber, gs1_id: gs1Id },
    head: {
      schema_id: schemaId,
      project_id: head.projectId.toNumber(),
      published_at_block: head.publishedAt.toNumber(),
      version: head.version.toNumber(),
      previous_body_fingerprint: head.previousBodyFingerprint.isSome
        ? head.previousBodyFingerprint.unwrap().toHex()
        : null,
      body_hex: bodyHex,
    },
    schema: {
      id: schemaId,
      category,
      version: schema.version.toNumber(),
      description: schema.description.toUtf8(),
      fingerprint: schema.fingerprint.toHex(),
    },
    parsed_body: parsedBody,
    body_decode_error: bodyDecodeError,
    files,
    events,
  };
}

module.exports = { connect, readPassport };
