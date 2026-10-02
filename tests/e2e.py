"""
End-to-end test in headless Chrome against the Firebase emulators.

Run (from the multico folder; needs the emulators + Playwright for Python):
    npm run test:e2e
which starts the Auth + Firestore + Hosting emulators, then runs this file with
    /tmp/v/bin/python tests/e2e.py
Environment: E2E_PYTHON (default /tmp/v/bin/python), CHROME (default /usr/bin/google-chrome).
"""
import json, math, os, random, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screens"; SHOTS.mkdir(exist_ok=True)
BASE = os.environ.get("BASE", "http://127.0.0.1:5000/?emulator=1")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
GPX = ROOT / "sample" / "sample-route.gpx"

import urllib.request
def reset_emulators():
    """Start every run from empty Auth + Firestore emulators."""
    for url in ("http://127.0.0.1:8080/emulator/v1/projects/demo-multico/databases/(default)/documents",
                "http://127.0.0.1:9099/emulator/v1/projects/demo-multico/accounts"):
        urllib.request.urlopen(urllib.request.Request(url, method="DELETE")).read()
reset_emulators()

results = []          # (name, ok, detail)
page_errors = []      # uncaught JS errors on any page
console_errors = []   # console.error messages (listed, expected ones are filtered below)

def check(name, cond, detail=""):
    results.append((name, bool(cond), str(detail)))
    print(("PASS " if cond else "FAIL ") + name + ((" -- " + str(detail)) if (detail and not cond) else ""))

DIALOG = {"cancel": False}   # set DIALOG["cancel"] = True to press Cancel on the next confirm() dialogs
dialog_msgs = []             # text of every confirm()/alert() shown
def on_dialog(d):
    dialog_msgs.append(d.message)
    d.dismiss() if DIALOG["cancel"] else d.accept()

def watch(page, tag):
    page.on("pageerror", lambda e: page_errors.append(f"[{tag}] {e} :: {(getattr(e, 'stack', '') or '')[:600]}"))
    page.on("console", lambda m: console_errors.append(f"[{tag}] {m.text}") if m.type == "error" else None)
    page.on("dialog", on_dialog)

def shot(page, name):
    page.screenshot(path=str(SHOTS / name))

def make_big_gpx(path, n=30000):
    random.seed(7)
    lat, lon, hd = 51.60, -3.95, 0.0
    pts = []
    for i in range(n):
        hd += random.uniform(-0.03, 0.03) + (0.12 if i % 4000 == 3999 else 0)
        lat += math.cos(hd) * 4e-5 + random.uniform(-4e-6, 4e-6)    # ~4.4 m steps + GPS jitter
        lon += math.sin(hd) * 6.4e-5 + random.uniform(-6e-6, 6e-6)
        pts.append((lat, lon))
    rows = ['<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Big recorded route</name><trkseg>']
    rows += [f'<trkpt lat="{a:.7f}" lon="{b:.7f}"><ele>10</ele></trkpt>' for a, b in pts]
    rows.append('</trkseg></trk></gpx>')
    Path(path).write_text("".join(rows))
    return pts

def wait_view(page, view, timeout=15000):
    page.wait_for_function(f"document.body.classList.contains('view-{view}')", timeout=timeout)

def register(page, company, email, pw, name="Admin"):
    page.goto(BASE); wait_view(page, "auth")
    page.click("#segRegister")
    page.fill("#rgCompany", company); page.fill("#rgName", name)
    page.fill("#rgEmail", email); page.fill("#rgPass", pw)
    page.click("#rgBtn")
    wait_view(page, "admin")

