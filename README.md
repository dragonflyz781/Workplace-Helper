# Round Tracker – multi-company edition

Keith's single-file bus / school-run driver app, turned into a small **multi-company web app**:

* A **company** registers itself (company name + admin email + password).
* The **admin** uploads routes (GPX), edits stops and timetables, and creates **driver logins**.
* **Drivers** sign in and get the familiar Round Tracker driver view (map, Sat-Nav mode, Schedule tab, Board/Alight counts) showing **only their own company's routes, live**.
* Companies are completely separated from each other by Firestore security rules.

It is a plain static website (no build step): `index.html` + `css/` + `js/` + `vendor/`. It uses **Firebase Authentication + Firestore** (free *Spark* plan is enough to start). This is step 1 of wrapping it with Capacitor for iOS/Android (guide at the end).

---

## 0. What you must do yourself (checklist)

1. Create a free Firebase project and turn on Email/Password sign-in + Firestore (section 1).
2. Paste your project's values into **`js/firebase-config.js`**.
3. Publish **`firestore.rules`** (section 1.5) – *without this, nothing is protected / nothing works.*
4. Put the files on a web host (section 2), then open the site and register your company.

Nothing here could be tested against a real Firebase project from my side (I have no access to your account) – everything was tested against the official **Firebase emulators** (section 5).

---

## 1. Create the free Firebase project (≈10 minutes, no credit card)

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. **Create a project** → give it a name (e.g. `round-tracker`) → you can turn Google Analytics **off** → *Create project*.
3. **Authentication**: left menu *Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save*.
4. **Firestore**: *Build → Firestore Database → Create database* → choose a location near you (e.g. `eur3` / `europe-west2` London) → start in **production mode** → *Enable*.
5. **Rules** (important): *Firestore Database → Rules* tab → delete what is there → paste the whole contents of **`firestore.rules`** from this folder → **Publish**.
   *(Alternative for technical users: `npx firebase-tools login`, then `npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID`.)*
6. **Web app config**: click the cog ⚙ next to *Project Overview → Project settings → General → Your apps → the `</>` (Web) icon* → give it a nickname → *Register app*. You'll see a block like:
   ```js
   const firebaseConfig = { apiKey: "AIza…", authDomain: "round-tracker-123.firebaseapp.com", projectId: "round-tracker-123", … };
   ```
7. Open **`js/firebase-config.js`** in any text editor and replace each `PASTE_…` value with the matching value. Save.
   (These values are not secrets; the rules + sign-in protect your data.)
8. After you know your site's address (section 2): *Authentication → Settings → Authorized domains → Add domain* (e.g. `yourname.github.io`). `localhost` is already allowed.

## 2. Put it online (pick one)

| Option | Steps (short) |
|---|---|
| **Firebase Hosting** (same project, free) | Install Node.js, then in this folder: `npx firebase-tools login` → `npx firebase-tools deploy --only hosting --project YOUR_PROJECT_ID`. `firebase.json` is already set up (it skips tests/screens/etc.). |
| **GitHub Pages** (free) | Create a GitHub repository, upload everything in this folder (not `node_modules`), then *Settings → Pages → Deploy from branch → main / root*. Your site is `https://USERNAME.github.io/REPO/`. |
| **Netlify Drop / any static host** | Zip or drag the folder (after `npm run build:www` use the `www` folder). |

GPS needs **https** (all of the above are https) or `localhost`.

## 3. Run it on your own computer

**A. With your real Firebase project** (after section 1): in this folder run `python3 -m http.server 8000` (or `npx http-server`) and open <http://localhost:8000>.

**B. Demo mode – no Firebase project needed** (uses the emulators with throw-away fake data):
```bash
npm install            # once; downloads firebase-tools etc.  (needs Node 18+; Java 11+ for the Firestore emulator)
npm run demo           # starts Auth + Firestore + hosting emulators
```
then open **<http://localhost:5000/?emulator=1>**. The `?emulator=1` switch is honoured only on `localhost`; data vanishes when you stop it.

## 4. Using it

