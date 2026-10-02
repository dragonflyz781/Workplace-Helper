# Round Tracker – multi-company edition

Keith's single-file bus / school-run driver app, turned into a small **multi-company web app**:

* A **company** registers itself (company name + admin email + password).
* The **admin** uploads routes (GPX), edits stops and timetables, and creates **driver logins**.
* **Drivers** sign in and get the familiar Round Tracker driver view (map, Sat-Nav mode, Schedule tab, Board/Alight counts) showing **only their own company's routes, live**.
* Companies are completely separated from each other by Firestore security rules.
* **New in v2:** the Sat-Nav shows a live **Next stop** card; Board/Alight taps are recorded **per stop** (within 50 m of it); the driver ends a trip with **Finish & submit run**, and admins see every submitted run in a new **Runs** tab (filters, totals, per-stop breakdown, CSV download).
* **New in v3:** an **Operator details** tab on the Admin page: the company's operator (name, address, telephone, email) is set once and is added to routes automatically – pre-filled in the route editor (editable per route, with a *Using company operator details* / *Custom for this route* indicator and a *Reset to company details* button), added to imported/sample routes, and applied to existing routes with **Apply to all routes** (with confirmation; *only fill empty* or *overwrite all*). Drivers always see an operator in the Schedule (falls back to the company's). See section 4c. **v3.1 bug fix:** passengers added on the Schedule tab (Onboard change − / +) are now included in *Finish & submit run* together with the map Board/Alight taps (see “Boarding by stop”).

It is a plain static website (no build step): `index.html` + `css/` + `js/` + `vendor/`. It uses **Firebase Authentication + Firestore** (free *Spark* plan is enough to start). This is step 1 of wrapping it with Capacitor for iOS/Android (guide at the end).

---

## 0. What you must do yourself (checklist)

