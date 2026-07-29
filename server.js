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

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars — push will fail.');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// No shared secret: each client generates its own random deviceId (128-bit
// UUID) client-side, which doubles as its bearer credential. Unguessable in
// practice, and there's no read endpoint, so this is enough for many
// unrelated installs to safely share one backend without any login system.

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'shift-alarm-push-server' });
});

// Client calls this once it has a PushSubscription, and again whenever the
// subscription changes (pushsubscriptionchange in the service worker).
app.post('/subscribe', async (req, res) => {
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
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    await deleteDevice(deviceId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hit by the service worker's notificationclick handler when someone taps
// the "10분 후 다시" action on an alarm notification. Kept in its own field
// (not device.alarms) so the next /sync full-replace from the client — which
// knows nothing about this one-off snooze — can't wipe it out before /tick
// gets to it.
app.post('/snooze', async (req, res) => {
  const { deviceId, title, body, delayMs } = req.body || {};
  if (!deviceId || !title) return res.status(400).json({ error: 'deviceId and title required' });
  try {
    const existing = (await getDevice(deviceId)) || { alarms: [] };
    existing.snoozed = existing.snoozed || [];
    existing.snoozed.push({
      id: 'snooze-' + Date.now(),
      epochMs: Date.now() + (Number(delayMs) > 0 ? Number(delayMs) : 10 * 60 * 1000),
      title,
      body: body || ''
    });
    await saveDevice(deviceId, existing);
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
function splitDue(list, now) {
  const due = (list || []).filter(a => a.epochMs <= now && now - a.epochMs < STALE_MS);
  const remaining = (list || []).filter(a => a.epochMs > now || now - a.epochMs >= STALE_MS);
  return { due, remaining };
}
app.all('/tick', async (req, res) => {
  const now = Date.now();
  let sent = 0, failed = 0, pruned = 0;
  try {
    const ids = await listDeviceIds();
    for (const deviceId of ids) {
      const device = await getDevice(deviceId);
      if (!device || !device.subscription) continue;

      const scheduled = splitDue(device.alarms, now);
      const snoozed = splitDue(device.snoozed, now);
      const due = scheduled.due.concat(snoozed.due);
      const changed = due.length || scheduled.remaining.length !== (device.alarms || []).length
        || snoozed.remaining.length !== (device.snoozed || []).length;

      let subscriptionDead = false;
      for (const alarm of due) {
        try {
          await webpush.sendNotification(
            device.subscription,
            JSON.stringify({ title: alarm.title, body: alarm.body || '', deviceId })
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

      if (changed) {
        device.alarms = scheduled.remaining;
        device.snoozed = snoozed.remaining;
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