1. **Register your company** (second tab on the first screen). You land on the **Admin** screen.
2. **Routes → ＋ New route**: name, category (school/college/other), session (AM/PM/both), then **Upload GPX**.
   * GPX **track** points → the route line. GPX **route points** (`<rtept>`) – or, if none, **waypoints** (`<wpt>`) – → numbered **stops**, using their `<name>` if present.
   * Rename stops, re-order (▲▼), delete (✕), drag markers on the map, or press **Add stop on map** and click the map.
   * **Timetable**: stop name + time for morning and afternoon (**Fill from stops** creates one row per stop), plus an afternoon note, capacity, operator details, contacts, notes. **Save**.
3. **Import sample routes** (admin-only button): one click imports Keith's 38 Swansea school/college routes into *your* company (safe to press twice – same IDs, no duplicates).
4. **Drivers → Add a driver**: name, email, temporary password (or **Generate**). Give the driver the email + password. They sign in at the same address and see the driver view only. **Remove** revokes access instantly; **Send password reset** emails a reset link.
5. **🧭 Driver view** (top bar) lets the admin see exactly what drivers see; *☰ → ⚙ Admin screen* goes back.

---

## 5. Testing – what was actually run

Everything below was run on the build box against the **Firebase emulators** (Auth + Firestore + Hosting), headless Chrome 
(Playwright, `--no-sandbox`). Raw output of the last full run is in `tests/last-run/`; screenshots in `screens/`.

