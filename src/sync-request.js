export const MAX_SYNC_MUTATIONS = 200;
export const MAX_SYNC_REQUEST_BYTES = 3 * 1024 * 1024 - 64 * 1024;

const encoder = new TextEncoder();

function requestBody(base, mutations) {
  return { ...base, mutations };
}

function serializedBytes(body) {
  return encoder.encode(JSON.stringify(body)).byteLength;
}

export function buildSyncRequestBody({
  deviceId,
  lastPulledCursor,
  maxChanges,
  mutations,
  maxMutations = MAX_SYNC_MUTATIONS,
}) {
  const limit = Math.min(
    MAX_SYNC_MUTATIONS,
    Math.max(0, Math.trunc(maxMutations)),
  );
  const candidates = mutations.slice(0, limit);
  const base = { deviceId, lastPulledCursor, maxChanges };

  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const body = requestBody(base, candidates.slice(0, count));
    if (serializedBytes(body) <= MAX_SYNC_REQUEST_BYTES) low = count;
    else high = count - 1;
  }

  // A mutation produced within the V1 field limits always fits by itself.
  const count = candidates.length > 0 ? Math.max(1, low) : 0;
  return requestBody(base, candidates.slice(0, count));
}
