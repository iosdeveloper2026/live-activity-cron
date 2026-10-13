// Live Activity cron: runs on GitHub Actions, sends Live Activity pushes through FCM.
//
// Reads:
//   - Remote Config `live_activity_config` (the same JSON the app uses)
//   - Firestore `liveActivityDevices/{installId}` (tokens written by the iOS app)
// Writes:
//   - Firestore `liveActivityCronState/{installId}` (which stage each device is on)
//
// Logs counts only. This repo is public, so never log tokens or payloads.

import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getRemoteConfig } from "firebase-admin/remote-config";

const DRY_RUN = process.env.DRY_RUN === "1";
const ACTIVITY_MAX_AGE_S = 7.5 * 3600; // iOS stops accepting updates after 8 hours
const APPLE_EPOCH_OFFSET_S = 978307200; // Swift Date decodes as seconds since 2001-01-01
const ATTRIBUTES_TYPE = "DeliveryAttributes";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? "null");
if (!serviceAccount) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is missing");
const app = initializeApp({ credential: cert(serviceAccount) });
const projectId = serviceAccount.project_id;
const db = getFirestore(app);

const stats = { devices: 0, started: 0, updated: 0, ended: 0, skipped: 0, failed: 0, tokensRemoved: 0 };

// ---------- Content (mirrors DeliveryState.of in the Kotlin app) ----------

async function loadConfig() {
  const template = await getRemoteConfig(app).getTemplate();
  const raw = template.parameters?.live_activity_config?.defaultValue?.value;
  if (!raw) throw new Error("Remote Config parameter live_activity_config not found");
  return JSON.parse(raw);
}

/** Same deterministic name as ImageStore.location(for:size:) in the iOS app (djb2, UInt64). */
function imageFileName(url, size) {
  if (!url) return null;
  let hash = 5381n;
  for (const byte of new TextEncoder().encode(url)) {
    hash = ((hash << 5n) + hash + BigInt(byte)) & 0xffffffffffffffffn;
  }
  return `la-${size}-${hash.toString(16)}.jpg`;
}

function contentState(config, stageIndex, orderNumber, nowS) {
  const stage = config.stages[stageIndex];
  const fill = (s) => (s ?? "").replaceAll("{order}", orderNumber).replaceAll("{name}", config.recipientName ?? "");
  const count = config.stages.length;
  const bannerUrl = config.bannerImageUrl || config.imageUrl;
  return {
    brandName: fill(config.brandName),
    title: fill(config.title),
    subtitle: fill(config.subtitle),
    imageFile: imageFileName(config.imageUrl, "thumbnail"),
    imageStyle: config.imageStyle ?? "small",
    bannerFile: imageFileName(bannerUrl, "banner"),
    symbol: config.symbol ?? "bag.fill",
    accentColor: config.accentColor ?? "#FF6B35",
    stageIndex,
    stageCount: count,
    stageTitle: fill(stage.title),
    statusText: fill(stage.status),
    stageSymbol: stage.symbol || config.symbol || "bag.fill",
    eta: nowS + stage.etaMinutes * 60 - APPLE_EPOCH_OFFSET_S,
    progress: count > 1 ? stageIndex / (count - 1) : 1,
    isFinal: stageIndex === count - 1,
  };
}

// ---------- FCM ----------

async function sendLiveActivity({ fcmToken, liveActivityToken, aps }) {
  if (DRY_RUN) return { ok: true };
  const { access_token } = await app.options.credential.getAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        apns: {
          live_activity_token: liveActivityToken,
          headers: { "apns-priority": "10" },
          payload: { aps },
        },
      },
    }),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status;
  // FCM's message describes the problem without echoing tokens, so it's safe to log.
  const message = String(body?.error?.message ?? "").slice(0, 200);
  // Only UNREGISTERED means the token is dead; INVALID_ARGUMENT can also be a payload problem.
  return { ok: false, status: res.status, code, message, invalidToken: code === "UNREGISTERED" };
}

// ---------- Per device ----------

async function processDevice(doc, config, nowS) {
  const device = doc.data();
  const stateRef = db.collection("liveActivityCronState").doc(doc.id);
  const state = (await stateRef.get()).data() ?? {};
  const activity = device.activity;
  const last = config.stages.length - 1;
  const cron = config.cron ?? {};

  if (!device.fcmToken) return stats.skipped++;

  // 1. A Live Activity is running: advance it one stage, or end it.
  if (activity?.status === "active" && activity.pushToken) {
    if (state.endedActivityId === activity.activityId) return stats.skipped++;

    const current = state.activityId === activity.activityId ? state.stage : activity.stageIndex ?? 0;
    const tooOld = nowS - (activity.startedAt ?? nowS) > ACTIVITY_MAX_AGE_S;
    const next = tooOld ? current : Math.min(current + 1, last);
    const orderNumber = activity.orderNumber ?? "";
    const end = tooOld || next >= last;

    const aps = {
      timestamp: nowS,
      event: end ? "end" : "update",
      "content-state": contentState(config, next, orderNumber, nowS),
    };
    if (end) aps["dismissal-date"] = nowS + (cron.dismissAfterSeconds ?? 900);

    const result = await sendLiveActivity({ fcmToken: device.fcmToken, liveActivityToken: activity.pushToken, aps });
    if (!result.ok) {
      stats.failed++;
      console.log(`update failed: HTTP ${result.status} ${result.code ?? ""} ${result.message}`);
      if (result.invalidToken) {
        stats.tokensRemoved++;
        await stateRef.set({ endedActivityId: activity.activityId }, { merge: true });
      }
      return;
    }
    end ? stats.ended++ : stats.updated++;
    await stateRef.set(
      { activityId: activity.activityId, stage: next, endedActivityId: end ? activity.activityId : null, lastPushAt: nowS },
      { merge: true },
    );
    return;
  }

  // 2. Nothing running: start one remotely (iOS 17.2+ push-to-start), at most every N minutes.
  const startEnabled = cron.startEnabled ?? true;
  const everyS = (cron.startEveryMinutes ?? 60) * 60;
  if (!startEnabled || !device.startToken || nowS - (state.lastStartAt ?? 0) < everyS) return stats.skipped++;

  const orderNumber = "#" + Math.floor(1000 + Math.random() * 9000);
  const first = contentState(config, 0, orderNumber, nowS);
  const aps = {
    timestamp: nowS,
    event: "start",
    "attributes-type": ATTRIBUTES_TYPE,
    attributes: { orderNumber },
    "content-state": first,
    alert: { title: first.title, body: first.statusText },
  };
  const result = await sendLiveActivity({ fcmToken: device.fcmToken, liveActivityToken: device.startToken, aps });
  if (!result.ok) {
    stats.failed++;
    console.log(`start failed: HTTP ${result.status} ${result.code ?? ""} ${result.message}`);
    if (result.invalidToken) {
      stats.tokensRemoved++;
      await doc.ref.update({ startToken: FieldValue.delete() });
    }
    return;
  }
  stats.started++;
  await stateRef.set({ lastStartAt: nowS, activityId: null, stage: 0 }, { merge: true });
}

// ---------- Main ----------

const nowS = Math.floor(Date.now() / 1000);
const config = await loadConfig();
const devices = await db.collection("liveActivityDevices").get();
stats.devices = devices.size;

for (const doc of devices.docs) {
  try {
    await processDevice(doc, config, nowS);
  } catch (e) {
    stats.failed++;
    console.log(`device error: ${e.message}`);
  }
}

console.log(`${DRY_RUN ? "[dry run] " : ""}${JSON.stringify(stats)}`);