1. Create a free Firebase project and turn on Email/Password sign-in + Firestore (section 1).
2. Paste your project's values into **`js/firebase-config.js`**.
3. Publish **`firestore.rules`** (section 1.5) – *without this, nothing is protected / nothing works.*
   **Updating from v1? You MUST re-publish `firestore.rules` again** (Firebase console → Firestore Database → Rules → paste the whole new file → **Publish**, or `npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID`). The new rules add the `runs` collection; until you publish them, *Finish & submit run* fails with “permission denied” (the data then stays on the driver's phone with a Retry button).
   **Updating to v3 (Operator details)? You MUST re-publish `firestore.rules` once more** (same steps as above). The new rules let admins save `companies/{id}.operator` (with size/format validation) and also tighten company updates to only `name` + `operator`. The app still works with your old published rules (they happen to allow an admin to update the company document), but then the server-side checks – required name, email format, size limits, “only `name` + `operator` may change” – are **not enforced**, so please publish them.
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

### 4b. New in v2 – next stop, boarding by stop, runs

**Driver, Sat-Nav view.** Under the unchanged top bar (turn instruction, clock, speed, limit) a **Next stop** card sits at the bottom of the map: stop number, stop name, distance (m / km) and the scheduled time (“Due 07:52”) if the route's timetable has one. It updates with every GPS fix. “Next” = the first stop you have not yet passed along the route's track (the same progress logic as the turn banner); without a track it is the nearest stop. Within 50 m of a stop the card turns green and says **AT STOP n OF m**; after the last stop it says *Route complete*. Name: the name stored on the stop; if that is empty or just “Stop n”, the timetable row name is used when the timetable has one row per stop; else “Stop n”. Time: a timetable row with the same name, else the row at the same position when the timetable has one row per stop (morning/afternoon part chosen by the route's AM/PM session, else by time of day); otherwise no time is shown.

**Boarding by stop.** Within **50 m** of a stop (`AT_STOP_RADIUS_M` in `js/driver-app.js`) the context line reads *“At Stop n — taps log to this stop”* and **+ Board / − Alight** are recorded against that stop. Further away they count as **unscheduled**. The run state (per-stop boarded/alighted taps, unscheduled taps, start time) is kept in `localStorage` (`rt_pax_<routeId>`) so a refresh or crash doesn't lose it.

**Schedule tab “Onboard change” (− / +) – fixed in v3.1:** these per-row taps used to be kept in a separate counter and were *not* in the submitted run. Now the Schedule tab and the map-screen Board/Alight buttons write to the **same per-stop store** (`stopsOn` / `stopsOff` in `rt_pax_<routeId>`), so the confirm dialog, the submitted run (`stops[].index`, per-stop boarded/alighted, totals) and the admin Runs tab include **both**, each tap counted once. A Schedule row is matched to its stop by name (the same way scheduled times are matched), else by position when the timetable has one row per stop; **+** = boarded, **−** = alighted at that stop. A row that matches no stop is counted as *unscheduled* (and still shows its own count). A stop that appears in both the morning and afternoon timetable shares one count (both rows show it). Each row shows the net change plus “on n · off n”. Submitting (or *Reset*) clears everything. Counts saved by the previous version on a phone are folded in automatically the first time the route is opened.

**Finish & submit run.** The **🏁 Finish & submit run** button is in the driver view's lower panel and (floating, under *End Sat-Nav*) in Sat-Nav / full-screen. It opens a summary (route, per stop boarded / alighted, unscheduled, totals) with **Submit** / **Cancel**. Submit writes `companies/{companyId}/runs/{autoId}` and then resets that route's counts. If you are offline or the write fails, the run is **kept on the phone** (`rt_pending_runs`), the counts are not reset, and a red *“… saved on this phone and not uploaded yet”* bar plus a **Retry** button appear. The run keeps its document id, so a retry can never create a duplicate. The driver's name is taken from their profile (`users/{uid}.name`).

**Admin → Runs tab.** Newest first: date/time, driver, route, session, total boarded, total alighted. Click a run for the per-stop table (stop, boarded, alighted, plus the unscheduled row) and a **Delete run** button. Filters: route, driver, date range (by submit date). The summary line shows total passengers boarded and the number of runs for the filtered set. **Download CSV** = the filtered runs, one row per stop per run (columns: Run ID, Submitted, Started, Driver, Route, Session, Stop number, Stop name, Boarded, Alighted) plus one *“Unscheduled”* row per run. The newest 2,000 runs are loaded.

---

### 4c. New in v3 – Operator details

**Admin → Operator details tab** (next to Routes / Drivers / Runs). Enter **Operator name** (required), **Address**, **Telephone** (free text, any format, e.g. `01792 555 000 / 07700 900 123`) and **Email** (optional, but must look like `name@example.com` if given), then **Save operator details**. Limits: name 120, address 250, telephone 40, email 120 characters (the same limits are enforced by `firestore.rules`). Stored as `companies/{companyId}.operator = {name, address?, tel?, email?}`.

**How the details reach routes**

| Where | What happens |
|---|---|
| **New route** in the route editor | Operator fields are pre-filled from the company operator, with the indicator **“Using company operator details”**. Editing any field switches it to **“Custom for this route”** and shows **Reset to company details** (puts the company values back; typing the company values back also returns to “Using company”). Routes loaded from a **GPX file** are new routes, so they get this too. A route saved while using the company details stores `operatorCustom: false`; a custom one stores `operatorCustom: true`. |
| **Import sample routes** | If the company operator is set, imported routes get it (`operatorCustom: false`, replacing the sample's own operator). If it isn't set yet, the samples keep their own operators (marked custom; 4 of the 38 samples have none). |
| **Existing routes** | The **Apply to existing routes** panel (same tab) shows exactly how many routes would change. Choose **Only fill routes that have no operator details** (also refreshes routes that already use the company details; routes marked *Custom* – including older routes that have their own, different operator – are kept) or **Overwrite all routes** (replaces every route, custom ones too), press **Apply to all routes**, and confirm. It applies the *saved* details (it refuses if the form has unsaved edits). After saving, the panel tells you how many existing routes don't use the new details yet. |
| **Driver Schedule** | The driver's *Operator* box shows the route's own operator if it is custom; a route with **no** operator – or one that follows the company – shows the **company's current** operator. The company document is listened to live, so a driver who has the app open sees a changed company operator immediately, even before you press *Apply*. |

The route list shows an **Operator: company / custom / none** tag per route. Companies are independent: one company's operator never touches another company's routes (rules + tested).

**Rules change** (`firestore.rules`): admins of the company may update `companies/{id}` only for the fields `name` and `operator` (so an admin can no longer add arbitrary extra fields to the company doc); `operator` must be a map with only `name` (required, non-blank, ≤120), `address` (≤250), `tel` (≤40), `email` (≤120, `x@y.z` shape or empty); `ownerUid` can never change; drivers (and other companies) can't update the company at all. **Re-publish `firestore.rules`** (section 0, item 3) before using it on your real project.

## 5. Testing – what was actually run

Everything below was run on the build box against the **Firebase emulators** (Auth + Firestore + Hosting), headless Chrome 
(Playwright, `--no-sandbox`). Raw output of the last full run is in `tests/last-run/`; screenshots in `screens/`.

| Suite | Command | Result (last run) |
|---|---|---|
| Geometry (polyline encode/decode, Douglas-Peucker error bound, densify, 120 k-point fit) **+ new `tests/operator.test.mjs`**: operator validation (name required, email format, free-text phone, limits), custom/company status, driver fallback resolution, apply-to-all plan | `npm run test:geo` | **10 / 10 passed** (5 geometry + 5 operator) |
| Firestore security rules (per-company isolation, driver read-only, admin CRUD, no self-promotion, registration abuse, closed collections … **plus 10 new `runs` scenarios**: create only as yourself, restricted key set/types/sizes, server timestamp, cross-company denied, nobody updates, admin-only read-all / delete, driver reads own) | `npm run test:rules` | **37 / 37 passed** (27 earlier + 10 new for operator details: admin can set it, driver / other company / stranger / anonymous cannot, name required, size limits, email format, no extra keys or fields, ownerUid protected, registration can't smuggle it in, route operator fields + batch updates admin-only) |
| Full browser flow (`tests/e2e.py`) – **now including** next-stop card, 50 m boarding, finish/submit, offline retry, admin Runs tab, CSV, cross-company isolation · **v3: Operator details** (see below)| `npm run test:e2e` | **197 / 197 checks passed** (109 earlier + 66 operator + 22 for the v3.1 Schedule-taps fix and phone-width layout), 0 uncaught JS page errors, no unexpected console errors (the only console noise is the browser's own “400”/“Failed to load resource” lines for the deliberately wrong passwords / duplicate emails, and “ERR_INTERNET_DISCONNECTED” lines while the offline test has the network switched off) |

Run all: `npm install && npm test`. (The e2e needs Python Playwright; it uses `/tmp/v/bin/python` and `/usr/bin/google-chrome` by default – override with `E2E_PYTHON` / `CHROME`.)

The browser flow covers: company registration (incl. rejected short password) → admin screen · GPX upload (4 named route points + 76 track points) · rename/reorder/delete stops · add stop by clicking the map · morning/afternoon timetable + note · validation of incomplete timetable rows · save/list/re-open-and-edit round trip · a **30,000-point GPX** (simplified, stored far below 1 MiB, stored as 3,094 points ≈ 10 KB; measured max deviation of the original points from the stored line 1.19 m) · import of the 38 sample routes (+ idempotent re-import) · **invite driver while the admin stays signed in** · duplicate-email refusal · admin opens the driver view · **driver signs in and sees the route, map markers and Schedule (times, note, operator, capacity)** · Sat-Nav mode starts with fake GPS (clock/speed/limit top bar, no separate GPS / Google-Maps buttons) · **admin edits a route and the driver's screen updates live** · driver cannot write/delete routes or promote themselves · **a second company sees none of the first company's routes and is refused (`permission-denied`) when it tries to read/list/write them, their users or team list directly** · sign-out / sign-in · removing a driver locks them out; re-adding restores · wrong password message · unconfigured `firebase-config.js` shows the "connect Firebase" screen.

**New in v3 – what the browser test does (Operator details):** empty tab + apply disabled · empty / whitespace name and bad email refused (nothing stored) · valid save stores `companies/{cid}.operator` (free-text phone kept) and survives a reload · apply panel shows exact counts (41 routes: 6 without operator, 35 custom) · new route pre-filled + “Using company operator details”, editing → “Custom for this route” + reset button, reset / typing back → company again · GPX import keeps the pre-filled operator · bad email blocks a route save · custom route stored `operatorCustom: true`, normal one `false` · route-list tags · a route with no operator opens with company details · **driver Schedule falls back to the company operator** (route with none, sample route with none) while a custom route keeps its own · *Apply* Cancel changes nothing · *fill-only* fills exactly the 6 empty routes and keeps the 36 custom ones · reset-to-company on a sample route · *overwrite all* (confirm text warns) puts the company operator on all 43 routes incl. the 38 samples · changing the company operator updates the driver's open Schedule live (before Apply), *Apply* refreshes all routes, re-importing samples picks it up · company B untouched (no operator, empty tab, new route not pre-filled, driver Schedule shows none, cannot write A's operator/routes) · a driver cannot write the company operator / name / a route's operator · the rules reject empty name, bad email, over-long name/tel/address, unknown keys and an ownerUid change even from the admin's browser.

**v3.1 – what the browser test does (Schedule-tab passengers):** Schedule-only taps (stop 1 +2, stop 3 +1, stop 2 −1) are stored per stop index, shown on the rows, listed in the confirm dialog (no “not included” note), written to the submitted run (per-stop + totals 3/1) and shown in the admin Runs tab; store, rows and map counter are cleared after submit · a mix (map taps at stop 1 and unscheduled + Schedule taps on stops 1–4): each tap counted once (7 boarded / 2 alighted), map counter 5, survives a refresh, confirm dialog = submitted run = admin Runs tab · counts saved by the old version migrate once · a timetable row that matches no stop is counted as unscheduled · the Operator tab fits a 390 px phone.

**New in v2 – what the browser test does** (all against the emulators, simulated GPS via Playwright's geolocation override): creates a 4-stop route (stop 4 has a generic name → the timetable row supplies the name) · the driver is moved along the track and the **Next stop** card changes from stop 2 → 3 with the right name, distance and time · 20 m from stop 1 → *At Stop 1*, 3 boards + 1 alight logged there · 120 m away → unscheduled · 45 m from stop 2 still counts, 60 m does not (50 m radius) · counts survive a page refresh · the confirm dialog shows the right numbers; Cancel writes nothing; Submit writes exactly one run with exactly the specified fields and the driver name from the profile, then resets the counts · a driver can't update/delete/list-all runs or forge one · a **second run submitted while the browser is offline** is kept on the phone, then uploaded with Retry after reconnecting (no duplicate) · the admin's **Runs** tab (newest first, per-stop breakdown, filters by route/driver/date, totals, CSV content, delete) · **company B** sees no runs and is refused (`permission-denied`) when it tries to read/list/delete/create in A's runs.

Note: `js/firebase-config.js` now holds Keith's real project. The test's “setup screen” check therefore serves the page a *placeholder* copy of that file through Playwright request interception (the file itself is never changed, and the real project is never contacted – every other test uses `?emulator=1`).

**Not tested for v3.1 (Schedule taps):** against the real Firebase project / a real phone; Schedule-tab taps on a route whose same stop appears in both morning and afternoon timetables (implemented as one shared count, not exercised); moving GPS while tapping. **Not tested for v3 (Operator details):** against the real Firebase project (emulators only – publish the new rules, then save operator details and press *Apply* once yourself); the client-side apply with more than 400 routes (it writes in batches of 400; only 43 routes were tried); two admins editing at the same time; the *Reset to company details* confirm shown when the company has no operator yet; a failure half-way through *Apply* (the message says some routes may already have changed); the live company-operator listener on a flaky connection. Rules `trim()`/`matches()` behaviour was exercised on the emulator only.

**Not tested** (be honest about the gaps): the new run feature against the **real** Firebase project (after you publish the rules, do one real run yourself); the **12 s upload timeout** path (a connection that hangs rather than being cleanly offline – only the clean-offline path was exercised); rules can't check each element of the `stops` array (only its length, ≤ 500; the 1 MiB document limit applies); moving GPS at driving speed through a stop (the test teleports between fixed fixes; the preview mode was not used for boarding); the Next-stop card on a loop route that passes the same stops twice; a real Firebase project / `firebase deploy`; real password-reset *emails* (emulator only prints links); real phones; driving with a moving GPS fix (Sat-Nav was started with a single fake fixed location, so heading-up rotation, OSM speed-limit lookup and turn prompts while moving were not exercised – the driver-view code is the original code, unchanged in those parts); iOS Safari; offline behaviour; Capacitor builds.

## 6. How it works

**Data model (Firestore)**
```
users/{uid}                        { companyId, role: 'admin'|'driver', name, email, createdAt }
companies/{companyId}              { name, ownerUid, createdAt, operator?{name,address?,tel?,email?} }
companies/{companyId}/routes/{id}  { name, category, session, note, capacity, specifiedRoute, operator{}, operatorCustom (bool), contacts[],
                                     timetable{morning[{stop,time}], afternoon[], morningNote, afternoonNote},
                                     stops[{lat,lng,name}], trackEnc (string), trackPoints, trackOriginalPoints,
                                     addedAt, updatedAt, updatedBy }
```
**Security rules (`firestore.rules`, tested)**: you need a `users/{uid}` profile to read anything; you can only touch documents under *your own* `companyId` (looked up server-side from your profile); only admins write routes and manage users; drivers have read-only access to routes. Registration is only allowed as "create a new company *and* yourself as its admin in one batch" (checked with `getAfter`). Admins can add only `driver` profiles to their own company and cannot change roles/companies. Everything else is closed.

**Runs (new)**
```
companies/{companyId}/runs/{autoId}  { routeId, routeName, session ('AM'|'PM'), driverUid, driverName, startedAt (timestamp),
                                       submittedAt (server timestamp), totalBoarded, totalAlighted,
                                       unscheduledBoarded, unscheduledAlighted,
                                       stops: [{ index (0-based position in the route's stop list; stop number = index + 1), name, boarded, alighted }] }
```
Run rules: drivers *and* admins of the company may **create** a run only if `driverUid == request.auth.uid`, the key set is exactly the 12 fields above, types/sizes are sane (names ≤ 200/120 chars, counts are ints 0…100,000, ≤ 500 stops, `submittedAt == request.time`); **nobody can update** a run; admins can read all runs of their company and **delete** them; a driver can read only their own runs (queries must filter on `driverUid`); other companies get nothing. Run docs are write-once, so a mistake is fixed by deleting the run (admin) and re-submitting.

**Passenger Board/Alight counts** are stored on the device (`localStorage`) while a run is in progress, so a refresh doesn't lose them; when the driver taps **Finish & submit run** one run document is written (see above) and the local counts are reset.

**Inviting drivers without Cloud Functions (free Spark plan).** Firebase creates and *signs in* a new user whenever `createUserWithEmailAndPassword` is called, so doing it on the admin's own session would log the admin out. Instead the admin's browser starts a **second, separate Firebase app instance** (`secondary`), creates the driver's login on *that* instance, then signs the secondary instance out; the admin's session is untouched. The admin's (primary) session then writes `users/{driverUid} {companyId, role:'driver', …}` – the rules allow this only for admins and only for their own company. If writing the profile fails, the just-created login is deleted again (implemented; failure path not separately tested). Trade-offs: the admin chooses/sees the temporary password; there is no in-app "change password" (drivers use *Forgot password?*); deleting a driver removes their profile (access) but the Firebase login itself can only be deleted in the console or with an Admin SDK / Cloud Function. If an email already has a login (e.g. a removed driver), the admin can re-add them by entering the *same* password – the existing login is re-linked.

**Large tracks & the 1 MiB document limit.** Firestore can't store arrays of arrays, and plain `[lat,lng]` lists are bulky, so the track is stored as an **encoded polyline string** (Google algorithm, 5 decimal places ≈ 1 m): about 3–4 characters per point on simulated GPS data (a 12,000-point track ≈ 40 KB). Tracks up to **12,000 points** are stored as-is; longer ones are simplified with **Douglas-Peucker** starting at 1 m tolerance and widening until they fit (a 120,000-point recording became ~12,000 points at 1 m tolerance, measured max deviation 1.03 m). The admin is told when this happens. A final size check refuses anything over ~900 KB. On the driver side long straight segments are re-densified to ≤ 30 m so the original app's "road heading from the nearest track point" logic still works.

**Real-time & offline**: the driver view listens to `companies/{id}/routes` (changes appear immediately; the route being driven is only redrawn if *its* data changed). Firestore's on-device cache keeps routes available through patchy signal (map tiles still need internet). Signing out also tries to clear that cache (so a shared phone doesn't keep the previous company's routes) – implemented but not separately tested.

## 7. Known limitations

* **Open sign-up**: anyone who finds the URL can register a *new* company (they can never see other companies' data, but they use your free quota). Consider Firebase App Check, or removing the "Register" tab and creating companies yourself, before going public.
* No email verification, no in-app change-password, no 2-factor; one admin per company (no way yet to add a second admin or transfer ownership).
* Removing a driver doesn't delete their Firebase login (see above).
* Passenger counts are per device while a run is in progress (nothing is live-synced); the admin sees them only after the driver submits the run. A run that is never submitted (phone lost, app data cleared) is lost. Run documents can't be edited, only deleted.
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
5. Live driver position / in-progress counts for admins (runs are only reported when submitted); per-driver assignment of routes.
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
js/driver-app.js      the ORIGINAL driver code; routes arrive via RoundTracker.setRoutes(); v2 adds the Next stop card, per-stop counts, Finish & submit run
js/runs.js            new in v2: admin Runs tab (list, filters, totals, CSV, delete)
js/operator.js        new in v3: operator-details helpers (validation, custom/company status, driver fallback, apply plan) - unit-tested
js/sample-routes.js   Keith's 38 sample routes (loaded only when "Import sample routes" is clicked)
firestore.rules       security rules          firebase.json / .firebaserc / firestore.indexes.json   Firebase config
sample/sample-route.gpx   small GPX to try      tests/   unit, rules and end-to-end tests (+ last-run/ output)
screens/              screenshots from the end-to-end run     tools/make-www.mjs   copies the app to ./www for Capacitor
```
