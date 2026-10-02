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

def watch(page, tag):
    page.on("pageerror", lambda e: page_errors.append(f"[{tag}] {e} :: {(getattr(e, 'stack', '') or '')[:600]}"))
    page.on("console", lambda m: console_errors.append(f"[{tag}] {m.text}") if m.type == "error" else None)
    page.on("dialog", lambda d: d.accept())

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
