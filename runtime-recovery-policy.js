import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const RUNTIME_HANDOFF_TTL_MS = 15 * 60 * 1000;
export const RUNTIME_HANDOFF_PARAM = 'arkRuntimeHandoff';
const TOKEN_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from('ark-tabor-receptionist-runtime-handoff-v1', 'utf8');

function clean(value) {
  return String(value || '').trim();
}

function phoneValue(candidate) {
  if (Array.isArray(candidate)) return phoneValue(candidate[0]);
  if (candidate && typeof candidate === 'object') {
    return candidate.phone_number || candidate.number || candidate.phone || '';
  }
  return candidate || '';
}

function parseBody(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''));
  } catch {
    return {};
  }
}

function encryptionKey(secret) {
  const value = clean(secret);
  if (!value) throw new Error('A runtime handoff secret is required.');
  return createHash('sha256').update(value).digest();
}

export function callEnvelopeFromTelnyxBody(value) {
  const body = parseBody(value);
  const event = body?.data || body;
  const payload = event?.payload || body?.payload || body?.start || body;
  const from = phoneValue(payload?.from || payload?.caller_id_number || body?.from);
  const to = phoneValue(payload?.to || payload?.called_number || payload?.destination || body?.to);
  return {
    callControlId: clean(
      payload?.call_control_id
      || body?.payload?.call_control_id
      || body?.start?.call_control_id
      || body?.call_control_id,
    ),
    callerPhone: clean(from).replace(/^tel:/i, ''),
    calledPhone: clean(to).replace(/^tel:/i, ''),
  };
}

export function runtimeDataFromOcmResponse(value = {}) {
  if (
    value?.ok === false
    || !clean(value?.clientId)
    || !value?.profile
    || !clean(value?.intakeUrl)
    || !clean(value?.usageUrl)
  ) return null;

  return {
    clientId: clean(value.clientId),
    calledPhone: clean(value.calledPhone),
    profile: value.profile,
    intakeUrl: clean(value.intakeUrl),
    usageUrl: clean(value.usageUrl),
  };
}

export function encodeRuntimeHandoff({ callControlId, metadata } = {}, secret, now = Date.now()) {
  const id = clean(callControlId);
  if (!id || !metadata?.runtimeData) throw new Error('Runtime handoff metadata is incomplete.');

  const payload = Buffer.from(JSON.stringify({
    version: TOKEN_VERSION,
    expiresAt: Number(now) + RUNTIME_HANDOFF_TTL_MS,
    callControlId: id,
    metadata: {
      runtimeData: metadata.runtimeData,
      callerPhone: clean(metadata.callerPhone),
      calledPhone: clean(metadata.calledPhone || metadata.runtimeData.calledPhone),
    },
  }), 'utf8');

  const compressed = deflateRawSync(payload, { level: 9 });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([TOKEN_VERSION]), iv, tag, encrypted]).toString('base64url');
}

export function decodeRuntimeHandoff(token, secret, now = Date.now()) {
  const bytes = Buffer.from(clean(token), 'base64url');
  if (bytes.length <= 1 + IV_BYTES + TAG_BYTES || bytes[0] !== TOKEN_VERSION) {
    throw new Error('The runtime handoff token is invalid.');
  }

  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const encryptedStart = tagStart + TAG_BYTES;
  const iv = bytes.subarray(ivStart, tagStart);
  const tag = bytes.subarray(tagStart, encryptedStart);
  const encrypted = bytes.subarray(encryptedStart);

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const payload = JSON.parse(inflateRawSync(compressed).toString('utf8'));

  if (
    payload?.version !== TOKEN_VERSION
    || !clean(payload?.callControlId)
    || !payload?.metadata?.runtimeData
    || !Number.isFinite(Number(payload?.expiresAt))
    || Number(payload.expiresAt) < Number(now)
  ) throw new Error('The runtime handoff token is expired or incomplete.');

  return payload;
}

export function appendRuntimeHandoff(streamUrl, { callControlId, token } = {}) {
  const url = new URL(String(streamUrl));
  const id = clean(callControlId);
  if (id) url.searchParams.set('callControlId', id);
  if (clean(token)) url.searchParams.set(RUNTIME_HANDOFF_PARAM, clean(token));
  return url.toString();
}
