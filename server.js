const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { getDevice, saveDevice, deleteDevice, listDeviceIds } = require('./storage');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
// Shared secret the client must send back so randos who guess a deviceId
// can't overwrite someone else's subscription. Not real auth, just a
// speed bump appropriate for a personal single/few-user app.
const SYNC_SECRET = process.env.SYNC_SECRET || '';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars — push will fail.');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function checkSecret(req, res) {
  if (!SYNC_SECRET) return true;
  if (req.get('x-sync-secret') !== SYNC_SECRET) {
    res.status(401).json({ error: 'bad secret' });
    return false;
  }
  return true;
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'shift-alarm-push-server' });
});

// Client calls this once it has a PushSubscription, and again whenever the
// subscription changes (pushsubscriptionchange in the service worker).
app.post('/subscribe', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { deviceId, subscription } = req.body || {};
  if (!deviceId || !subscription) return res.status(400).json({ error: 'deviceId and subscription required' });
  try {
    const existing = (await getDevice(deviceId)) || { alarms: [] };
    existing.subscription = subscription;
    await saveDevice(deviceId, existing);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Client calls this whenever the local schedule/alarm settings change.
// Body: { deviceId, alarms: [{ id, epochMs, title, body }] }
// Full replace of the alarm list each time — simplest to reason about and
// keeps client and server from ever silently drifting out of sync.
app.post('/sync', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { deviceId, alarms } = req.body || {};
  if (!deviceId || !Array.isArray(alarms)) return res.status(400).json({ error: 'deviceId and alarms[] required' });
  try {
    const existing = (await getDevice(deviceId)) || { subscription: null };
    existing.alarms = alarms.filter(a => a && a.id && a.epochMs && a.title);
    await saveDevice(deviceId, existing);
    res.json({ ok: true, count: existing.alarms.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/unsubscribe', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    await deleteDevice(deviceId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hit by an external cron pinger (e.g. cron-job.org) roughly once a minute.
// Finds every alarm due to fire in the past (and not too stale to still be
// meaningful) and sends a push for it. This is what lets an alarm ring even
// when the app has been fully closed for days.
const STALE_MS = 15 * 60 * 1000; // don't fire alarms more than 15min late
app.all('/tick', async (req, res) => {
  const now = Date.now();
  let sent = 0, failed = 0, pruned = 0;
  try {
    const ids = await listDeviceIds();
    for (const deviceId of ids) {
      const device = await getDevice(deviceId);
      if (!device || !device.subscription || !Array.isArray(device.alarms)) continue;

      const due = device.alarms.filter(a => a.epochMs <= now && now - a.epochMs < STALE_MS);
      const remaining = device.alarms.filter(a => a.epochMs > now || now - a.epochMs >= STALE_MS);

      let subscriptionDead = false;
      for (const alarm of due) {
        try {
          await webpush.sendNotification(
            device.subscription,
            JSON.stringify({ title: alarm.title, body: alarm.body || '' })
          );
          sent++;
        } catch (e) {
          failed++;
          if (e.statusCode === 404 || e.statusCode === 410) {
            // Subscription is gone (user cleared data, uninstalled, etc.)
            // Stop trying to send to it; client will re-subscribe on next open.
            subscriptionDead = true;
          }
        }
      }

      if (due.length || remaining.length !== device.alarms.length) {
        device.alarms = remaining;
        if (subscriptionDead) device.subscription = null;
        await saveDevice(deviceId, device);
        pruned += due.length;
      }
    }
    res.json({ ok: true, devices: ids.length, sent, failed, pruned, at: new Date(now).toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`shift-alarm-push-server listening on :${PORT}`));