def login(page, email, pw):
    page.goto(BASE); wait_view(page, "auth")
    page.fill("#siEmail", email); page.fill("#siPass", pw); page.click("#siBtn")

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    big_gpx = "/tmp/big_route.gpx"
    big_pts = make_big_gpx(big_gpx)

    # ------------------------------------------------------------------ Not configured -> setup screen (no ?emulator)
    ps = br.new_context(viewport={"width": 900, "height": 700}).new_page(); watch(ps, "setup")
    # js/firebase-config.js now holds Keith's REAL project, so this page is served a PLACEHOLDER copy of it
    # (request interception - the file itself is untouched and the real project is never contacted).
    ps.route("**/js/firebase-config.js", lambda route: route.fulfill(
        status=200, content_type="text/javascript", body='export const firebaseConfig = { apiKey: "PASTE_API_KEY_HERE" };'))
    ps.goto(BASE.split("?")[0]); wait_view(ps, "setup")
    check("placeholder firebase-config.js shows the 'connect Firebase' setup screen", "firebase-config.js" in ps.inner_text("#setupScreen"))
    shot(ps, "00-setup-needed.png"); ps.close()

    # ------------------------------------------------------------------ Company A: register
    ctxA = br.new_context(viewport={"width": 1280, "height": 860})
    A = ctxA.new_page(); watch(A, "adminA")
    A.goto(BASE); wait_view(A, "auth")
    shot(A, "01-sign-in.png")
    A.click("#segRegister"); shot(A, "02-register-company.png")
    # password too short is rejected without creating anything
    A.fill("#rgCompany", "Alpha Coaches"); A.fill("#rgName", "Ann Admin")
    A.fill("#rgEmail", "ann@alpha.test"); A.fill("#rgPass", "abc")
    A.click("#rgBtn"); A.wait_for_timeout(600)
    check("register: short password blocked, still on auth screen", "view-auth" in A.evaluate("document.body.className"))
    A.fill("#rgPass", "Passw0rd!"); A.click("#rgBtn")
    wait_view(A, "admin")
    check("register company -> admin screen shown", A.inner_text("#adminCompany") == "Alpha Coaches", A.inner_text("#adminCompany"))
    uid_a = A.evaluate("window.__mc.auth.currentUser.uid")
    prof = A.evaluate("window.__mc.getDoc(window.__mc.doc(window.__mc.db,'users',window.__mc.auth.currentUser.uid)).then(d=>d.data())")
    cid_a = prof["companyId"]
    check("users/{uid} has role admin + companyId", prof["role"] == "admin" and cid_a, prof)
    comp = A.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}')).then(d=>d.data())")
    check("company doc created with ownerUid", comp["name"] == "Alpha Coaches" and comp["ownerUid"] == uid_a, comp)
    shot(A, "03-admin-routes-empty.png")

    # ------------------------------------------------------------------ Admin: new route via GPX
    A.click("#newRouteBtn"); wait_view(A, "editor")
    A.fill("#ed_name", "Gorseinon Sample (AM)")
    A.select_option("#ed_category", "school"); A.select_option("#ed_session", "AM")
    A.set_input_files("#ed_gpx", str(GPX))
    A.wait_for_function("document.querySelectorAll('#stopList .rowitem').length === 4")
    names = A.eval_on_selector_all("#stopList .stop-name", "els=>els.map(e=>e.value)")
    check("GPX upload: 4 named route points -> stops", names[0] == "Clydach (Post Office)" and len(names) == 4, names)
    check("GPX upload: track points loaded", "Track: 76 points" in A.inner_text("#gpxInfo"), A.inner_text("#gpxInfo"))
    # rename, reorder, delete
    A.fill("#stopList .rowitem:nth-child(1) .stop-name", "Clydach Post Office")
    A.click("#stopList .rowitem:nth-child(2) [data-a=down]")          # swap stops 2 and 3
    names2 = A.eval_on_selector_all("#stopList .stop-name", "els=>els.map(e=>e.value)")
    check("stop reorder (down)", names2[1] == "Gorseinon Square" and names2[2] == "Pontarddulais Road", names2)
    A.click("#stopList .rowitem:nth-child(2) [data-a=up]")
    A.click("#stopList .rowitem:nth-child(2) [data-a=down]")
    A.click("#stopList .rowitem:nth-child(3) [data-a=del]")
    names3 = A.eval_on_selector_all("#stopList .stop-name", "els=>els.map(e=>e.value)")
    check("stop delete", len(names3) == 3, names3)
    # add a stop by clicking the map
    A.click("#addStopBtn")
    box = A.locator("#edMap").bounding_box()
    A.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.3)
    A.wait_for_function("document.querySelectorAll('#stopList .rowitem').length === 4")
    A.click("#addStopBtn")
    A.fill("#stopList .rowitem:nth-child(4) .stop-name", "Gorseinon College")
    nmark = A.evaluate("document.querySelectorAll('#edMap .stop-marker').length")
    check("add stop by clicking map (+ markers drawn)", nmark == 4, nmark)
    # morning timetable: fill from stops then times
    A.click("#ttFillMorning")
    times = ["07:40", "07:52", "08:05", "08:20"]
    for i, t in enumerate(times):
        A.fill(f"#ttMorning .rowitem:nth-child({i+1}) .tt-time", t)
    # afternoon: manual rows
    A.click("#ttAddAfternoon"); A.click("#ttAddAfternoon")
    A.fill("#ttAfternoon .rowitem:nth-child(1) .tt-stop", "Gorseinon College"); A.fill("#ttAfternoon .rowitem:nth-child(1) .tt-time", "15:35")
    A.fill("#ttAfternoon .rowitem:nth-child(2) .tt-stop", "Clydach Post Office"); A.fill("#ttAfternoon .rowitem:nth-child(2) .tt-time", "16:10")
    A.fill("#ed_afternoonNote", "Wait 5 minutes for late finishers")
    A.fill("#ed_capacity", "53 seats"); A.fill("#ed_note", "Test route created by the e2e test")
    A.fill("#ed_op_name", "Alpha Coaches Ltd"); A.fill("#ed_op_tel", "01792 000000"); A.fill("#ed_op_email", "ops@alpha.test")
    A.click("#contactAdd"); A.fill("#contactList .rowitem:nth-child(1) input:nth-child(1)", "Depot"); A.fill("#contactList .rowitem:nth-child(1) input:nth-child(2)", "01792 111111")
    A.wait_for_timeout(1200)
    shot(A, "04-admin-route-editor.png")
    # invalid timetable row is rejected
    A.click("#ttAddMorning"); A.fill("#ttMorning .rowitem:nth-child(5) .tt-stop", "Nowhere")
    A.click("#edSave"); A.wait_for_timeout(400)
    check("editor: timetable row without time is rejected", "view-editor" in A.evaluate("document.body.className") and "needs a time" in A.inner_text("#toast"), A.inner_text("#toast"))
    A.click("#ttMorning .rowitem:nth-child(5) .mini.del")
    A.click("#edSave")
    try:
        wait_view(A, "admin", 8000)
    except Exception:
        print("SAVE DEBUG toast:", A.inner_text("#toast"), "| console:", console_errors[-5:], "| page:", page_errors)
        raise
    A.wait_for_function("document.querySelectorAll('#adminRouteList .arow').length === 1")
    check("route saved and listed", "Gorseinon Sample (AM)" in A.inner_text("#adminRouteList"), A.inner_text("#adminRouteList"))
    shot(A, "05-admin-route-list.png")
    rid = A.evaluate("document.querySelector('#adminRouteList .arow').dataset.routeId")
    stored = A.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid}')).then(d=>d.data())")
    check("stored doc: stops/timetable/operator/track fields", len(stored["stops"]) == 4 and stored["timetable"]["morning"][0]["time"] == "07:40"
          and len(stored["timetable"]["afternoon"]) == 2 and stored["operator"]["name"] == "Alpha Coaches Ltd"
          and stored["trackPoints"] == 76 and isinstance(stored["trackEnc"], str) and stored["capacity"] == "53 seats", {k: (v if k != "trackEnc" else "...") for k, v in stored.items()})

    # edit existing route (round trip) -> change name
    A.click("#adminRouteList .arow [data-act=edit]"); wait_view(A, "editor")
    check("edit: form pre-filled from Firestore", A.input_value("#ed_name") == "Gorseinon Sample (AM)" and A.input_value("#ed_capacity") == "53 seats"
          and A.eval_on_selector_all("#ttMorning .tt-time", "e=>e.map(x=>x.value)") == times)
    A.click("#edBack"); wait_view(A, "admin")

    # ------------------------------------------------------------------ Admin: big GPX -> downsampling
    A.click("#newRouteBtn"); wait_view(A, "editor")
    A.set_input_files("#ed_gpx", big_gpx)
    A.wait_for_function("document.getElementById('ed_name').value === 'Big recorded route'", timeout=30000)
    info = A.inner_text("#gpxInfo")
    check("big GPX (30,000 pts) is simplified in the editor", "Simplified from 30,000 to" in info, info)
    A.click("#edSave"); wait_view(A, "admin", 30000)
    A.wait_for_function("document.querySelectorAll('#adminRouteList .arow').length === 2")
    big_id = A.evaluate("[...document.querySelectorAll('#adminRouteList .arow')].find(e=>e.innerText.includes('Big recorded')).dataset.routeId")
    st = A.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{big_id}')).then(d=>d.data())")
    size = len(json.dumps({k: v for k, v in st.items() if k not in ('updatedAt',)}))
    check("big GPX stored: <=12,000 pts, doc far below 1 MiB", st["trackPoints"] <= 12000 and size < 300000 and st["trackOriginalPoints"] == 30000, f"pts={st['trackPoints']} bytes~{size} tol={st.get('trackSimplifiedToleranceM')}")
    # fidelity: decode stored track and measure max deviation of original points from the stored polyline
    dev = A.evaluate("""async ({enc, pts}) => {
        const g = await import('/js/geo.js');
        const t = g.decodePolyline(enc);
        const kx = 111320*Math.cos(51.6*Math.PI/180), ky = 111320;
        let worst = 0;
        // distance from every 10th original point to the stored polyline (brute force over segments, bounded window)
        let j = 0;
        for (let i = 0; i < pts.length; i += 10) {
          let best = 1e12;
          for (let k = 0; k < t.length-1; k++) {
            const ax=t[k][1]*kx, ay=t[k][0]*ky, bx=t[k+1][1]*kx, by=t[k+1][0]*ky, px=pts[i][1]*kx, py=pts[i][0]*ky;
            const dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy; let u = l2? ((px-ax)*dx+(py-ay)*dy)/l2 : 0; u=Math.max(0,Math.min(1,u));
            const d = Math.hypot(px-(ax+u*dx), py-(ay+u*dy)); if (d<best) best=d;
          }
          if (best>worst) worst=best;
        }
        return worst;
    }""", {"enc": st["trackEnc"], "pts": big_pts})
    print(f"   info: 30,000 -> {st['trackPoints']} stored points, tolerance {st.get('trackSimplifiedToleranceM')} m, max deviation {dev:.2f} m, doc ~{size} bytes")
    check("big GPX fidelity: max deviation of original points from stored track < 15 m", dev < 15, f"max deviation {dev:.2f} m (tolerance {st.get('trackSimplifiedToleranceM')} m)")

    # ------------------------------------------------------------------ Admin: import samples
    A.click("#importSampleBtn")
    A.wait_for_function("document.querySelectorAll('#adminRouteList .arow').length === 40", timeout=60000)
    check("import sample routes: +38 routes (40 total)", True)
    A.click("#importSampleBtn"); A.wait_for_timeout(2500)
    check("import sample routes is idempotent (still 40)", A.evaluate("document.querySelectorAll('#adminRouteList .arow').length") == 40)
    shot(A, "06-admin-routes-with-samples.png")

    # ------------------------------------------------------------------ Admin: invite driver
    A.click("#admTabDrivers")
    A.fill("#dvName", "Dave Driver"); A.fill("#dvEmail", "dave@alpha.test"); A.fill("#dvPass", "TempPass1")
    A.click("#dvBtn")
    A.wait_for_selector("#driverMsg .cred-box", timeout=15000)
    A.wait_for_function("document.querySelectorAll('#driverList .arow').length === 2")
    check("invite driver: credentials shown, driver listed", "dave@alpha.test" in A.inner_text("#driverList"), A.inner_text("#driverList"))
    check("admin remains signed in after creating a driver (secondary app)", A.evaluate("window.__mc.auth.currentUser.email") == "ann@alpha.test" and "view-admin" in A.evaluate("document.body.className"))
    shot(A, "07-admin-drivers.png")
    # duplicate email is rejected, no profile created
    A.fill("#dvName", "Dave Two"); A.fill("#dvEmail", "dave@alpha.test"); A.fill("#dvPass", "OtherPass9")
    A.click("#dvBtn"); A.wait_for_timeout(2000)
    check("invite driver: duplicate email with wrong password is refused", "already has a login" in A.inner_text("#driverMsg"), A.inner_text("#driverMsg"))
    shot(A, "07b-admin-driver-duplicate-email-refused.png")
    A.fill("#dvName", ""); A.fill("#dvEmail", ""); A.fill("#dvPass", "")

    # ------------------------------------------------------------------ Admin opens driver view
    A.click("#adminToDriver"); wait_view(A, "driver")
    A.wait_for_function("document.getElementById('routeName').textContent !== 'Round Tracker'", timeout=15000)
    check("admin can open driver view and sees routes", A.inner_text("#routeName") != "Round Tracker", A.inner_text("#routeName"))
    check("driver view: no upload/delete controls (read-only)", A.evaluate("!document.getElementById('fileInput') && !document.querySelector('.chip-btn.del')"))
    A.click("#menuBtn"); A.wait_for_timeout(500)
    check("driver drawer shows admin shortcut for admins", A.is_visible("#acctAdmin"))
    shot(A, "08-admin-in-driver-view-drawer.png")
    A.click("#drawerClose")
    A.click("#acctAdmin") if False else None
    A.evaluate("document.getElementById('menuBtn').click()"); A.click("#acctAdmin"); wait_view(A, "admin")
    check("driver view -> back to admin", True)

    # ------------------------------------------------------------------ Driver logs in (separate browser context, phone size)
    ctxD = br.new_context(viewport={"width": 412, "height": 860}, geolocation={"latitude": 51.6770, "longitude": -3.9170},
                          permissions=["geolocation"], device_scale_factor=2)
    D = ctxD.new_page(); watch(D, "driver")
    login(D, "dave@alpha.test", "TempPass1")
    wait_view(D, "driver")
    D.wait_for_function("document.getElementById('routeName').textContent !== 'Round Tracker'", timeout=15000)
    check("driver login -> driver view directly (no admin UI)", not D.is_visible("#acctAdmin") and not D.is_visible("#adminScreen"))
    D.click("#menuBtn"); D.wait_for_timeout(400)
    D.click(".rt-tab:has-text('Schools AM')"); D.wait_for_timeout(300)
    drawer_text = D.inner_text("#routeList")
    check("driver sees company routes in drawer", "Gorseinon Sample (AM)" in drawer_text, drawer_text[:200])
    shot(D, "09-driver-route-drawer.png")
    D.click("#routeList .route-card:has-text('Gorseinon Sample') .chip-btn.use")
    D.wait_for_function("document.getElementById('routeName').textContent === 'Gorseinon Sample (AM)'")
    D.wait_for_timeout(1500)
    shot(D, "10-driver-map.png")
    check("driver map draws route + 4 stop markers", D.evaluate("document.querySelectorAll('#map .stop-marker').length") == 4 and D.evaluate("document.querySelectorAll('#map path.leaflet-interactive').length") >= 1)
    D.click("#tabSchedBtn"); D.wait_for_timeout(500)
    sched = D.inner_text("#schedBody")
    check("driver Schedule tab shows timetable times, stops and note", all(x in sched for x in ["07:40", "08:20", "Gorseinon College", "15:35", "Wait 5 minutes for late finishers", "Alpha Coaches Ltd", "53 seats"]), sched[:300])
    shot(D, "11-driver-schedule.png")
    D.click("#tabMapBtn")
    # Sat-Nav still behaves in the new shell (fake GPS location from the browser context)
    D.click("#satnavBtn"); D.wait_for_timeout(3500)
    sn = D.evaluate("""({mode: document.body.classList.contains('satnav-mode'),
        clock: document.getElementById('snClock').textContent, topVisible: getComputedStyle(document.getElementById('satnavTop')).display,
        speedBox: !!document.getElementById('snSpeed'), limitBox: !!document.getElementById('snLimit'),
        noGps: !document.getElementById('trackBtn').offsetParent, noGmaps: !document.getElementById('navBtn').offsetParent,
        bearing: (window.L && document.querySelector('.leaflet-map-pane')) ? true : false})""")
    check("Sat-Nav mode starts: top bar with clock/speed/limit visible, no GPS/Google Maps buttons", sn["mode"] and re.match(r"^\d\d:\d\d", sn["clock"]) and sn["topVisible"] != "none" and sn["speedBox"] and sn["limitBox"] and sn["noGps"] and sn["noGmaps"], sn)
    shot(D, "12-driver-satnav.png")

    # Real-time: admin renames the route; the driver sees it without reload
    A.click("#admTabRoutes")
    A.click("#adminRouteList .arow:has-text('Gorseinon Sample') [data-act=edit]"); wait_view(A, "editor")
    A.fill("#ed_name", "Gorseinon Sample (AM) v2"); A.click("#edSave"); wait_view(A, "admin")
    try:
        D.wait_for_function("document.getElementById('routeName').textContent === 'Gorseinon Sample (AM) v2'", timeout=15000)
    except Exception:
        print("RT DEBUG", D.inner_text("#routeName"), page_errors, console_errors[-6:], A.inner_text("#adminRouteList")[:300]); raise
    check("real-time: admin edit appears on driver's screen without reload", True)

    # drivers must not be able to write
    r = D.evaluate(f"""window.__mc.setDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','hack'),{{name:'x'}}).then(()=>'WRITTEN').catch(e=>e.code)""")
    check("driver cannot write routes (permission-denied)", r == "permission-denied", r)
    r = D.evaluate(f"""window.__mc.deleteDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid}')).then(()=>'DELETED').catch(e=>e.code)""")
    check("driver cannot delete routes (permission-denied)", r == "permission-denied", r)
    r = D.evaluate("""window.__mc.getDoc(window.__mc.doc(window.__mc.db,'users',window.__mc.auth.currentUser.uid)).then(d=>d.data().role)""")
    check("driver profile role is driver", r == "driver", r)
    r = D.evaluate("""window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'users',window.__mc.auth.currentUser.uid),{role:'admin'}).then(()=>'PROMOTED').catch(e=>e.code)""")
    check("driver cannot promote self to admin", r == "permission-denied", r)

    # ------------------------------------------------------------------ Company B isolation
    ctxB = br.new_context(viewport={"width": 1280, "height": 860})
    B = ctxB.new_page(); watch(B, "adminB")
    register(B, "Bravo Buses", "bob@bravo.test", "Passw0rd!", "Bob")
    check("company B starts with no routes", B.evaluate("document.querySelectorAll('#adminRouteList .arow').length") == 0 and "No routes yet" in B.inner_text("#adminRouteList"))
    shot(B, "13-company-b-admin-empty.png")
    B.click("#adminToDriver"); wait_view(B, "driver"); B.wait_for_timeout(1000)
    B.evaluate("document.getElementById('menuBtn').click()"); B.wait_for_timeout(500)
    btxt = B.inner_text("body")
    check("company B driver view shows none of company A's routes", all(x not in btxt for x in ["Gorseinon", "360 (AM)", "Big recorded"]) and B.is_visible("#emptyState"), btxt[:200])
    shot(B, "14-company-b-driver-empty.png")
    r = B.evaluate(f"""window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','routes')).then(s=>'READ '+s.size).catch(e=>e.code)""")
    check("company B cannot list company A's routes (permission-denied)", r == "permission-denied", r)
    r = B.evaluate(f"""window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid}')).then(d=>'READ '+d.exists()).catch(e=>e.code)""")
    check("company B cannot read a specific A route (permission-denied)", r == "permission-denied", r)
    r = B.evaluate(f"""window.__mc.getDoc(window.__mc.doc(window.__mc.db,'users','{uid_a}')).then(d=>'READ').catch(e=>e.code)""")
    check("company B cannot read A's user profiles", r == "permission-denied", r)
    r = B.evaluate(f"""window.__mc.setDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','evil'),{{name:'evil'}}).then(()=>'WRITTEN').catch(e=>e.code)""")
    check("company B cannot write into A's routes", r == "permission-denied", r)
    r = B.evaluate(f"""window.__mc.getDocs(window.__mc.query(window.__mc.collection(window.__mc.db,'users'),window.__mc.where('companyId','==','{cid_a}'))).then(s=>'READ '+s.size).catch(e=>e.code)""")
    check("company B cannot list A's team", r == "permission-denied", r)
    # B adds own route; A's admin list unaffected
    B.evaluate("document.getElementById('drawerClose').click()")
    B.evaluate("document.getElementById('acctAdmin').click()") if False else None
    B.evaluate("document.getElementById('menuBtn').click()"); B.click("#acctAdmin"); wait_view(B, "admin")
    B.click("#newRouteBtn"); wait_view(B, "editor")
    B.fill("#ed_name", "Bravo Route 1"); B.set_input_files("#ed_gpx", str(GPX))
    B.wait_for_function("document.querySelectorAll('#stopList .rowitem').length === 4")
    B.click("#edSave"); wait_view(B, "admin")
    B.wait_for_function("document.querySelectorAll('#adminRouteList .arow').length === 1")
    A.wait_for_timeout(1200)
    check("A's route list unaffected by B (still 40, no 'Bravo')", A.evaluate("document.querySelectorAll('#adminRouteList .arow').length") == 40 and "Bravo" not in A.inner_text("#adminRouteList"))
    # B logs out and back in
    B.evaluate("document.getElementById('adminSignOut').click()"); wait_view(B, "auth", 20000)
    login(B, "bob@bravo.test", "Passw0rd!"); wait_view(B, "admin")
    check("sign out -> sign in again works (company B admin)", B.inner_text("#adminCompany") == "Bravo Buses")

    # ====================================================================================================
    # NEW: Next-stop display, 50 m boarding by stop, Finish & submit run, admin Runs tab, isolation
    # ====================================================================================================
    import csv as _csv, io as _io, datetime as _dt
    def hav(a, b):
        R = 6371000; dl = math.radians(b[0]-a[0]); dn = math.radians(b[1]-a[1])
        s = math.sin(dl/2)**2 + math.cos(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.sin(dn/2)**2
        return 2*R*math.asin(min(1, math.sqrt(s)))
    def off_n(pt, north_m=0, east_m=0):
        return (pt[0] + north_m/111320.0, pt[1] + east_m/(111320.0*math.cos(math.radians(pt[0]))))
    def gps(pt):
        ctxD.set_geolocation({"latitude": pt[0], "longitude": pt[1], "accuracy": 5})
    def card(page=None):
        return (page or D).inner_text("#nextStop").replace("\n", " | ")
    def pax_ls():
        return D.evaluate(f"JSON.parse(localStorage.getItem('rt_pax_{rid}')||'null')")
    def card_has(txt, to=10000):
        D.wait_for_function("t => document.getElementById('nextStop').innerText.includes(t)", arg=txt, timeout=to)


    # ---- a dedicated route for the run tests: 4 stops in track order, stop 4 has a generic name (timetable supplies the best name)
    A.click("#admTabRoutes"); A.click("#newRouteBtn"); wait_view(A, "editor")
    A.fill("#ed_name", "Run Test Route (AM)"); A.select_option("#ed_category", "school"); A.select_option("#ed_session", "AM")
    A.set_input_files("#ed_gpx", str(GPX))
    A.wait_for_function("document.querySelectorAll('#stopList .rowitem').length === 4")
    A.fill("#stopList .rowitem:nth-child(4) .stop-name", "Stop 4")
    A.click("#ttFillMorning")
    for i, t in enumerate(["07:40", "07:52", "08:05", "08:20"]):
        A.fill(f"#ttMorning .rowitem:nth-child({i+1}) .tt-time", t)
    A.fill("#ttMorning .rowitem:nth-child(4) .tt-stop", "Penyrheol Comprehensive School")
    A.click("#edSave"); wait_view(A, "admin")
    A.wait_for_function("[...document.querySelectorAll('#adminRouteList .arow')].some(e=>e.innerText.includes('Run Test Route'))")
    rid2 = A.evaluate("[...document.querySelectorAll('#adminRouteList .arow')].find(e=>e.innerText.includes('Run Test Route')).dataset.routeId")
    RN = "Run Test Route (AM)"
    # driver switches to it (leave Sat-Nav first, pick from the drawer)
    if "satnav-mode" in D.evaluate("document.body.className"):
        D.click("#fsExit"); D.wait_for_function("!document.body.classList.contains('satnav-mode')")
    D.click("#menuBtn"); D.wait_for_timeout(300)
    D.click(".rt-tab:has-text('Schools AM')"); D.wait_for_timeout(200)
    D.click("#routeList .route-card:has-text('Run Test Route') .chip-btn.use")
    D.wait_for_function("document.getElementById('routeName').textContent === 'Run Test Route (AM)'", timeout=15000)
    rid = rid2

    route_doc = A.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid}')).then(d=>d.data())")
    S = [(s["lat"], s["lng"]) for s in route_doc["stops"]]
    SN = [s["name"] for s in route_doc["stops"]]
    TRK = A.evaluate("async enc => (await import('/js/geo.js')).decodePolyline(enc)", route_doc["trackEnc"])
    def nearest_idx(pt): return min(range(len(TRK)), key=lambda i: hav(pt, TRK[i]))
    sti = [nearest_idx(p) for p in S[:3]]
    print("   info: stops", SN, "nearest track idx of stops 1-3:", sti, "of", len(TRK))
    check("e2e setup: stops 1-3 lie along the track in order", sti[0] < sti[1] < sti[2], sti)
    min_gap = min(hav(S[i], S[j]) for i in range(4) for j in range(i+1, 4))
    check("e2e setup: stops are far enough apart for the 50 m tests", min_gap > 500, min_gap)

    D.click("#satnavBtn"); D.wait_for_timeout(2500)
    check("Sat-Nav running on the run-test route", "satnav-mode" in D.evaluate("document.body.className"))
    check("run test starts with no stored counts for this route", (pax_ls() or {}).get("stopsOn", {}) == {} )

    # ---- 1. Next stop display, live as the driver progresses along the track
    mid12 = TRK[(sti[0] + sti[1]) // 2]; mid23 = TRK[(sti[1] + sti[2]) // 2]
    check("e2e setup: mid-points are >50 m from every stop", all(hav(m, s) > 50 for m in (mid12, mid23) for s in S), [round(hav(mid12, s)) for s in S])
    gps(mid12); card_has("NEXT STOP 2 OF 4")
    c = card()
    exp_d = hav(mid12, S[1])
    m = re.search(r"([\d.]+)\s*(m|km)\b", c)
    shown_m = float(m.group(1)) * (1000 if m.group(2) == "km" else 1) if m else -1
    check("Next stop card: number, name, distance and scheduled time (stop 2 of 4, 07:52)",
          "Pontarddulais Road" in c and "NEXT STOP 2 OF 4" in c and abs(shown_m - exp_d) <= max(60, exp_d * 0.06) and "07:52" in c, (c, round(exp_d)))
    check("Next stop card number badge shows 2", D.inner_text("#nsNum") == "2")
    shot(D, "16-driver-satnav-next-stop.png")
    gps(mid23); card_has("NEXT STOP 3 OF 4")
    c = card()
    check("Next stop updates live as the driver progresses (stop 3, 08:05)", "Gorseinon Square" in c and "08:05" in c, c)
    check("Existing Sat-Nav top bar intact next to Next stop (turn instruction, clock, speed, limit)",
          D.evaluate("""['satnavArrow','satnavDist','satnavInstr','snClock','snSpeed','snLimit'].every(i => !!document.getElementById(i)) &&
                        getComputedStyle(document.getElementById('satnavTop')).display !== 'none'"""))

    # ---- 2. Boarding by stop, 50 m radius
    gps(off_n(S[0], 20, 0)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('At Stop 1')", timeout=10000)
    check("within 50 m (20 m): context says 'At Stop 1 — taps log to this stop'", "At Stop 1 — taps log to this stop" in D.inner_text("#paxContext"), D.inner_text("#paxContext"))
    card_has("AT STOP 1 OF 4")
    check("Next stop card switches to 'AT STOP 1' while within 50 m", "Clydach (Post Office)" in card() and "07:40" in card(), card())
    for _ in range(3): D.click("#fsPaxOn")
    D.click("#fsPaxOff")
    shot(D, "17-driver-at-stop-board.png")
    gps(off_n(S[0], 0, 120)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('Between stops')", timeout=10000)
    check("outside 50 m (120 m): context says taps log as unscheduled", "unscheduled" in D.inner_text("#paxContext"), D.inner_text("#paxContext"))
    D.click("#fsPaxOn")                                                     # unscheduled #1
    gps(off_n(S[1], 45, 0)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('At Stop 2')", timeout=10000)
    check("45 m from a stop still counts as at the stop", "At Stop 2 — taps log to this stop" in D.inner_text("#paxContext"), D.inner_text("#paxContext"))
    D.click("#fsPaxOn"); D.click("#fsPaxOn")
    gps(off_n(S[1], 60, 0)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('Between stops')", timeout=10000)
    check("60 m from a stop is NOT at the stop (50 m radius)", "unscheduled" in D.inner_text("#paxContext"), D.inner_text("#paxContext"))
    D.click("#fsPaxOn")                                                     # unscheduled #2
    gps(off_n(S[2], 5, 0)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('At Stop 3')", timeout=10000)
    D.click("#fsPaxOn"); D.click("#fsPaxOff")
    st = pax_ls()
    check("localStorage run state has per-stop counts (stop1 3/1, stop2 2/0, stop3 1/1, unscheduled 2/0)",
          st["stopsOn"] == {"0": 3, "1": 2, "2": 1} and st["stopsOff"] == {"0": 1, "2": 1} and st["adhocOn"] == 2 and st["adhocOff"] == 0 and st["startedAt"], st)
    check("Finish button visible in Sat-Nav view", D.is_visible("#snFinishBtn"))

    # ---- 3. A refresh doesn't lose the counts
    D.reload(); wait_view(D, "driver")
    D.wait_for_function("document.getElementById('routeName').textContent === 'Run Test Route (AM)'", timeout=15000)
    st2 = pax_ls()
    check("after a page refresh the per-stop counts are still there", st2 == st, st2)

    # ---- 4. Finish & submit: confirm summary, cancel keeps data, submit writes the run
    check("'Finish & submit run' button visible in driver view when a route is active", D.is_visible("#finishRunBtn"))
    D.click("#finishRunBtn"); D.wait_for_selector("#runModal", state="visible")
    mt = D.inner_text("#runModal")
    check("confirm summary shows route name, per-stop boarded/alighted, unscheduled and total boarded",
          "Run Test Route (AM)" in mt and re.search(r"1\. Clydach \(Post Office\)\s+3\s+1", mt) and re.search(r"2\. Pontarddulais Road\s+2\s+0", mt)
          and re.search(r"3\. Gorseinon Square\s+1\s+1", mt) and re.search(r"4\. Penyrheol Comprehensive School\s+0\s+0", mt)
          and re.search(r"Unscheduled[^\n]*\s+2\s+0", mt) and re.search(r"Total\s+8\s+2", mt), mt)
    shot(D, "18-driver-finish-confirm.png")
    D.click("#runCancel")
    check("Cancel closes the dialog and keeps the counts; nothing written",
          not D.is_visible("#runModal") and pax_ls() == st and
          A.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>s.size)") == 0)
    D.click("#finishRunBtn"); D.click("#runSubmit")
    D.wait_for_function("document.getElementById('runMsg').textContent.includes('Run submitted')", timeout=20000)
    shot(D, "19-driver-run-submitted.png")
    D.click("#runSubmit")      # "Done"
    runs_a = A.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>s.docs.map(d=>({{id:d.id, ...d.data(), submittedAt:d.data().submittedAt.toMillis(), startedAt:d.data().startedAt.toMillis()}})))")
    check("exactly one run document written at companies/{cid}/runs/{autoId}", len(runs_a) == 1 and len(runs_a[0]["id"]) == 20, [r["id"] for r in runs_a])
    R1 = runs_a[0]
    check("run doc has exactly the specified keys",
          sorted(k for k in R1 if k != "id") == sorted(["routeId","routeName","session","driverUid","driverName","startedAt","submittedAt","totalBoarded","totalAlighted","unscheduledBoarded","unscheduledAlighted","stops"]), sorted(R1.keys()))
    uid_d = D.evaluate("window.__mc.auth.currentUser.uid")
    check("run doc: routeId/routeName/session/driverUid/driverName (from users/{uid}.name)",
          R1["routeId"] == rid and R1["routeName"] == "Run Test Route (AM)" and R1["session"] == "AM" and R1["driverUid"] == uid_d and R1["driverName"] == "Dave Driver", R1)
    check("run doc: totals + unscheduled", (R1["totalBoarded"], R1["totalAlighted"], R1["unscheduledBoarded"], R1["unscheduledAlighted"]) == (8, 2, 2, 0), R1)
    check("run doc: per-stop {index,name,boarded,alighted}",
          R1["stops"] == [{"index":0,"name":"Clydach (Post Office)","boarded":3,"alighted":1}, {"index":1,"name":"Pontarddulais Road","boarded":2,"alighted":0},
                          {"index":2,"name":"Gorseinon Square","boarded":1,"alighted":1}, {"index":3,"name":"Penyrheol Comprehensive School","boarded":0,"alighted":0}], R1["stops"])
    check("run doc: startedAt <= submittedAt, submittedAt is recent (server time)", 0 < R1["startedAt"] <= R1["submittedAt"] and abs(R1["submittedAt"] - time.time()*1000) < 120000, (R1["startedAt"], R1["submittedAt"]))
    stl = pax_ls()
    check("after submit the run counts for that route are reset (localStorage)", (stl or {}).get("stopsOn") == {} and stl["adhocOn"] == 0 and D.inner_text("#paxCountMap") == "0", stl)
    check("no pending runs left on the phone", D.evaluate("JSON.parse(localStorage.getItem('rt_pending_runs')||'[]').length") == 0)
    # driver: write-once + isolation
    r = D.evaluate(f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{R1['id']}'),{{totalBoarded:999}}).then(()=>'UPDATED').catch(e=>e.code)")
    check("driver cannot update a run (permission-denied)", r == "permission-denied", r)
    r = D.evaluate(f"window.__mc.deleteDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{R1['id']}')).then(()=>'DELETED').catch(e=>e.code)")
    check("driver cannot delete a run (permission-denied)", r == "permission-denied", r)
    r = D.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>'READ '+s.size).catch(e=>e.code)")
    check("driver cannot list all runs (permission-denied)", r == "permission-denied", r)
    r = D.evaluate(f"window.__mc.getDocs(window.__mc.query(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs'),window.__mc.where('driverUid','==','{uid_d}'))).then(s=>'READ '+s.size).catch(e=>e.code)")
    check("driver can read their own runs", r == "READ 1", r)
    r = D.evaluate(f"window.__mc.setDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','forged'),{{routeId:'x',routeName:'x',session:'AM',driverUid:'someone-else',driverName:'x',startedAt:new Date(),submittedAt:new Date(),totalBoarded:1,totalAlighted:0,unscheduledBoarded:0,unscheduledAlighted:0,stops:[]}}).then(()=>'WRITTEN').catch(e=>e.code)")
    check("driver cannot forge a run for another uid / with client timestamp", r == "permission-denied", r)

    # ---- 5. Second run submitted while OFFLINE -> kept locally with Retry, then uploaded
    ctxD.set_offline(True); D.wait_for_function("navigator.onLine === false")
    D.click("[data-pax=on]"); D.click("[data-pax=on]"); D.click("[data-pax=off]")
    D.click("#finishRunBtn"); D.click("#runSubmit")
    D.wait_for_function("document.getElementById('runMsg').className.includes('err')", timeout=20000)
    check("offline submit: error shown with Retry button", "offline" in D.inner_text("#runMsg") and D.inner_text("#runSubmit") == "Retry", D.inner_text("#runMsg"))
    shot(D, "20-driver-run-offline-retry.png")
    D.click("#runCancel")
    check("offline submit: run kept locally (pending list + banner) and counts not reset",
          D.evaluate("JSON.parse(localStorage.getItem('rt_pending_runs')||'[]').length") == 1 and D.is_visible("#runPending") and D.inner_text("#paxCountMap") == "1")
    ctxD.set_offline(False); D.wait_for_function("navigator.onLine === true")
    D.click("#runPendingRetry"); D.wait_for_selector("#runModal", state="visible")
    D.click("#runSubmit")
    D.wait_for_function("document.getElementById('runMsg').textContent.includes('Run submitted')", timeout=30000)
    D.click("#runSubmit")
    check("retry after reconnect uploads the run and clears the pending copy",
          D.evaluate("JSON.parse(localStorage.getItem('rt_pending_runs')||'[]').length") == 0 and not D.is_visible("#runPending") and D.inner_text("#paxCountMap") == "0")
    runs_a = A.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>s.docs.map(d=>({{id:d.id, ...d.data(), submittedAt:d.data().submittedAt.toMillis()}})))")
    runs_a.sort(key=lambda r: r["submittedAt"])
    check("exactly 2 runs now (no duplicate from the retry); 2nd run: unscheduled 2 boarded / 1 alighted",
          len(runs_a) == 2 and runs_a[1]["unscheduledBoarded"] == 2 and runs_a[1]["unscheduledAlighted"] == 1 and runs_a[1]["totalBoarded"] == 2
          and all(s["boarded"] == 0 and s["alighted"] == 0 for s in runs_a[1]["stops"]), runs_a[1] if len(runs_a) > 1 else runs_a)
    R2 = runs_a[1]

    # ---- 6. Stop-name fallback ('Stop N', no invented times) on a route whose stops have no names
    D.click("#menuBtn"); D.wait_for_timeout(300)
    D.click(".rt-tab:has-text('Schools AM')"); D.wait_for_timeout(200)
    D.click("#routeList .route-card:has-text('995 (AM)') .chip-btn.use")
    D.wait_for_function("document.getElementById('routeName').textContent === '995 (AM)'")
    r995 = A.evaluate("window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','%s','routes','route-995-am')).then(d=>d.data())" % cid_a)
    gps((r995["stops"][0]["lat"], r995["stops"][0]["lng"]))
    D.click("#satnavBtn"); D.wait_for_function("document.getElementById('nextStop').innerText.includes('OF')", timeout=15000)
    cf = card()
    check("stop with no name falls back to 'Stop N' and shows no invented time", re.search(r"\| Stop \d+ \|", cf) and "Due" not in cf, cf)
    D.click("#fsExit")        # end Sat-Nav
    D.wait_for_function("!document.body.classList.contains('satnav-mode')")

    # ---- 7. Admin 'Runs' tab
    A.click("#admTabRuns")
    A.wait_for_function("document.querySelectorAll('#runList .run-card').length === 2", timeout=15000)
    shot(A, "21-admin-runs-list.png")
    t0 = A.eval_on_selector_all("#runList .run-card:nth-child(2) .run-head > div", "els=>els.map(e=>e.innerText.replace(/^[A-Z /]+\\n/,''))")
    t1 = A.eval_on_selector_all("#runList .run-card:nth-child(3) .run-head > div", "els=>els.map(e=>e.innerText.replace(/^[A-Z /]+\\n/,''))")
    check("Runs tab: newest first (row 1 = 2nd run: 2 boarded / 1 alighted; row 2 = 1st run: 8 / 2)",
          t0[4] == "2" and t0[5] == "1" and t1[4] == "8" and t1[5] == "2" and t0[1] == "Dave Driver" and t1[2] == "Run Test Route (AM)" and t1[3] == "AM", (t0, t1))
    first_date = t1[0]
    check("Runs tab: date/time column is filled", re.search(r"\d{2} \w{3} \d{4} \d{2}:\d{2}", first_date), first_date)
    check("Runs tab: totals summary (10 boarded, 2 runs)", re.search(r"10\s+passengers boarded\s*·\s*2\s+runs", A.inner_text("#runSummary")), A.inner_text("#runSummary"))
    # expand per-stop breakdown
    A.click("#runList .run-card:nth-child(3) .run-head")
    A.wait_for_selector("#runList .run-detail")
    det = A.inner_text("#runList .run-detail")
    check("expanded run: per-stop table (stop, boarded, alighted) + unscheduled + total",
          re.search(r"1\. Clydach \(Post Office\)\s+3\s+1", det) and re.search(r"2\. Pontarddulais Road\s+2\s+0", det) and re.search(r"3\. Gorseinon Square\s+1\s+1", det)
          and re.search(r"4\. Penyrheol Comprehensive School\s+0\s+0", det) and re.search(r"Unscheduled[^\n]*\s+2\s+0", det) and re.search(r"Total\s+8\s+2", det), det)
    shot(A, "22-admin-runs-expanded.png")
    A.click("#runList .run-card:nth-child(3) .run-head"); A.wait_for_function("document.querySelectorAll('#runList .run-detail').length === 0")
    # filters
    opts_r = A.eval_on_selector_all("#runFltRoute option", "els=>els.map(e=>e.textContent)")
    opts_d = A.eval_on_selector_all("#runFltDriver option", "els=>els.map(e=>e.textContent)")
    check("filter dropdowns list the routes and drivers that have runs", opts_r == ["All routes", "Run Test Route (AM)"] and opts_d == ["All drivers", "Dave Driver"], (opts_r, opts_d))
    A.select_option("#runFltRoute", rid); n1 = A.evaluate("document.querySelectorAll('#runList .run-card').length")
    A.select_option("#runFltRoute", ""); A.select_option("#runFltDriver", uid_d); n2 = A.evaluate("document.querySelectorAll('#runList .run-card').length")
    check("filter by route and by driver keep both runs", n1 == 2 and n2 == 2, (n1, n2))
    A.select_option("#runFltDriver", "")
    today = _dt.date.today(); tomorrow = today + _dt.timedelta(days=1); yesterday = today - _dt.timedelta(days=1)
    A.fill("#runFltFrom", tomorrow.isoformat())
    check("date filter: From tomorrow -> no runs", A.evaluate("document.querySelectorAll('#runList .run-card').length") == 0 and "No runs match" in A.inner_text("#runList") and "0" in A.inner_text("#runSummary"), A.inner_text("#runSummary"))
    shot(A, "23-admin-runs-filtered-none.png")
    A.fill("#runFltFrom", yesterday.isoformat()); A.fill("#runFltTo", today.isoformat())
    check("date filter: yesterday..today -> both runs; summary updates", A.evaluate("document.querySelectorAll('#runList .run-card').length") == 2 and re.search(r"10\s+passengers boarded", A.inner_text("#runSummary")))
    A.fill("#runFltTo", yesterday.isoformat())
    check("date filter: To yesterday -> no runs", A.evaluate("document.querySelectorAll('#runList .run-card').length") == 0)
    A.click("#runFltClear")
    check("Clear filters restores the full list", A.evaluate("document.querySelectorAll('#runList .run-card').length") == 2)
    # CSV
    with A.expect_download() as dl:
        A.click("#runCsvBtn")
    csv_path = dl.value.path()
    txt = Path(csv_path).read_text(encoding="utf-8-sig")
    rows_csv = list(_csv.reader(_io.StringIO(txt)))
    hdr, body = rows_csv[0], rows_csv[1:]
    check("CSV: header + one row per stop per run (+ 'Unscheduled' row): 2 runs x (4 stops + 1) = 10 rows",
          hdr[:2] == ["Run ID", "Submitted"] and "Stop name" in hdr and len(body) == 10, (hdr, len(body)))
    i_run, i_n, i_nm, i_b, i_a, i_drv = hdr.index("Run ID"), hdr.index("Stop number"), hdr.index("Stop name"), hdr.index("Boarded"), hdr.index("Alighted"), hdr.index("Driver")
    got = {(r[i_run], r[i_n]): (r[i_nm], r[i_b], r[i_a], r[i_drv]) for r in body}
    check("CSV: per-stop numbers and driver name correct",
          got[(R1["id"], "1")] == ("Clydach (Post Office)", "3", "1", "Dave Driver") and got[(R1["id"], "2")] == ("Pontarddulais Road", "2", "0", "Dave Driver")
          and got[(R1["id"], "3")] == ("Gorseinon Square", "1", "1", "Dave Driver") and got[(R1["id"], "4")] == ("Penyrheol Comprehensive School", "0", "0", "Dave Driver") and got[(R1["id"], "")] == ("Unscheduled", "2", "0", "Dave Driver")
          and got[(R2["id"], "")] == ("Unscheduled", "2", "1", "Dave Driver"), got)
    Path("/tmp/runs-export.csv").write_text(txt, encoding="utf-8")
    # CSV respects filters
    A.fill("#runFltTo", yesterday.isoformat()); 
    check("Download CSV is disabled when the filtered set is empty", A.is_disabled("#runCsvBtn"))
    A.click("#runFltClear")
    # delete a run
    A.click("#runList .run-card:nth-child(2) .run-head"); A.click("#runList .run-card:nth-child(2) [data-act=del]")
    A.wait_for_function("document.querySelectorAll('#runList .run-card').length === 1", timeout=10000)
    left = A.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>s.docs.map(d=>d.id))")
    check("admin can delete a run (gone from list and from Firestore; summary updates)", left == [R1["id"]] and re.search(r"8\s+passengers boarded\s*·\s*1\s+run\b", A.inner_text("#runSummary")), (left, A.inner_text("#runSummary")))
    shot(A, "24-admin-runs-after-delete.png")
    r = A.evaluate(f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{R1['id']}'),{{totalBoarded:1}}).then(()=>'UPDATED').catch(e=>e.code)")
    check("even an admin cannot update a run (write-once)", r == "permission-denied", r)

    # ---- 8. Another company cannot see it
    B.click("#admTabRuns"); B.wait_for_timeout(800)
    check("company B's Runs tab shows no runs (A's run is not visible)", B.evaluate("document.querySelectorAll('#runList .run-card').length") == 0 and "No runs yet" in B.inner_text("#runSummary") and "Dave" not in B.inner_text("#admRuns"), B.inner_text("#admRuns")[:200])
    shot(B, "25-company-b-runs-empty.png")
    r = B.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>'READ '+s.size).catch(e=>e.code)")
    check("company B admin cannot list A's runs (permission-denied)", r == "permission-denied", r)
    r = B.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{R1['id']}')).then(d=>'READ '+d.exists()).catch(e=>e.code)")
    check("company B admin cannot read a specific A run (permission-denied)", r == "permission-denied", r)
    r = B.evaluate(f"window.__mc.deleteDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{R1['id']}')).then(()=>'DELETED').catch(e=>e.code)")
    check("company B admin cannot delete A's run (permission-denied)", r == "permission-denied", r)
    uid_b = B.evaluate("window.__mc.auth.currentUser.uid")
    r = B.evaluate(f"window.__mc.setDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','bx'),{{routeId:'x',routeName:'x',session:'AM',driverUid:'{uid_b}',driverName:'x',startedAt:new Date(),submittedAt:window.__mc.serverTimestamp(),totalBoarded:1,totalAlighted:0,unscheduledBoarded:0,unscheduledAlighted:0,stops:[]}}).then(()=>'WRITTEN').catch(e=>e.code)")
    check("company B cannot write a run into A (permission-denied)", r == "permission-denied", r)

    # ====================================================================================================
    # BUG FIX: Schedule-tab "Onboard change" taps and map Board/Alight taps feed ONE per-stop store and the submitted run
    # ====================================================================================================
    def pick_route(name, tab="#tabSchedBtn"):
        if "satnav-mode" in D.evaluate("document.body.className"):
            D.click("#fsExit"); D.wait_for_function("!document.body.classList.contains('satnav-mode')")
        D.click("#menuBtn"); D.wait_for_timeout(300)
        D.click(".rt-tab:has-text('Schools AM')"); D.wait_for_timeout(200)
        D.click(f"#routeList .route-card:has-text('{name}') .chip-btn.use")
        D.wait_for_function("n => document.getElementById('routeName').textContent === n", arg=name, timeout=15000)
        D.click(tab); D.wait_for_timeout(400)
    def sbtn(key, d): return f"#schedBody button[data-stopkey='{key}'][data-dir='{d}']"
    def sn(key): return D.inner_text(f"#schedBody .n[data-stop-idx='{key}']").strip()
    def sdet(key): return D.inner_text(f"#schedBody .n[data-stop-idx='{key}'] ~ .sched-pax-detail").strip()
    def run_ids(page):
        return set(page.evaluate(f"window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies','{cid_a}','runs')).then(s=>s.docs.map(d=>d.id))"))
    def run_doc(page, i):
        return page.evaluate(f"window.__mc.getDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','runs','{i}')).then(d=>d.data())")
    def stops_tuple(run): return [(x["index"], x["boarded"], x["alighted"]) for x in run["stops"]]
    def finish_modal():
        D.click("#tabMapBtn") if D.is_visible("#tabMapBtn") else None
        D.click("#finishRunBtn"); D.wait_for_selector("#runModal", state="visible"); return D.inner_text("#runModal")
    def submit_modal():
        D.click("#runSubmit"); D.wait_for_function("document.getElementById('runMsg').textContent.includes('Run submitted')", timeout=20000)
        D.click("#runSubmit")      # "Done"
    def admin_run_detail(run_id):
        A.click("#admTabRuns"); A.wait_for_selector(f"#runList .run-card[data-run-id='{run_id}']", timeout=15000)
        A.click(f"#runList .run-card[data-run-id='{run_id}'] .run-head")
        A.wait_for_selector(f"#runList .run-card[data-run-id='{run_id}'] .run-detail")
        return A.inner_text(f"#runList .run-card[data-run-id='{run_id}']")

    known = run_ids(A)
    pick_route("Run Test Route (AM)")
    check("schedule/run bug fix: precondition - no counts stored for the route", not (pax_ls() or {}).get("stopsOn") and sn("MORNING-0") == "0")

    # ---- (a) Schedule-tab taps ONLY -> submitted run contains them
    for _ in range(2): D.click(sbtn("MORNING-0", 1))       # stop 1: 2 on
    D.click(sbtn("MORNING-2", 1))                           # stop 3: 1 on
    D.click(sbtn("MORNING-1", -1))                          # stop 2: 1 off
    st = pax_ls()
    check("Schedule taps are stored in the per-stop store keyed by stop index (stopsOn {0:2,2:1}, stopsOff {1:1}; started)",
          st["stopsOn"] == {"0": 2, "2": 1} and st["stopsOff"] == {"1": 1} and st["adhocOn"] == 0 and st["adhocOff"] == 0 and st["startedAt"], st)
    check("Schedule rows show the net per stop (+2 / -1 / +1 / 0) and on/off detail",
          [sn(f"MORNING-{i}") for i in range(4)] == ["2", "-1", "1", "0"] and sdet("MORNING-0") == "on 2 · off 0" and sdet("MORNING-1") == "on 0 · off 1", [sn(f"MORNING-{i}") for i in range(4)])
    shot(D, "38-driver-schedule-onboard-change-taps.png")
    mt = finish_modal()
    check("confirm dialog shows the Schedule-tab taps (stop1 2/0, stop2 0/1, stop3 1/0, total 3/1) and NO 'not part of' note",
          re.search(r"1\. Clydach \(Post Office\)\s+2\s+0", mt) and re.search(r"2\. Pontarddulais Road\s+0\s+1", mt) and re.search(r"3\. Gorseinon Square\s+1\s+0", mt)
          and re.search(r"4\. Penyrheol Comprehensive School\s+0\s+0", mt) and re.search(r"Unscheduled[^\n]*\s+0\s+0", mt) and re.search(r"Total\s+3\s+1", mt)
          and "not part" not in mt and "Schedule-tab" not in mt, mt)
    shot(D, "39-driver-finish-confirm-schedule-taps.png")
    submit_modal()
    new = run_ids(A) - known; known |= new
    check("exactly one new run written", len(new) == 1, new)
    RS = run_doc(A, next(iter(new)))
    check("submitted run (Schedule taps only): per-stop boarded/alighted and totals include them",
          stops_tuple(RS) == [(0, 2, 0), (1, 0, 1), (2, 1, 0), (3, 0, 0)] and (RS["totalBoarded"], RS["totalAlighted"], RS["unscheduledBoarded"], RS["unscheduledAlighted"]) == (3, 1, 0, 0), RS["stops"])
    stl = pax_ls()
    D.click("#tabSchedBtn"); D.wait_for_timeout(300)
    check("after submit both sources are cleared: store empty, Schedule rows 0, map counter 0",
          (stl or {}).get("stopsOn") == {} and (stl or {}).get("stopsOff") == {} and stl["adhocOn"] == 0 and [sn(f"MORNING-{i}") for i in range(4)] == ["0"] * 4 and sdet("MORNING-0") == "on 0 · off 0" and D.inner_text("#paxCountMap") == "0", stl)
    det = admin_run_detail(next(iter(new)))
    check("admin Runs tab shows the Schedule-tab passengers (per-stop table + totals 3 / 1)",
          re.search(r"1\. Clydach \(Post Office\)\s+2\s+0", det) and re.search(r"2\. Pontarddulais Road\s+0\s+1", det) and re.search(r"3\. Gorseinon Square\s+1\s+0", det)
          and re.search(r"Total\s+3\s+1", det), det)
    shot(A, "40-admin-runs-schedule-taps.png")

    # ---- (b) mix of both sources, no double counting
    D.click("#tabMapBtn")
    gps(off_n(S[0], 20, 0))
    D.click("#satnavBtn"); D.wait_for_function("document.getElementById('paxContext').textContent.includes('At Stop 1')", timeout=15000)
    D.click("#fsPaxOn"); D.click("#fsPaxOn"); D.click("#fsPaxOff")                  # map at stop 1: 2 on, 1 off
    gps(off_n(S[0], 0, 120)); D.wait_for_function("document.getElementById('paxContext').textContent.includes('Between stops')", timeout=10000)
    D.click("#fsPaxOn")                                                             # unscheduled: 1 on
    D.click("#fsExit"); D.wait_for_function("!document.body.classList.contains('satnav-mode')")
    D.click("#tabSchedBtn"); D.wait_for_timeout(300)
    check("map taps show on the Schedule rows too (stop 1: net +1, 'on 2 · off 1') - one shared store", sn("MORNING-0") == "1" and sdet("MORNING-0") == "on 2 · off 1", (sn("MORNING-0"), sdet("MORNING-0")))
    D.click(sbtn("MORNING-0", 1))                                                   # schedule: stop 1 +1 -> 3 on / 1 off
    for _ in range(2): D.click(sbtn("MORNING-1", 1))                                # schedule: stop 2: 2 on
    D.click(sbtn("MORNING-2", 1))                                                   # schedule: stop 3: 1 on
    D.click(sbtn("MORNING-3", -1))                                                  # schedule: stop 4: 1 off
    st = pax_ls()
    check("mixed sources: one store, each tap counted once (stop1 3/1, stop2 2/0, stop3 1/0, stop4 0/1, unscheduled 1/0)",
          st["stopsOn"] == {"0": 3, "1": 2, "2": 1} and st["stopsOff"] == {"0": 1, "3": 1} and st["adhocOn"] == 1 and st["adhocOff"] == 0, st)
    D.click("#tabMapBtn")
    check("map 'onboard' counter = boarded - alighted = 7 - 2 = 5 (no double count)", D.inner_text("#paxCountMap") == "5", D.inner_text("#paxCountMap"))
    D.reload(); wait_view(D, "driver"); D.wait_for_function("document.getElementById('routeName').textContent === 'Run Test Route (AM)'", timeout=15000)
    check("mixed counts survive a refresh unchanged", pax_ls() == st, pax_ls())
    mt = finish_modal()
    check("confirm dialog shows the COMBINED figures (3/1, 2/0, 1/0, 0/1, unscheduled 1/0, total 7/2)",
          re.search(r"1\. Clydach \(Post Office\)\s+3\s+1", mt) and re.search(r"2\. Pontarddulais Road\s+2\s+0", mt) and re.search(r"3\. Gorseinon Square\s+1\s+0", mt)
          and re.search(r"4\. Penyrheol Comprehensive School\s+0\s+1", mt) and re.search(r"Unscheduled[^\n]*\s+1\s+0", mt) and re.search(r"Total\s+7\s+2", mt) and "not part" not in mt, mt)
    shot(D, "41-driver-finish-confirm-combined.png")
    submit_modal()
    new = run_ids(A) - known; known |= new
    RM = run_doc(A, next(iter(new)))
    check("submitted run (mixed): per-stop + unscheduled + totals are the combined figures, stops[].index = stop index",
          len(new) == 1 and stops_tuple(RM) == [(0, 3, 1), (1, 2, 0), (2, 1, 0), (3, 0, 1)] and (RM["totalBoarded"], RM["totalAlighted"], RM["unscheduledBoarded"], RM["unscheduledAlighted"]) == (7, 2, 1, 0), RM["stops"])
    stl = pax_ls()
    D.click("#tabSchedBtn"); D.wait_for_timeout(300)
    check("after the mixed submit both sources are cleared (store, Schedule rows, map counter)",
          stl["stopsOn"] == {} and stl["stopsOff"] == {} and stl["adhocOn"] == 0 and [sn(f"MORNING-{i}") for i in range(4)] == ["0"] * 4 and D.inner_text("#paxCountMap") == "0", stl)
    det = admin_run_detail(next(iter(new)))
    check("admin Runs tab shows the mixed run (3/1, 2/0, 1/0, 0/1, unscheduled 1/0, total 7/2)",
          re.search(r"1\. Clydach \(Post Office\)\s+3\s+1", det) and re.search(r"2\. Pontarddulais Road\s+2\s+0", det) and re.search(r"3\. Gorseinon Square\s+1\s+0", det)
          and re.search(r"4\. Penyrheol Comprehensive School\s+0\s+1", det) and re.search(r"Unscheduled[^\n]*\s+1\s+0", det) and re.search(r"Total\s+7\s+2", det), det)
    shot(A, "42-admin-runs-mixed-sources.png")

    # ---- (c) counts saved by the OLD version (byStop keyed 'MORNING-n') are folded in once, not lost
    D.evaluate(f"localStorage.setItem('rt_pax_{rid}', JSON.stringify({{byStop:{{'MORNING-0':2,'MORNING-1':-1,'MORNING-3':3}}, byGpsStop:{{}}, adhoc:0, stopsOn:{{'2':1}}, stopsOff:{{}}, adhocOn:0, adhocOff:0, startedAt:1700000000000}}))")
    D.reload(); wait_view(D, "driver"); D.wait_for_function("document.getElementById('routeName').textContent === 'Run Test Route (AM)'", timeout=15000)
    st = pax_ls()
    check("legacy Schedule counts migrate into the per-stop store (stop1 +2 -> on, stop2 -1 -> off, stop4 +3; existing stop3 kept; legacy keys gone)",
          st["stopsOn"] == {"0": 2, "2": 1, "3": 3} and st["stopsOff"] == {"1": 1} and "byStop" not in st and st["startedAt"] == 1700000000000, st)
    D.evaluate(f"localStorage.removeItem('rt_pax_{rid}')"); D.reload(); wait_view(D, "driver")
    D.wait_for_function("document.getElementById('routeName').textContent === 'Run Test Route (AM)'", timeout=15000)

    # ---- (d) a timetable row that matches no stop is counted as unscheduled (and shows its own count)
    um = A.evaluate(f"""async () => {{ const m = window.__mc, ref = m.doc(m.db,'companies','{cid_a}','routes','{rid}');
        const d = (await m.getDoc(ref)).data(); d.name = 'Unmapped Row Route (AM)';
        d.timetable = {{ morning: [{{stop:'Clydach (Post Office)', time:'07:40'}}, {{stop:'Mystery Depot', time:'08:00'}}] }};
        const nref = m.doc(m.db,'companies','{cid_a}','routes','unmapped-test'); await m.setDoc(nref, d); return true; }}""")
    pick_route("Unmapped Row Route (AM)")
    D.click(sbtn("MORNING-1", 1)); D.click(sbtn("MORNING-1", 1)); D.click(sbtn("MORNING-0", 1))
    stu = D.evaluate("JSON.parse(localStorage.getItem('rt_pax_unmapped-test'))")
    check("row matching no stop: counted as unscheduled once (adhocOn 2), shown on its own row; matched row goes to stop 1",
          stu["stopsOn"] == {"0": 1} and stu["adhocOn"] == 2 and sn("MORNING-1") == "2" and sn("MORNING-0") == "1", stu)
    mt = finish_modal()
    check("confirm dialog: unscheduled 2/0, stop 1 1/0, total 3/0 for that route", re.search(r"1\. Clydach \(Post Office\)\s+1\s+0", mt) and re.search(r"Unscheduled[^\n]*\s+2\s+0", mt) and re.search(r"Total\s+3\s+0", mt), mt)
    D.click("#runCancel")
    D.evaluate("localStorage.removeItem('rt_pax_unmapped-test')")
    pick_route("Run Test Route (AM)")
    A.evaluate(f"window.__mc.deleteDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','unmapped-test'))")
    A.click("#admTabRoutes"); A.wait_for_function("document.querySelectorAll('#adminRouteList .arow').length === 41", timeout=15000)
    check("temporary test route removed again (41 routes)", True)
    D.click("#tabMapBtn")

    # ====================================================================================================
    # NEW: Operator details (company default -> routes), apply-to-all, driver fallback, isolation, rules
    # ====================================================================================================
    OP1 = {"name": "Alpha Travel Group Ltd", "address": "12 Quay Parade, Swansea, SA1 3XY",
           "tel": "01792 555 000 (office) / 07700 900 123", "email": "operations@alpha-travel.test"}
    OP2 = dict(OP1, tel="01792 777 777", address="3 New Street, Cardiff, CF10 1AA")
    def fs_get(page, path):
        return page.evaluate("p => window.__mc.getDoc(window.__mc.doc(window.__mc.db, ...p.split('/'))).then(d=>d.exists()?d.data():null)", path)
    def routes_of(page, cid):
        return page.evaluate("""cid => window.__mc.getDocs(window.__mc.collection(window.__mc.db,'companies',cid,'routes')).then(
            s => Object.fromEntries(s.docs.map(d => { const x = d.data(); return [d.id, {name: x.name, operator: x.operator || null, custom: x.operatorCustom === undefined ? null : x.operatorCustom}]; })))""", cid)
    def op_of(page, path="companies/" + cid_a):
        d = fs_get(page, path); return (d or {}).get("operator")
    def set_op_form(vals):
        for k, i in (("name", "opName"), ("address", "opAddress"), ("tel", "opTel"), ("email", "opEmail")):
            A.fill("#" + i, vals.get(k, ""))
    def op_form():
        return {k: A.input_value("#" + i) for k, i in (("name", "opName"), ("address", "opAddress"), ("tel", "opTel"), ("email", "opEmail"))}
    def editor_op():
        return {k: A.input_value("#ed_op_" + k) for k in ("name", "address", "tel", "email")}
    def d_schedule(route_name):
        """driver (Dave) picks a route from the drawer and opens the Schedule tab; returns the schedule text"""
        D.click("#menuBtn"); D.wait_for_timeout(300)
        D.click(".rt-tab:has-text('Schools AM')"); D.wait_for_timeout(200)
        D.click(f"#routeList .route-card:has-text('{route_name}') .chip-btn.use")
        D.wait_for_function("n => document.getElementById('routeName').textContent === n", arg=route_name, timeout=15000)
        D.click("#tabSchedBtn"); D.wait_for_timeout(500)
        return D.inner_text("#schedBody")
    def add_gpx_route(name, mutate=None):
        A.click("#admTabRoutes"); A.click("#newRouteBtn"); wait_view(A, "editor")
        A.fill("#ed_name", name); A.select_option("#ed_session", "AM")
        A.set_input_files("#ed_gpx", str(GPX))
        A.wait_for_function("document.querySelectorAll('#stopList .rowitem').length === 4")
        if mutate: mutate()

    # ---- 1. the new tab, validation, saving
    A.click("#admTabOperator")
    check("Operator details tab is next to Routes/Drivers/Runs and shows the section",
          A.is_visible("#admOperator") and not A.is_visible("#admRoutes") and [t.strip() for t in A.eval_on_selector_all(".admin-tabs .tab-btn", "e=>e.map(x=>x.textContent)")] == ["Routes", "Operator details", "Drivers", "Runs"])
    check("fresh company: form empty, 'Apply to all routes' disabled until details are saved",
          op_form() == {"name": "", "address": "", "tel": "", "email": ""} and A.is_disabled("#opApplyBtn") and "Save the operator details" in A.inner_text("#opApplyInfo"))
    check("company doc has no operator yet", op_of(A) is None)
    s360 = fs_get(A, f"companies/{cid_a}/routes/seed-360-am"); s995 = fs_get(A, f"companies/{cid_a}/routes/route-995-am")
    check("samples imported BEFORE a company operator exists keep their own operator, marked custom (4 of the 38 samples have none)",
          s360["operator"]["name"].startswith("South Wales Transport") and s360.get("operatorCustom") is True and "operator" not in s995 and s995.get("operatorCustom") is False, (s360.get("operator"), s995.get("operator")))
    shot(A, "26-admin-operator-tab-empty.png")
    A.click("#opSave"); A.wait_for_timeout(300)
    check("save with empty name is refused (message shown, nothing stored)", "operator's name" in A.inner_text("#opMsg") and op_of(A) is None, A.inner_text("#opMsg"))
    A.fill("#opName", "   "); A.fill("#opTel", "01792 555 000"); A.click("#opSave"); A.wait_for_timeout(300)
    check("whitespace-only name is refused too", "operator's name" in A.inner_text("#opMsg") and op_of(A) is None)
    A.fill("#opName", OP1["name"]); A.fill("#opEmail", "not-an-email"); A.click("#opSave"); A.wait_for_timeout(300)
    check("invalid email format is refused (name filled)", "email" in A.inner_text("#opMsg").lower() and op_of(A) is None, A.inner_text("#opMsg"))
    shot(A, "27-admin-operator-validation-error.png")
    set_op_form(OP1); A.click("#opSave")
    A.wait_for_function("document.getElementById('opMsg').textContent.includes('saved')", timeout=10000)
    check("valid details saved to companies/{cid}.operator (free-text phone kept verbatim)", op_of(A) == OP1, op_of(A))
    ai = A.inner_text("#opApplyInfo")
    check("after saving: apply panel is offered with the exact counts (41 routes: 6 without operator to fill, 35 custom kept)",
          "41 routes in total" in ai and "6 would be updated" in ai and "35 custom kept" in ai and not A.is_disabled("#opApplyBtn") and "Apply to all routes (6)" in A.inner_text("#opApplyBtn"), ai)
    A.click("#opModeAll")
    check("'Overwrite all' mode: info says all 41 would be updated, custom no longer 'kept'", "41 would be updated" in A.inner_text("#opApplyInfo") and "custom kept" not in A.inner_text("#opApplyInfo"), A.inner_text("#opApplyInfo"))
    A.click("#opModeFill")
    shot(A, "28-admin-operator-saved-apply-offer.png")
    A.fill("#opEmail", ""); A.click("#opSave"); A.wait_for_function("document.getElementById('opMsg').textContent.includes('saved')")
    check("email is optional (empty email saves)", "email" not in (op_of(A) or {}), op_of(A))
    A.fill("#opEmail", OP1["email"]); A.click("#opSave"); A.wait_for_function("document.getElementById('opMsg').textContent.includes('saved')")
    A.reload(); wait_view(A, "admin"); A.click("#admTabOperator")
    check("operator details survive a page reload (form re-filled from Firestore)", op_form() == OP1, op_form())

    # ---- 2. route editor: new routes pre-filled, indicator, reset, per-route custom, GPX import
    A.click("#admTabRoutes"); A.click("#newRouteBtn"); wait_view(A, "editor")
    check("new route: operator pre-filled from the company operator", editor_op() == OP1, editor_op())
    check("new route: indicator says 'Using company operator details'; reset button hidden",
          A.inner_text("#ed_op_status").strip() == "Using company operator details" and A.get_attribute("#ed_op_status", "data-state") == "company" and not A.is_visible("#ed_op_reset"))
    shot(A, "29-editor-operator-using-company.png")
    A.fill("#ed_op_tel", "01792 999 999")
    check("editing a field flips the indicator to 'Custom for this route' and shows the reset button",
          A.inner_text("#ed_op_status").strip() == "Custom for this route" and A.get_attribute("#ed_op_status", "data-state") == "custom" and A.is_visible("#ed_op_reset"))
    shot(A, "30-editor-operator-custom.png")
    A.click("#ed_op_reset")
    check("reset-to-company-default restores the company details and the 'Using company' indicator",
          editor_op() == OP1 and A.inner_text("#ed_op_status").strip() == "Using company operator details" and not A.is_visible("#ed_op_reset"), editor_op())
    A.fill("#ed_op_tel", "01792 999 999"); A.fill("#ed_op_tel", OP1["tel"])
    check("typing the company value back also returns to 'Using company'", A.inner_text("#ed_op_status").strip() == "Using company operator details")
    A.click("#edBack"); wait_view(A, "admin")

    # custom route (GPX import into the editor, operator edited by hand)
    def make_custom():
        check("GPX import keeps the pre-filled company operator", editor_op() == OP1, editor_op())
        A.fill("#ed_op_name", "Custom Cabs Ltd"); A.fill("#ed_op_tel", "07000 000 000")
    add_gpx_route("Op Custom Route (AM)", make_custom)
    A.click("#edSave"); wait_view(A, "admin")
    A.wait_for_function("[...document.querySelectorAll('#adminRouteList .arow')].some(e=>e.innerText.includes('Op Custom Route'))")
    rc = A.evaluate("[...document.querySelectorAll('#adminRouteList .arow')].find(e=>e.innerText.includes('Op Custom Route')).dataset.routeId")
    dc = fs_get(A, f"companies/{cid_a}/routes/{rc}")
    check("custom route stored with its own operator + operatorCustom=true", dc["operator"]["name"] == "Custom Cabs Ltd" and dc["operator"]["tel"] == "07000 000 000" and dc["operatorCustom"] is True, dc.get("operator"))

    # normal new route: bad email refused in the editor, then reset, saved with the company operator
    def bad_then_reset():
        check("GPX import keeps the pre-filled company operator (second route)", editor_op() == OP1)
        A.fill("#ed_op_email", "bad@"); A.click("#edSave"); A.wait_for_timeout(400)
        check("route editor: invalid operator email blocks the save", "view-editor" in A.evaluate("document.body.className") and "email" in A.inner_text("#toast").lower(), A.inner_text("#toast"))
        A.click("#ed_op_reset")
    add_gpx_route("Op New Route (AM)", bad_then_reset)
    A.click("#edSave"); wait_view(A, "admin")
    A.wait_for_function("[...document.querySelectorAll('#adminRouteList .arow')].some(e=>e.innerText.includes('Op New Route'))")
    rn = A.evaluate("[...document.querySelectorAll('#adminRouteList .arow')].find(e=>e.innerText.includes('Op New Route')).dataset.routeId")
    dn = fs_get(A, f"companies/{cid_a}/routes/{rn}")
    check("new route stored with the company operator, operatorCustom=false", dn["operator"] == OP1 and dn["operatorCustom"] is False, dn.get("operator"))
    pills = A.evaluate("Object.fromEntries([...document.querySelectorAll('#adminRouteList .arow')].map(e=>[e.dataset.routeId, e.querySelector('.op-pill').dataset.op]))")
    check("route list shows Operator: company / custom per route", pills[rn] == "company" and pills[rc] == "custom" and pills["seed-360-am"] == "custom" and pills["route-995-am"] == "company" and pills[rid2] == "company", {k: pills[k] for k in (rn, rc, "seed-360-am", "route-995-am", rid2)})
    shot(A, "31-admin-route-list-operator-pills.png")
    A.click(f"#adminRouteList .arow[data-route-id='{rc}'] [data-act=edit]"); wait_view(A, "editor")
    check("re-opening the custom route: 'Custom for this route', own details kept", A.inner_text("#ed_op_status").strip() == "Custom for this route" and A.input_value("#ed_op_name") == "Custom Cabs Ltd")
    A.click("#edBack"); wait_view(A, "admin")
    A.click(f"#adminRouteList .arow[data-route-id='{rid2}'] [data-act=edit]"); wait_view(A, "editor")
    check("route that has NO operator opens showing the company details ('Using company')", editor_op() == OP1 and A.inner_text("#ed_op_status").strip() == "Using company operator details", editor_op())
    A.click("#edBack"); wait_view(A, "admin")
    check("route list now has 43 routes", A.evaluate("document.querySelectorAll('#adminRouteList .arow').length") == 43)

    # ---- 3. driver: route without operator falls back to the company operator (live, no reload)
    check("precondition: 'Run Test Route (AM)' has NO operator stored in Firestore", fs_get(A, f"companies/{cid_a}/routes/{rid2}").get("operator") is None)
    sched = d_schedule("Run Test Route (AM)")
    check("driver Schedule: a route with no operator shows the COMPANY operator (name, address, tel, email)",
          "OPERATOR" in sched and all(OP1[k] in sched for k in ("name", "address", "tel", "email")), sched[-400:])
    shot(D, "32-driver-schedule-company-operator-fallback.png")
    sched = d_schedule("360 (AM)")
    check("driver Schedule: a custom route still shows its own operator, not the company's", "South Wales Transport" in sched and OP1["name"] not in sched, sched[-300:])
    sched = d_schedule("995 (AM)")
    check("driver Schedule: a sample route that has no operator shows the company operator", OP1["name"] in sched and OP1["email"] in sched, sched[-300:])

    # ---- 4. apply to existing routes: cancel, fill-only, reset one sample route, overwrite all
    A.click("#admTabOperator")
    before = routes_of(A, cid_a)
    DIALOG["cancel"] = True; n0 = len(dialog_msgs)
    A.click("#opApplyBtn"); A.wait_for_timeout(800)
    DIALOG["cancel"] = False
    check("'Apply to all routes' asks for confirmation; Cancel changes nothing", len(dialog_msgs) == n0 + 1 and "6 route(s)" in dialog_msgs[-1] and routes_of(A, cid_a) == before, dialog_msgs[-1:])
    A.click("#opApplyBtn")
    A.wait_for_function("document.getElementById('opApplyMsg').textContent.includes('Updated 6 routes')", timeout=15000)
    after = routes_of(A, cid_a)
    changed = [i for i in after if after[i] != before[i]]
    empties = {rid2, big_id, "route-995-am", "route-995-pm", "route-902-am", "route-902-pm"}
    check("fill-only: exactly the 6 routes without operator (Run Test, Big recorded, 4 samples) were filled (operatorCustom=false); the 35 custom routes (incl. 34 samples) and the new ones untouched",
          set(changed) == empties and all(after[i]["operator"] == OP1 and after[i]["custom"] is False for i in empties)
          and after["seed-360-am"]["operator"]["name"].startswith("South Wales") and after[rc]["operator"]["name"] == "Custom Cabs Ltd", sorted(changed))
    check("after fill-only the panel says nothing left to update in 'fill' mode (36 custom kept)", "0 would be updated" in A.inner_text("#opApplyInfo") and "36 custom kept" in A.inner_text("#opApplyInfo") and A.is_disabled("#opApplyBtn"), A.inner_text("#opApplyInfo"))
    shot(A, "33-admin-operator-applied-fill-only.png")

    # one sample route: reset-to-company in the editor (custom -> company)
    A.click("#admTabRoutes"); A.click("#adminRouteList .arow[data-route-id='seed-360-am'] [data-act=edit]"); wait_view(A, "editor")
    check("sample route editor: indicator 'Custom for this route' (it has its own operator)", A.inner_text("#ed_op_status").strip() == "Custom for this route" and A.input_value("#ed_op_name") != OP1["name"])
    A.click("#ed_op_reset"); A.click("#edSave"); wait_view(A, "admin")
    A.wait_for_timeout(600)
    d360 = fs_get(A, f"companies/{cid_a}/routes/seed-360-am")
    check("reset-to-company + save: route now stores the company operator, operatorCustom=false", d360["operator"] == OP1 and d360["operatorCustom"] is False, d360.get("operator"))

    A.click("#admTabOperator"); A.click("#opModeAll")
    expect_n = sum(1 for v in routes_of(A, cid_a).values() if not (v["operator"] == OP1 and v["custom"] is not True))
    check("overwrite-all preview counts every route not yet on the company details (35 of 43)", expect_n == 35 and "35 would be updated" in A.inner_text("#opApplyInfo"), (expect_n, A.inner_text("#opApplyInfo")))
    A.click("#opApplyBtn")
    A.wait_for_function("document.getElementById('opApplyMsg').textContent.includes('Updated 35 routes')", timeout=30000)
    check("overwrite-all confirm text warns it OVERWRITES custom routes", "OVERWRITE" in dialog_msgs[-1] and "custom" in dialog_msgs[-1], dialog_msgs[-1])
    allr = routes_of(A, cid_a)
    samples_ok = [i for i in allr if i.startswith(("seed-", "route-"))]
    check("overwrite-all: ALL 43 routes (incl. the 38 sample routes and the custom one) now have the company operator, operatorCustom=false",
          len(allr) == 43 and all(v["operator"] == OP1 and v["custom"] is False for v in allr.values()) and len(samples_ok) == 38, (len(allr), len(samples_ok)))
    check("after applying, the panel reports every route already uses the company details", "43 already use" in A.inner_text("#opApplyInfo") and A.is_disabled("#opApplyBtn"), A.inner_text("#opApplyInfo"))
    shot(A, "34-admin-operator-applied-overwrite-all.png")
    sched = d_schedule("360 (AM)")
    check("driver Schedule: a former custom sample route now shows the company operator", OP1["name"] in sched and OP1["tel"] in sched and "South Wales Transport" not in sched, sched[-300:])
    shot(D, "35-driver-schedule-after-apply.png")

    # ---- 5. change company details: drivers see them live; apply refreshes; re-importing samples picks them up
    A.click("#admTabOperator"); set_op_form(OP2); A.click("#opSave")
    A.wait_for_function("document.getElementById('opMsg').textContent.includes('saved')", timeout=10000)
    check("company operator updated in Firestore", op_of(A) == OP2, op_of(A))
    ai = A.inner_text("#opApplyInfo")
    check("panel offers to refresh the 43 routes that still hold the old copy", "43 would be updated" in ai and "Saved." in ai, ai)
    D.wait_for_function("t => document.getElementById('schedBody').innerText.includes(t)", arg=OP2["tel"], timeout=15000)
    check("driver (no reload) immediately sees the NEW company details on a route that follows the company, even before 'Apply'",
          OP2["tel"] in D.inner_text("#schedBody") and OP2["address"] in D.inner_text("#schedBody") and OP1["tel"] not in D.inner_text("#schedBody"), D.inner_text("#schedBody")[-250:])
    check("(routes in Firestore still hold the old copy until applied)", all(v["operator"] == OP1 for v in routes_of(A, cid_a).values()))
    A.click("#opApplyBtn")
    A.wait_for_function("document.getElementById('opApplyMsg').textContent.includes('Updated 43 routes')", timeout=30000)
    check("fill-only apply refreshed all 43 routes that followed the company", all(v["operator"] == OP2 and v["custom"] is False for v in routes_of(A, cid_a).values()))
    # sample import with a company operator set
    A.click("#admTabRoutes"); A.click("#importSampleBtn")
    A.wait_for_function("document.getElementById('toast').textContent.includes('company operator details')", timeout=60000)
    A.wait_for_timeout(500)
    r360 = fs_get(A, "companies/%s/routes/seed-360-pm" % cid_a)
    allr = routes_of(A, cid_a)
    check("sample import with a company operator: imported routes get it (not the sample's own), operatorCustom=false, still 43 routes",
          r360["operator"] == OP2 and r360["operatorCustom"] is False and len(allr) == 43 and all(v["operator"] == OP2 for v in allr.values()), (r360.get("operator"), len(allr)))
    A.wait_for_timeout(500)

    # ---- 6. other company unaffected
    cid_b = B.evaluate("window.__mc.getDoc(window.__mc.doc(window.__mc.db,'users',window.__mc.auth.currentUser.uid)).then(d=>d.data().companyId)")
    rb = routes_of(B, cid_b)
    check("company B: no operator on its company doc or on its route", op_of(B, "companies/" + cid_b) is None and all(v["operator"] is None for v in rb.values()) and len(rb) == 1, rb)
    B.click("#admTabOperator")
    check("company B's Operator tab is empty and apply is disabled", all(B.input_value("#" + i) == "" for i in ("opName", "opAddress", "opTel", "opEmail")) and B.is_disabled("#opApplyBtn"))
    shot(B, "36-company-b-operator-tab-empty.png")
    B.click("#admTabRoutes"); B.click("#newRouteBtn"); wait_view(B, "editor")
    check("company B: a new route is NOT pre-filled with A's operator", all(B.input_value("#ed_op_" + k) == "" for k in ("name", "address", "tel", "email")))
    B.click("#edBack"); wait_view(B, "admin")
    B.click("#adminToDriver"); wait_view(B, "driver"); B.wait_for_timeout(800)
    if B.is_visible("#tabSchedBtn"): B.click("#tabSchedBtn")
    B.wait_for_timeout(400)
    bs = B.inner_text("#schedBody")
    check("company B's driver Schedule (route 'Bravo Route 1') shows no operator section / none of A's details", B.inner_text("#routeName") == "Bravo Route 1" and "OPERATOR" not in bs and OP2["name"] not in bs, (B.inner_text("#routeName"), bs[-200:]))
    B.evaluate("document.getElementById('menuBtn').click()"); B.click("#acctAdmin"); wait_view(B, "admin")
    for what, call in (("company operator", f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}'),{{operator:{{name:'Evil'}}}})"),
                       ("A's route operator", f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid2}'),{{operator:{{name:'Evil'}}}})")):
        r = B.evaluate(f"{call}.then(()=>'WRITTEN').catch(e=>e.code)")
        check(f"company B admin cannot change A's {what} (permission-denied)", r == "permission-denied", r)
    check("A's operator unchanged after B's attempts", op_of(A) == OP2 and fs_get(A, f"companies/{cid_a}/routes/{rid2}")["operator"] == OP2)

    # ---- 7. drivers cannot edit; rules reject bad operator data even from the browser
    check("driver UI: no Operator tab / admin screen anywhere", not D.is_visible("#admTabOperator") and not D.is_visible("#admOperator") and not D.is_visible("#adminScreen"))
    for what, call in (("company operator", f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}'),{{operator:{{name:'Driver Co'}}}})"),
                       ("company name", f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}'),{{name:'Driver Co'}})"),
                       ("a route's operator", f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}','routes','{rid2}'),{{operator:{{name:'Driver Co'}},operatorCustom:true}})")):
        r = D.evaluate(f"{call}.then(()=>'WRITTEN').catch(e=>e.code)")
        check(f"driver cannot edit {what} (permission-denied)", r == "permission-denied", r)
    comp_now = fs_get(A, "companies/" + cid_a)
    check("nothing changed after the driver's attempts", comp_now["operator"] == OP2 and comp_now["name"] == "Alpha Coaches" and comp_now["ownerUid"] == uid_a)
    for what, val in (("empty name", "{name:''}"), ("bad email", "{name:'N',email:'x@y'}"), ("name > 120 chars", "{name:'x'.repeat(121)}"),
                      ("tel > 40 chars", "{name:'N',tel:'1'.repeat(41)}"), ("address > 250 chars", "{name:'N',address:'a'.repeat(251)}"), ("unknown key", "{name:'N',evil:1}")):
        r = A.evaluate(f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}'),{{operator:{val}}}).then(()=>'WRITTEN').catch(e=>e.code)")
        check(f"rules: even the admin cannot store an operator with {what} (permission-denied)", r == "permission-denied", r)
    r = A.evaluate(f"window.__mc.updateDoc(window.__mc.doc(window.__mc.db,'companies','{cid_a}'),{{ownerUid:'someone-else'}}).then(()=>'WRITTEN').catch(e=>e.code)")
    check("rules: ownerUid still protected (permission-denied)", r == "permission-denied", r)
    check("company doc unchanged after the rejected writes", fs_get(A, "companies/" + cid_a)["operator"] == OP2)
    A.click("#admTabOperator"); A.wait_for_timeout(300)
    shot(A, "37-admin-operator-final.png")
    # phone-width layout of the new tab (tabs scroll sideways, nothing overflows the page)
    A.set_viewport_size({"width": 390, "height": 844}); A.wait_for_timeout(400)
    ov = A.evaluate("({sw: document.documentElement.scrollWidth, iw: window.innerWidth, form: document.getElementById('opForm').getBoundingClientRect().right})")
    check("Operator details tab fits a 390 px phone screen (no horizontal page overflow)", ov["sw"] <= ov["iw"] and ov["form"] <= ov["iw"], ov)
    shot(A, "43-admin-operator-phone-width.png")
    A.click("#admTabOperator"); A.fill("#opName", ""); A.click("#opSave"); A.wait_for_timeout(300)
    check("phone width: validation message visible", A.is_visible("#opMsg") and "name" in A.inner_text("#opMsg"))
    A.set_viewport_size({"width": 1280, "height": 860}); A.reload(); wait_view(A, "admin")

    # ------------------------------------------------------------------ Remove driver -> access revoked; re-add reuses login
    A.click("#admTabDrivers")
    A.click("#driverList .arow:has-text('Dave Driver') button:has-text('Remove')")
    A.wait_for_function("document.querySelectorAll('#driverList .arow').length === 1")
    D.reload(); D.wait_for_function("document.body.classList.contains('view-orphan') || document.body.classList.contains('view-auth')", timeout=15000)
    check("removed driver is locked out (no company linked)", "view-orphan" in D.evaluate("document.body.className"), D.evaluate("document.body.className"))
    shot(D, "15-removed-driver-no-company.png")
    A.fill("#dvName", "Dave Driver"); A.fill("#dvEmail", "dave@alpha.test"); A.fill("#dvPass", "TempPass1"); A.click("#dvBtn")
    A.wait_for_function("document.querySelectorAll('#driverList .arow').length === 2", timeout=15000)
    D.click("#orphanRetry"); wait_view(D, "driver", 15000)
    check("re-adding the same driver (same password) restores access", True)
    # sign out via drawer
    D.evaluate("document.getElementById('menuBtn').click()"); D.click("#acctSignOut"); wait_view(D, "auth", 20000)
    check("driver sign out returns to sign-in screen", True)

    # wrong password
    D.fill("#siEmail", "dave@alpha.test"); D.fill("#siPass", "nope-nope"); D.click("#siBtn"); D.wait_for_function("document.getElementById('authMsg').textContent.length > 0", timeout=10000)
    check("wrong password shows an error", "Wrong email or password" in D.inner_text("#authMsg"), D.inner_text("#authMsg"))

    br.close()

# ---------------------------------------------------------------------- summary
expected_noise = ("permission-denied", "Missing or insufficient permissions", "PERMISSION_DENIED", "Failed to load resource")
unexpected_console = [c for c in console_errors if not any(x in c for x in expected_noise)]
check("no uncaught JS page errors", not page_errors, page_errors)
check("no unexpected console errors", not unexpected_console, unexpected_console[:5])
print("\nconsole errors seen (all):", len(console_errors))
for c in console_errors[:15]: print("   ", c[:200])
passed = sum(1 for r in results if r[1]); failed = [r for r in results if not r[1]]
print(f"\n{passed}/{len(results)} checks passed")
Path(ROOT / "tests" / "e2e-results.json").write_text(json.dumps({"passed": passed, "total": len(results), "checks": results, "console_errors": console_errors, "page_errors": page_errors}, indent=1))
sys.exit(1 if failed else 0)
