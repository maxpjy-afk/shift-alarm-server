// Thin wrapper around the Upstash Redis REST API.
// Chosen instead of local disk because most free hosting tiers (Render,
// Railway, etc.) do NOT guarantee a persistent filesystem across restarts —
// a JSON file on disk would silently lose all subscriptions/schedules on
// every redeploy or idle-restart. Upstash's free tier is a real persistent
// store reachable over plain HTTPS, so any stateless host works.

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  if (!BASE || !TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set');
  }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getDevice(deviceId) {
  const raw = await redis('GET', `device:${deviceId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveDevice(deviceId, data) {
  await redis('SET', `device:${deviceId}`, JSON.stringify(data));
  await redis('SADD', 'devices', deviceId);
}

async function deleteDevice(deviceId) {
  await redis('DEL', `device:${deviceId}`);
  await redis('SREM', 'devices', deviceId);
}

async function listDeviceIds() {
  const ids = await redis('SMEMBERS', 'devices');
  return ids || [];
}

module.exports = { getDevice, saveDevice, deleteDevice, listDeviceIds };
