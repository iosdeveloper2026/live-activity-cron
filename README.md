# Live Activity cron

Scheduled GitHub Actions job that starts, updates and ends the iOS app's Live Activity through
Firebase Cloud Messaging (FCM). It runs about every 5 minutes and can also be run on demand.

## What each run does

1. Reads the Live Activity content from Firebase Remote Config (`live_activity_config`).
2. Reads device tokens from Firestore (`liveActivityDevices`), written by the iOS app.
3. For each device:
   - **Repeat is due** (`REPEAT_EVERY_MINUTES` since the last start): end the running Live Activity,
     if any, and start a fresh one with the device's push-to-start token (iOS 17.2+).
   - **A Live Activity is running:** advance it one stage (`update`), or `end` it at the last stage
     or before iOS's 8-hour limit. With `"showStages": false` it's a static image + title card,
     so it's left as is until the next repeat.
4. Saves each device's progress in Firestore (`liveActivityCronState`).

## Rotating content

Add a `contents` array to `live_activity_config`. Each item is one card and overrides only the
fields it sets (`title`, `subtitle`, `bannerImageUrl`, `accentColor`, `timerMinutes`, ...). Each fresh
Live Activity takes the next item: `"rotation": "sequential"` goes in order, `"random"` picks a random
different one. A running card keeps its content until it's replaced.

The log prints only counts, for example `{"devices":1,"started":0,"updated":1,"ended":0,...}`.

## Use as a template

This repo is a GitHub template: click **Use this template** (or
`gh repo create <owner>/<app>-live-activity-cron --public --template iosdeveloper2026/live-activity-cron`).
Then add the `FIREBASE_SERVICE_ACCOUNT` secret and these repo variables:

| Variable | Default | Meaning |
|---|---|---|
| `REPEAT_EVERY_MINUTES` | 30 | How often a fresh Live Activity starts |
| `ATTRIBUTES_TYPE` | `LiveActivityAttributes` | Swift type name of the app's ActivityAttributes |

## Repeat interval

`REPEAT_EVERY_MINUTES` (default **30**) sets how often a fresh Live Activity starts. Change it in
Settings → Secrets and variables → Actions → **Variables** → `REPEAT_EVERY_MINUTES`, with no code change.
Runs happen about every 5 minutes, so the interval is rounded up to the next run, and each run
moves a running Live Activity forward one stage.

## Setup

1. **Upload the Apple push key to Firebase.** Firebase console → Project settings → Cloud Messaging →
   Apple app configuration → upload the APNs auth key (.p8) with its Key ID and Team ID.
2. **Add the secret.** Firebase console → Project settings → Service accounts →
   Generate new private key. In this repo: Settings → Secrets and variables → Actions →
   New repository secret, name `FIREBASE_SERVICE_ACCOUNT`, value = the whole JSON file.
   Delete the downloaded file afterwards.
3. **Test.** Actions → Live Activity cron → Run workflow.

## Optional settings (in Remote Config `live_activity_config`)

```json
"cron": {
  "startEnabled": true,
  "dismissAfterSeconds": 900
}
```

## Safety

- The only secret is `FIREBASE_SERVICE_ACCOUNT`. Never commit keys or print tokens in logs.
- The workflow has read-only repo permissions and runs only on schedule or manual trigger.
- If a secret ever leaks, delete that key in the Google Cloud console and add a new one here.
