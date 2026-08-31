# Reseed

Type in hashtags. Reseed drives your own signed-in YouTube or Instagram session
and teaches the recommender those tags instead of whatever it currently thinks
you are.

There is no API for this. Neither platform exposes one that can write the
signals a recommendation feed actually learns from — watch time above all. So
Reseed does what a person would do, on a timer: it searches each tag, opens what
comes back, and dwells on it long enough to count.

## Two sessions, on purpose

Instagram runs in a pane inside the app. YouTube does not, and that is
deliberate.

Google blocks sign-in from embedded browsers, and that check is worth
respecting: it is what stops an app from wrapping a Google login and reading the
password. Reseed does not try to beat it. For YouTube it drives **the Chrome you
already have**, in a profile of its own under Reseed's app data — separate from
your everyday profile, signed in only here.

That splits into two windows, and the split matters:

| Window | Debug port | `navigator.webdriver` | What it is for |
| --- | --- | --- | --- |
| Sign in | no | `false` | You type your password here |
| Run | yes | `true` | Reseed drives this one |

Chrome turns `navigator.webdriver` on whenever a debugging port is open —
whether or not anything is attached, which is measurable and was measured. So
the window you sign into never has one. By the time the driven window opens, the
session cookie is already on disk. Chrome allows one window per profile, so
Reseed asks you to close the sign-in window before a run rather than killing it
and risking an unflushed cookie jar.

```
build/Reseed-1.0.0-Setup.exe       Windows installer
build/Reseed-1.0.0-portable.exe    Windows, no install
build/Reseed-1.0.0.apk             Android 7.0+, sideload
```

## How a run works

1. **Search the tag.** Writes to search history, which is itself an input.
2. **Harvest the results.** Pulls video ids or post permalinks out of the page.
3. **Open and dwell.** Plays each item muted for your chosen dwell, skipping ads
   and not counting ad seconds as watch time.
4. **Reload the feed** at the end of each round, so you can watch it drift.

Three signals are off by default because they are public actions other people
can see — liking, subscribing/following, and (desktop, YouTube only) sweeping
the home feed with *Not interested*. Turning any of them on makes the app
confirm exactly what it is about to do before the run starts.

Watching alone is private. That is also the signal that matters most, so the
defaults are not a compromise.

## What actually moves a feed

Ranked roughly by how much they move it:

| Signal | Where |
| --- | --- |
| Watch time on a video | both apps, always on |
| Clearing or pausing old watch history | the button; you click the confirm |
| Subscribing / following | optional switch |
| Search history | optional switch, on by default |
| Likes | optional switch |
| *Not interested* on home-feed cards | desktop, YouTube |

The single biggest lever is not in the list twice by accident: **new tags grow
much faster once the old history stops voting.** Reseed opens the history page
for you and stops there — it will not delete anything on your behalf.

A feed drifts, it does not flip. Expect a few rounds over a few days.

## What it will not do

- Type a password. You sign in yourself, in a clean Chrome window.
- Click through a consent screen, a login wall or a captcha. It detects those,
  stops, and hands the window back with an explanation.
- Delete history, change account settings, or take any public action you did not
  switch on.

## Known limits

- **Android hands YouTube off rather than driving it.** Google blocks sign-in
  from a WebView, so the app can never hold your YouTube account. Instead it
  searches your tags in the WebView (searching needs no login), then opens the
  results in Chrome as one autoplaying playlist via a Custom Tab — Chrome is
  already signed in as you, so the watch time lands on your real account. It
  does not claim those watches: it says it queued them. Dwell, rounds and the
  act-on-your-account switches are hidden in that mode, because none of them
  would be true. Instagram on Android is still fully driven in the WebView.
- **Automating a logged-in session is against both platforms' terms of service**
  in a strict reading, even though it is your own account and your own
  attention. Rate limits and account flags are a real, if small, risk. Keep the
  dwell human, leave the pacing jitter on, and do not run it for hours.
- **Selectors are DOM-dependent.** Like, subscribe and prune target buttons by
  their accessible labels in English and Turkish. If a platform renames things,
  those degrade to a logged warning; watching and searching keep working because
  they only need URLs.
- **Instagram web engagement counts for less** than in-app engagement, so the
  Instagram side moves Explore more slowly than the YouTube side moves Home.
- The Android app stops a run if you leave the app — Android throttles a
  backgrounded WebView, and a run that kept going there would report watch time
  it never accrued. Keep it on screen.

## Layout

```
tools/            mark.js, icons.js, and the generators for every icon both
                  apps ship — the .ico, the Android launcher and vectors all
                  come from one piece of geometry
desktop/          Electron. main.js + preload.js + chrome.js (the CDP driver)
                  + ui/{index,style,app,engine}
mobile/           Kotlin, XML views. MainActivity + Engine + Snips
```

Regenerate icons after editing `tools/mark.js` or `tools/icons.js`:

```bash
node tools/build-icons.js && node tools/build-ui-icons.js
```

Desktop:

```bash
cd desktop && npm install && npm start
```

Android (JDK 17 and the Android SDK, `local.properties` points at it):

```bash
cd mobile && ./gradlew assembleRelease
```

Release builds need a signing key, which is deliberately not in this repo:

```bash
keytool -genkeypair -v -keystore mobile/reseed.keystore -alias reseed -keyalg RSA -keysize 2048 -validity 10000
```

Then copy `mobile/keystore.properties.example` to `mobile/keystore.properties`
and fill in the passwords you chose. Without it the release build still
succeeds, just unsigned. The keystore and that properties file are both
gitignored, so a clone of this repo can never sign an update over a published
build.

## Status

The desktop app has been run end to end, including the full Chrome path:
launch, attach over CDP, navigate, run async injected script, and harvest real
video ids off a search page. The two-window sign-in split was verified too — the
run correctly refuses while the sign-in window holds the profile lock.

What has NOT been verified is a signed-in run, because that needs your Google
password and Reseed never touches one. The first real run is yours.

The Android app compiles, packages and signs, but **has never been run on a
device** — there was no phone or emulator attached to build against. Treat the
first launch as the real smoke test.