| Suite | Command | Result (last run) |
|---|---|---|
| Geometry (polyline encode/decode, Douglas-Peucker error bound, densify, 120 k-point fit) | `npm run test:geo` | **5 / 5 passed** |
| Firestore security rules (17 scenarios: per-company isolation, driver read-only, admin CRUD, no self-promotion, registration abuse, closed collections …) | `npm run test:rules` | **17 / 17 passed** |
| Full browser flow (`tests/e2e.py`) | `npm run test:e2e` | **51 / 51 checks passed**, 0 uncaught JS page errors, no unexpected console errors (the only console noise is the browser's own "400" lines for the deliberately wrong passwords / duplicate emails) |

Run all: `npm install && npm test`. (The e2e needs Python Playwright; it uses `/tmp/v/bin/python` and `/usr/bin/google-chrome` by default – override with `E2E_PYTHON` / `CHROME`.)

The browser flow covers: company registration (incl. rejected short password) → admin screen · GPX upload (4 named route points + 76 track points) · rename/reorder/delete stops · add stop by clicking the map · morning/afternoon timetable + note · validation of incomplete timetable rows · save/list/re-open-and-edit round trip · a **30,000-point GPX** (simplified, stored far below 1 MiB, stored as 3,094 points ≈ 10 KB; measured max deviation of the original points from the stored line 1.19 m) · import of the 38 sample routes (+ idempotent re-import) · **invite driver while the admin stays signed in** · duplicate-email refusal · admin opens the driver view · **driver signs in and sees the route, map markers and Schedule (times, note, operator, capacity)** · Sat-Nav mode starts with fake GPS (clock/speed/limit top bar, no separate GPS / Google-Maps buttons) · **admin edits a route and the driver's screen updates live** · driver cannot write/delete routes or promote themselves · **a second company sees none of the first company's routes and is refused (`permission-denied`) when it tries to read/list/write them, their users or team list directly** · sign-out / sign-in · removing a driver locks them out; re-adding restores · wrong password message · unconfigured `firebase-config.js` shows the "connect Firebase" screen.

**Not tested** (be honest about the gaps): a real Firebase project / `firebase deploy`; real password-reset *emails* (emulator only prints links); real phones; driving with a moving GPS fix (Sat-Nav was started with a single fake fixed location, so heading-up rotation, OSM speed-limit lookup and turn prompts while moving were not exercised – the driver-view code is the original code, unchanged in those parts); iOS Safari; offline behaviour; Capacitor builds.

## 6. How it works

**Data model (Firestore)**
```
users/{uid}                        { companyId, role: 'admin'|'driver', name, email, createdAt }
companies/{companyId}              { name, ownerUid, createdAt }
companies/{companyId}/routes/{id}  { name, category, session, note, capacity, specifiedRoute, operator{}, contacts[],
                                     timetable{morning[{stop,time}], afternoon[], morningNote, afternoonNote},
                                     stops[{lat,lng,name}], trackEnc (string), trackPoints, trackOriginalPoints,
                                     addedAt, updatedAt, updatedBy }
```
**Security rules (`firestore.rules`, tested)**: you need a `users/{uid}` profile to read anything; you can only touch documents under *your own* `companyId` (looked up server-side from your profile); only admins write routes and manage users; drivers have read-only access to routes. Registration is only allowed as "create a new company *and* yourself as its admin in one batch" (checked with `getAfter`). Admins can add only `driver` profiles to their own company and cannot change roles/companies. Everything else is closed.

**Passenger Board/Alight counts** are still stored on the device (`localStorage`), exactly like the original app – so nothing is written to Firestore by drivers in this version (and the rules give drivers no write access at all).

**Inviting drivers without Cloud Functions (free Spark plan).** Firebase creates and *signs in* a new user whenever `createUserWithEmailAndPassword` is called, so doing it on the admin's own session would log the admin out. Instead the admin's browser starts a **second, separate Firebase app instance** (`secondary`), creates the driver's login on *that* instance, then signs the secondary instance out; the admin's session is untouched. The admin's (primary) session then writes `users/{driverUid} {companyId, role:'driver', …}` – the rules allow this only for admins and only for their own company. If writing the profile fails, the just-created login is deleted again (implemented; failure path not separately tested). Trade-offs: the admin chooses/sees the temporary password; there is no in-app "change password" (drivers use *Forgot password?*); deleting a driver removes their profile (access) but the Firebase login itself can only be deleted in the console or with an Admin SDK / Cloud Function. If an email already has a login (e.g. a removed driver), the admin can re-add them by entering the *same* password – the existing login is re-linked.

**Large tracks & the 1 MiB document limit.** Firestore can't store arrays of arrays, and plain `[lat,lng]` lists are bulky, so the track is stored as an **encoded polyline string** (Google algorithm, 5 decimal places ≈ 1 m): about 3–4 characters per point on simulated GPS data (a 12,000-point track ≈ 40 KB). Tracks up to **12,000 points** are stored as-is; longer ones are simplified with **Douglas-Peucker** starting at 1 m tolerance and widening until they fit (a 120,000-point recording became ~12,000 points at 1 m tolerance, measured max deviation 1.03 m). The admin is told when this happens. A final size check refuses anything over ~900 KB. On the driver side long straight segments are re-densified to ≤ 30 m so the original app's "road heading from the nearest track point" logic still works.

**Real-time & offline**: the driver view listens to `companies/{id}/routes` (changes appear immediately; the route being driven is only redrawn if *its* data changed). Firestore's on-device cache keeps routes available through patchy signal (map tiles still need internet). Signing out also tries to clear that cache (so a shared phone doesn't keep the previous company's routes) – implemented but not separately tested.

## 7. Known limitations

* **Open sign-up**: anyone who finds the URL can register a *new* company (they can never see other companies' data, but they use your free quota). Consider Firebase App Check, or removing the "Register" tab and creating companies yourself, before going public.
* No email verification, no in-app change-password, no 2-factor; one admin per company (no way yet to add a second admin or transfer ownership).
* Removing a driver doesn't delete their Firebase login (see above).
* Passenger counts are per device, not synced or reported to the admin.
* Admin route editor: GPX only (no KML/FIT), no undo, one editor per route (last save wins), no drag-to-reorder (use ▲▼).
* The first screen load downloads all of a company's routes (≈ 10–20 KB each); fine for dozens/hundreds of routes. Free-plan quotas (Spark): roughly 50 k reads / 20 k writes per day – check Firebase's current pricing page.
* Fonts come from Google Fonts and map tiles from OpenStreetMap (internet needed; OSM's tile policy is for light use – use a paid tile provider for a commercial fleet). The Sat-Nav speed-limit lookup and "directions to first stop" use public OSM/OSRM services as in the original app.
* A bug in the original file was fixed on the way: on narrow (phone) screens the Map and Schedule panes were both shown at start with the map squashed to 0 px height; the app now starts on the Map tab.
* Tested in Chrome only.

## 8. Wrapping it with Capacitor (iOS / Android) – simple guide

The site is already static, so wrapping is mostly configuration. (Needs Node.js; Xcode for iOS (Mac only); Android Studio for Android; an Apple Developer account (£/$99 per year) and a Google Play account ($25 once) to publish.)

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npm run build:www                         # copies index.html, css, js, vendor into ./www
npx cap init "Round Tracker" com.yourcompany.roundtracker --web-dir=www
npx cap add ios && npx cap add android
npx cap sync                              # run again after every change to the web files (build:www first)
npx cap open ios      # or: npx cap open android   -> run on a device from Xcode / Android Studio
```
Things to do for a real app:
1. **Location permissions**: iOS `Info.plist` → `NSLocationWhenInUseUsageDescription` (and `…AlwaysAndWhenInUse…` if you add background tracking); Android `AndroidManifest.xml` → `ACCESS_FINE_LOCATION` (+ `ACCESS_BACKGROUND_LOCATION`, foreground service for background).
2. **Screen on while navigating**: the Sat-Nav already requests a Wake Lock; on native use `@capacitor-community/keep-awake`.
3. **Background GPS**: a web view stops delivering GPS when the phone is locked. Use a plugin such as `@capacitor-community/background-geolocation` (or Transistorsoft's) and feed its fixes into the app instead of `navigator.geolocation` (the hook point is `watchPosition` in `js/driver-app.js`).
4. **Offline assets**: Google Fonts are fetched online; for a fully offline shell download the two fonts into `/fonts` and reference them from `css/`. Consider caching map tiles (paid provider terms permitting).
5. Firebase Auth email/password works unchanged inside the web view (origin `capacitor://localhost` on iOS, `https://localhost` on Android). Add the App Check provider for native when you move to production.
6. Icons/splash: `npx @capacitor/assets generate`.

## 9. Recommended next steps

1. Do the Firebase setup above and try it with 1–2 real drivers on their own phones in the browser.
2. Add **Firebase App Check** and decide how new companies should be approved (invite code, or Cloud Function / manual).
3. **Capacitor wrap + background-GPS plugin** (section 8); test battery use and iOS review rules for location apps.
4. Move to the **Blaze (pay-as-you-go)** plan only when needed: it unlocks Cloud Functions (clean driver invites by email link, deleting logins, second admins, usage reports, scheduled clean-ups) – set a budget alert first. Typical small fleets stay within the free quotas.
5. Sync passenger counts (and maybe live driver position) to Firestore so admins can see them; the rules already have the shape for adding `companies/{id}/…` collections with driver write access limited to their own uid.
6. Per-route driver assignment, route versioning/history, KML import, bulk timetable paste.

## 10. File map

```
index.html            all screens (sign-in, admin, editor, driver view markup)
css/app.css           the ORIGINAL app styles (unchanged)      css/leaflet.css  Leaflet core CSS (as inlined in the original)
css/admin.css         new: sign-in, admin, editor, layout switch between screens
vendor/               leaflet 1.9.4 + leaflet-rotate 0.2.8 (local copies, so the app works without those CDNs)
js/firebase-config.js ★ YOU PASTE YOUR FIREBASE VALUES HERE
js/firebase-init.js   loads Firebase SDK 12.19.0 from Google's CDN, Auth + Firestore (+ emulator switch, secondary app)
js/main.js            sign-in/registration, profile + company loading, live route subscription, screen switching
js/admin.js           admin: route list/editor/GPX/timetable/map, sample import, driver management
js/geo.js             polyline codec, Douglas-Peucker, densify, GPX parser (unit-tested)
js/driver-app.js      the ORIGINAL driver code; routes now arrive via RoundTracker.setRoutes()
js/sample-routes.js   Keith's 38 sample routes (loaded only when "Import sample routes" is clicked)
firestore.rules       security rules          firebase.json / .firebaserc / firestore.indexes.json   Firebase config
sample/sample-route.gpx   small GPX to try      tests/   unit, rules and end-to-end tests (+ last-run/ output)
screens/              screenshots from the end-to-end run     tools/make-www.mjs   copies the app to ./www for Capacitor
```
