# Human

Paste a sentence and get it back three ways (natural, formal, casual), written to sound like a person. Tap any word to see five synonyms that fit the sentence, and tap a synonym to swap it in.

- **Website:** https://noorj29.github.io/Human/
- **Android app:** [download the latest APK](https://github.com/NoorJ29/Human/releases/latest/download/Human.apk)

## Set up (one time, free)

The rewrites come from a free AI service. Pick one, create a free key, and paste it in the app under **Settings**. The key stays on your device.

| Service | Where to get a free key | Notes |
| --- | --- | --- |
| Groq (default in the app) | https://console.groq.com/keys | Fast, generous free daily limit. Some browsers block Groq on the website; it always works in the Android app. |
| Google Gemini (default on the website) | https://aistudio.google.com/apikey | Works everywhere. Smaller free daily limit; Flash-Lite allows the most requests. |
| OpenRouter | https://openrouter.ai/keys | Free models from many labs. Small free daily limit. |

Free limits are set by each service and can change.

Synonyms come from [Datamuse](https://www.datamuse.com/api/) and the [Free Dictionary API](https://dictionaryapi.dev/). Both are free and need no key. With an AI key, the AI picks the five that fit your sentence.

## Install the Android app

1. On your phone, open the APK link above and download `Human.apk`.
2. Open it. If Android asks, allow your browser to install apps.
3. Tap **Install**.

### Updates

Every push to `main` builds a new version automatically. When one is ready, the app shows **"Version 1.0.x is ready"** at the top. Tap **Update**: the app downloads the new APK and opens the installer. The first time, Android asks you to allow Human to install apps. You can also check by hand in **Settings → Check for updates**.

## How it is built

```
web/                     The whole app (plain HTML, CSS, JavaScript; no build step)
  index.html, styles.css, app.js
  fonts/                 Literata, Schibsted Grotesk, Young Serif (OFL), self-hosted
  vendor/capacitor.js    Capacitor runtime (lets the app call native code)
android/                 Capacitor Android project that wraps web/
  app/src/main/java/com/noorj29/human/AppUpdaterPlugin.java   in-app updater
.github/workflows/build.yml   Builds the APK, publishes a release, deploys the website
tools/signing.py              Builds the signing keystore from the HUMAN_SIGNING_PASSPHRASE secret
```

- Each push to `main` runs **Build app and website**: it stamps the version (`1.0.<run number>`), builds a signed APK, checks its signature, publishes it as the latest GitHub release, and publishes `web/` to the `gh-pages` branch for GitHub Pages.
- The app checks `https://api.github.com/repos/NoorJ29/Human/releases/latest` on launch and offers the update if the release is newer than the installed version.
- Inside the Android app, network calls go through Capacitor's native HTTP, so browser CORS rules don't apply there.

### Run the website locally

```
npm run serve        # then open http://localhost:8080
```

### Build the APK yourself

Needs Node 22+, JDK 21 and the Android SDK.

```
npm ci
npm run apk          # output: android/app/build/outputs/apk/release/app-release.apk
```

### Signing key (needed for updates)

Android only installs an update over the old app when both are signed with the same key. The key is built during each CI run from one secret, so no key file is ever stored in this repo:

1. Go to **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `HUMAN_SIGNING_PASSPHRASE`. Value: your private passphrase (keep a copy somewhere safe).
3. Save, then re-run the latest **Build app and website** workflow (or push any change).

`android/signing/human-cert.pem` is the matching public certificate (safe to share). `tools/signing.py` turns the passphrase into the keystore and refuses to build if the passphrase doesn't match the certificate. Without the secret, CI still builds the app but signs it with a throwaway key and publishes it as a test pre-release that the in-app updater ignores.
