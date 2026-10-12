# Live Activity cron

Scheduled GitHub Actions job that starts, updates and ends the iOS app's Live Activity through
Firebase Cloud Messaging (FCM). It runs about every 15 minutes and can also be run on demand.

## What each run does

1. Reads the Live Activity content from Firebase Remote Config (`live_activity_config`).
2. Reads device tokens from Firestore (`liveActivityDevices`), written by the iOS app.
3. For each device:
   - **A Live Activity is running:** advance it one stage (`update`), or `end` it at the last stage
     or before iOS's 8-hour limit.
   - **Nothing is running:** start one with the device's push-to-start token (iOS 17.2+), at most
     once every `cron.startEveryMinutes` (default 60).
4. Saves each device's progress in Firestore (`liveActivityCronState`).

The log prints only counts, for example `{"devices":1,"started":0,"updated":1,"ended":0,...}`.

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
  "startEveryMinutes": 60,
  "dismissAfterSeconds": 900
}
```

## Safety

- The only secret is `FIREBASE_SERVICE_ACCOUNT`. Never commit keys or print tokens in logs.
- The workflow has read-only repo permissions and runs only on schedule or manual trigger.
- If a secret ever leaks, delete that key in the Google Cloud console and add a new one here.
