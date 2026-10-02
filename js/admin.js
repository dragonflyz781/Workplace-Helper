/* Admin screens: route management (with GPX import + editor) and driver management. */
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, collection, setDoc, deleteDoc, onSnapshot, query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { createSecondaryAuth } from "./firebase-init.js";
import { $, esc, toast, setView, friendlyError, toggleTheme } from "./ui.js";
import { parseGPX, fitTrack, decodePolyline, encodePolyline } from "./geo.js";

let ctx = null;            // { db, auth, user, profile, companyId, company, openDriver, signOutAndReset }
let rawRoutes = {};        // id -> Firestore data (kept up to date by main.js)
let unsubUsers = null;
let wired = false;

const routesCol = () => collection(ctx.db, "companies", ctx.companyId, "routes");

/* =============================================================== setup */
export function initAdmin(c) {
  ctx = c;
  $("adminCompany").textContent = c.company.name;
  $("adminWho").textContent = (c.profile.name || c.user.email) + " · Administrator";
  if (!wired) { wired = true; wire(); }
  subscribeUsers();
}

export function showAdmin() {
  setView("admin");
  renderRouteList();
}

export function onRoutesChanged(raw) {
  rawRoutes = raw;
  if (ctx) renderRouteList();
}

function wire() {
  $("adminToDriver").addEventListener("click", () => ctx.openDriver());
  $("adminSignOut").addEventListener("click", () => ctx.signOutAndReset());
  $("adminTheme").addEventListener("click", toggleTheme);
  const tab = (routes) => {
    $("admTabRoutes").classList.toggle("active", routes);
    $("admTabDrivers").classList.toggle("active", !routes);
    $("admRoutes").style.display = routes ? "" : "none";
    $("admDrivers").style.display = routes ? "none" : "";
  };
  $("admTabRoutes").addEventListener("click", () => tab(true));
  $("admTabDrivers").addEventListener("click", () => tab(false));
  $("newRouteBtn").addEventListener("click", () => openEditor(null));
  $("importSampleBtn").addEventListener("click", importSamples);
  $("driverForm").addEventListener("submit", addDriver);
  $("dvGen").addEventListener("click", () => { $("dvPass").value = randomPassword(); });
  $("edBack").addEventListener("click", closeEditor);
  $("edSave").addEventListener("click", saveDraft);
}

/* =============================================================== route list */
function sessionLabel(s) { return s === "AM" ? "AM" : s === "PM" ? "PM" : s === "both" ? "AM+PM" : "—"; }

function renderRouteList() {
  const list = $("adminRouteList");
  const ids = Object.keys(rawRoutes).sort((a, b) =>
    String(rawRoutes[a].name || "").localeCompare(String(rawRoutes[b].name || ""), undefined, { numeric: true }));
  $("routesStatus").textContent = ids.length ? ids.length + " route" + (ids.length === 1 ? "" : "s") : "";
  if (!ids.length) {
    list.innerHTML = '<div class="empty-note">No routes yet.<br>Tap <b>＋ New route</b> to upload a GPX file, or <b>Import sample routes</b> to try the demo set.</div>';
    return;
  }
  list.innerHTML = "";
  ids.forEach((id) => {
    const r = rawRoutes[id];
    const el = document.createElement("div");
    el.className = "arow";
    el.dataset.routeId = id;
    const initials = (r.name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
    el.innerHTML =
      '<div class="route-badge">' + esc(initials) + "</div>" +
      '<div class="route-meta"><div class="name">' + esc(r.name || "Untitled") + "</div>" +
      '<div class="sub"><span class="pill">' + esc(r.category || "other") + '</span><span class="pill">' + esc(sessionLabel(r.session)) + "</span>" +
      (r.stops ? r.stops.length : 0) + " stops · " + (r.trackPoints || 0) + " pts</div></div>" +
      '<div class="arow-actions"><button class="btn small" data-act="edit">Edit</button>' +
      '<button class="btn small danger" data-act="del">Delete</button></div>';
    el.querySelector('[data-act="edit"]').addEventListener("click", () => openEditor(id));
    el.querySelector('[data-act="del"]').addEventListener("click", () => deleteRoute(id));
    list.appendChild(el);
  });
}

async function deleteRoute(id) {
  const name = (rawRoutes[id] && rawRoutes[id].name) || "this route";
  if (!confirm('Delete "' + name + '"? Drivers will no longer see it. This cannot be undone.')) return;
  try { await deleteDoc(doc(routesCol(), id)); toast("Deleted “" + name + "”."); }
  catch (e) { toast("Could not delete: " + friendlyError(e), true); }
}

/* =============================================================== building a Firestore doc */
const clean = (o) => {
  const out = {};
  Object.keys(o).forEach((k) => {
    const v = o[k];
    if (v === undefined || v === null) return;
    if (typeof v === "string" && v.trim() === "") return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = typeof v === "string" ? v.trim() : v;
  });
  return out;
};

function buildDoc(d) {
  const source = d.track.length ? d.track : d.stops.map((s) => [s.lat, s.lng]);
  const fit = fitTrack(source);
  const data = clean({
    name: d.name, category: d.category, session: d.session,
    note: d.note, capacity: d.capacity, specifiedRoute: d.specifiedRoute,
    addedAt: d.addedAt || new Date().toISOString()
  });
  const op = clean(d.operator || {});
  if (Object.keys(op).length) data.operator = op;
  const contacts = (d.contacts || []).map((c) => clean(c)).filter((c) => c.label || c.tel);
  if (contacts.length) data.contacts = contacts;
  const tt = {};
  ["morning", "afternoon"].forEach((k) => {
    const rows = (d.timetable[k] || []).map((r) => ({ stop: String(r.stop || "").trim(), time: String(r.time || "").trim() }));
    if (rows.length) tt[k] = rows;
  });
  if ((d.timetable.morningNote || "").trim()) tt.morningNote = d.timetable.morningNote.trim();
  if ((d.timetable.afternoonNote || "").trim()) tt.afternoonNote = d.timetable.afternoonNote.trim();
  if (Object.keys(tt).length) data.timetable = tt;
  data.stops = d.stops.map((s, i) => ({
    lat: Math.round(s.lat * 1e5) / 1e5, lng: Math.round(s.lng * 1e5) / 1e5, name: (s.name || "").trim() || "Stop " + (i + 1)
  }));
  data.trackEnc = encodePolyline(fit.track);
  data.trackPoints = fit.track.length;
  // keep the record of an earlier simplification (done when the GPX was loaded)
  const meta = fit.simplified ? { original: fit.originalPoints, tol: fit.toleranceM } : d.trackMeta;
  data.trackOriginalPoints = meta ? meta.original : fit.originalPoints;
  if (meta) data.trackSimplifiedToleranceM = meta.tol;
  return { data, fit };
}


function checkSize(data) {
  const approx = JSON.stringify(data).length;     // UTF-8 bytes >= chars; ASCII-heavy so close enough
  if (approx > 900000) throw new Error("This route is too large to store (" + Math.round(approx / 1024) + " KB). Remove some stops/timetable rows.");
}

/* =============================================================== sample import */
async function importSamples() {
  if (!confirm("Import Keith's 38 sample Swansea school/college routes into your company?\n\n(Running it twice just refreshes the same routes - it won't create duplicates.)")) return;
  const btn = $("importSampleBtn");
  btn.disabled = true;
  try {
    toast("Importing…");
    const { SAMPLE_ROUTES } = await import("./sample-routes.js");
    const ids = Object.keys(SAMPLE_ROUTES);
    for (let i = 0; i < ids.length; i += 15) {
      const batch = writeBatch(ctx.db);
      ids.slice(i, i + 15).forEach((id) => {
        const s = SAMPLE_ROUTES[id];
        const { data } = buildDoc({
          name: s.name, category: s.category || "school", session: s.session, note: s.note, capacity: s.capacity,
          specifiedRoute: s.specifiedRoute, addedAt: s.addedAt, operator: s.operator || {}, contacts: s.contacts || [],
          timetable: s.timetable || {},
          track: s.track || [], stops: (s.stops || []).map((p, k) => ({ lat: p[0], lng: p[1], name: "Stop " + (k + 1) }))
        });
        data.updatedAt = serverTimestamp(); data.updatedBy = ctx.user.uid;
        checkSize(data);
        batch.set(doc(routesCol(), id), data);
      });
      await batch.commit();
    }
    toast("Imported " + ids.length + " sample routes.");
  } catch (e) {
    console.warn("Import failed:", e && e.message);
    toast("Import failed: " + friendlyError(e), true);
  }
  btn.disabled = false;
}

/* =============================================================== route editor */
let draft = null, editingId = null, edMap = null, edTrack = null, edStops = null, addingStop = false, trackInfo = "";

function blankDraft() {
  return {
    name: "", category: "school", session: "both", note: "", capacity: "", specifiedRoute: "", addedAt: null,
    operator: { name: "", address: "", tel: "", email: "" }, contacts: [],
    timetable: { morning: [], afternoon: [], morningNote: "", afternoonNote: "" },
    track: [], stops: []
  };
}

function draftFromRaw(d) {
  const b = blankDraft();
  const tt = d.timetable || {};
  return Object.assign(b, {
    name: d.name || "", category: d.category || "school", session: d.session || "", note: d.note || "",
    capacity: d.capacity || "", specifiedRoute: d.specifiedRoute || "", addedAt: d.addedAt || null,
    operator: Object.assign(b.operator, d.operator || {}),
    contacts: (d.contacts || []).map((c) => ({ label: c.label || "", tel: c.tel || "" })),
    timetable: {
      morning: (tt.morning || []).map((r) => ({ stop: r.stop, time: r.time })),
      afternoon: (tt.afternoon || []).map((r) => ({ stop: r.stop, time: r.time })),
      morningNote: tt.morningNote || "", afternoonNote: tt.afternoonNote || ""
    },
    track: d.trackEnc ? decodePolyline(d.trackEnc) : [],
    trackMeta: d.trackSimplifiedToleranceM ? { original: d.trackOriginalPoints, tol: d.trackSimplifiedToleranceM } : null,
    stops: (d.stops || []).map((s) => ({ lat: s.lat, lng: s.lng, name: s.name || "" }))
  });
}

function openEditor(id) {
  editingId = id;
  draft = id ? draftFromRaw(rawRoutes[id]) : blankDraft();
  addingStop = false;
  trackInfo = id && rawRoutes[id].trackOriginalPoints && rawRoutes[id].trackSimplifiedToleranceM
    ? "Stored track was simplified from " + rawRoutes[id].trackOriginalPoints.toLocaleString() + " to " + rawRoutes[id].trackPoints.toLocaleString() + " points." : "";
  $("edTitle").textContent = id ? "Edit route" : "New route";
  buildEditorDom();
  setView("editor");
  initEditorMap();
  $("edBody").scrollTop = 0;
}

function closeEditor() {
  if (edMap) { edMap.remove(); edMap = null; }
  draft = null;
  setView("admin");
  renderRouteList();
}

function buildEditorDom() {
  const d = draft;
  $("edBody").innerHTML =
    '<div class="ed-form">' +
    '<div class="ed-card"><h3>Route</h3>' +
      '<label>Route name<input type="text" id="ed_name" maxlength="120" placeholder="e.g. 360 (AM)"></label>' +
      '<div class="grid2"><label>Category<select id="ed_category"><option value="school">School</option><option value="college">College</option><option value="other">Other</option></select></label>' +
      '<label>Session<select id="ed_session"><option value="">Not set (use timetable)</option><option value="AM">AM (morning)</option><option value="PM">PM (afternoon)</option><option value="both">Both</option></select></label></div>' +
      '<label>Note shown at the top of the schedule <span class="muted">(optional)</span><textarea id="ed_note" maxlength="1000"></textarea></label>' +
    "</div>" +
    '<div class="ed-card"><h3>GPX file</h3>' +
      '<label class="file-btn"><span style="font-size:19px">⬆</span><span id="gpxLabel">Upload GPX file (track + waypoints / route points)</span>' +
      '<input type="file" id="ed_gpx" accept=".gpx,.xml,.txt"></label>' +
      '<div class="note-line" id="gpxInfo"></div>' +
    "</div>" +
    '<div class="ed-card"><h3>Stops (in order)</h3><div id="stopList"></div>' +
      '<div class="note-line">Rename, re-order (▲▼) or delete stops here. Drag a marker on the map to move it, or press <b>Add stop on map</b> and click the map.</div></div>' +
    '<div class="ed-card"><h3>Timetable – morning</h3><div id="ttMorning"></div>' +
      '<div class="row"><button class="btn small" id="ttAddMorning" type="button">＋ Add row</button><button class="btn small" id="ttFillMorning" type="button">Fill from stops</button></div>' +
      '<label style="margin-top:8px">Morning note <span class="muted">(optional)</span><input type="text" id="ed_morningNote" maxlength="300"></label></div>' +
    '<div class="ed-card"><h3>Timetable – afternoon</h3><div id="ttAfternoon"></div>' +
      '<div class="row"><button class="btn small" id="ttAddAfternoon" type="button">＋ Add row</button><button class="btn small" id="ttFillAfternoon" type="button">Fill from stops</button></div>' +
      '<label style="margin-top:8px">Afternoon note <span class="muted">(optional)</span><input type="text" id="ed_afternoonNote" maxlength="300"></label></div>' +
    '<div class="ed-card"><h3>Operator &amp; vehicle</h3>' +
      '<label>Operator name<input type="text" id="ed_op_name" maxlength="120"></label>' +
      '<label>Address<input type="text" id="ed_op_address" maxlength="250"></label>' +
      '<div class="grid2"><label>Telephone<input type="tel" id="ed_op_tel" maxlength="40"></label><label>Email<input type="email" id="ed_op_email" maxlength="120"></label></div>' +
      '<label>Capacity <span class="muted">(e.g. 53 seats)</span><input type="text" id="ed_capacity" maxlength="60"></label>' +
      '<label>Specified route <span class="muted">(road names, optional)</span><textarea id="ed_specified" maxlength="3000"></textarea></label>' +
      '<div class="muted" style="margin:6px 0 4px;font-weight:600">Other contacts</div><div id="contactList"></div>' +
      '<button class="btn small" id="contactAdd" type="button">＋ Add contact</button>' +
    "</div></div>" +
    '<div class="ed-map-col"><div class="ed-card"><h3>Map preview</h3><div id="edMap"></div>' +
      '<div class="ed-map-tools"><button class="btn small" id="addStopBtn" type="button">📍 Add stop on map</button>' +
      '<span class="muted" id="mapCounts"></span></div></div></div>' +
    '<datalist id="stopNames"></datalist>';

  // simple fields
  const bind = (id, get, set) => { const el = $(id); el.value = get() || ""; el.addEventListener("input", () => set(el.value)); };
  bind("ed_name", () => d.name, (v) => (d.name = v));
  bind("ed_category", () => d.category, (v) => (d.category = v));
  bind("ed_session", () => d.session, (v) => (d.session = v));
  bind("ed_note", () => d.note, (v) => (d.note = v));
  bind("ed_morningNote", () => d.timetable.morningNote, (v) => (d.timetable.morningNote = v));
  bind("ed_afternoonNote", () => d.timetable.afternoonNote, (v) => (d.timetable.afternoonNote = v));
  bind("ed_op_name", () => d.operator.name, (v) => (d.operator.name = v));
  bind("ed_op_address", () => d.operator.address, (v) => (d.operator.address = v));
  bind("ed_op_tel", () => d.operator.tel, (v) => (d.operator.tel = v));
  bind("ed_op_email", () => d.operator.email, (v) => (d.operator.email = v));
  bind("ed_capacity", () => d.capacity, (v) => (d.capacity = v));
  bind("ed_specified", () => d.specifiedRoute, (v) => (d.specifiedRoute = v));

  $("ed_gpx").addEventListener("change", onGpxChosen);
  $("addStopBtn").addEventListener("click", () => setAddingStop(!addingStop));
  $("ttAddMorning").addEventListener("click", () => { d.timetable.morning.push({ stop: "", time: "" }); renderTimetable("morning"); });
  $("ttAddAfternoon").addEventListener("click", () => { d.timetable.afternoon.push({ stop: "", time: "" }); renderTimetable("afternoon"); });
  $("ttFillMorning").addEventListener("click", () => fillFromStops("morning"));
  $("ttFillAfternoon").addEventListener("click", () => fillFromStops("afternoon"));
  $("contactAdd").addEventListener("click", () => { d.contacts.push({ label: "", tel: "" }); renderContacts(); });

  renderStopList(); renderTimetable("morning"); renderTimetable("afternoon"); renderContacts(); updateGpxInfo();
}

function updateGpxInfo() {
  const parts = [];
  if (draft.track.length) parts.push("Track: " + draft.track.length.toLocaleString() + " points");
  if (trackInfo) parts.push(trackInfo);
  $("gpxInfo").textContent = parts.join(" · ");
  $("mapCounts").textContent = draft.stops.length + " stops · " + draft.track.length.toLocaleString() + " track pts";
}

/* ---- GPX ---- */
function onGpxChosen(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("Could not read that file.", true);
  reader.onload = () => {
    try {
      const parsed = parseGPX(String(reader.result), file.name.replace(/\.[^.]+$/, ""));
      if ((draft.stops.length || draft.track.length) &&
          !confirm("Replace this route's current track and stops with the ones in “" + file.name + "”?")) { ev.target.value = ""; return; }
      const fit = fitTrack(parsed.track);
      draft.track = fit.track;
      draft.trackMeta = fit.simplified ? { original: fit.originalPoints, tol: fit.toleranceM } : null;
      draft.stops = parsed.stops;
      if (!draft.name.trim()) { draft.name = parsed.name; $("ed_name").value = parsed.name; }
      trackInfo = fit.simplified
        ? "Simplified from " + fit.originalPoints.toLocaleString() + " to " + fit.track.length.toLocaleString() + " points (tolerance " + fit.toleranceM + " m) so it fits comfortably in the database."
        : "";
      $("gpxLabel").textContent = "Loaded: " + file.name;
      renderStopList(); drawMap(true); updateGpxInfo();
      toast("GPX loaded: " + fit.track.length.toLocaleString() + " track points, " + parsed.stops.length + " stops.");
    } catch (e) { toast(e.message, true); }
    ev.target.value = "";
  };
  reader.readAsText(file);
}

/* ---- stops ---- */
function renderStopList() {
  const wrap = $("stopList");
  wrap.innerHTML = "";
  if (!draft.stops.length) wrap.innerHTML = '<div class="muted">No stops yet.</div>';
  draft.stops.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "rowitem";
    row.dataset.stopIndex = i;
    row.innerHTML = '<div class="idx">' + (i + 1) + '</div><input type="text" class="stop-name" maxlength="120" aria-label="Stop ' + (i + 1) + ' name">' +
      '<button class="mini" type="button" data-a="up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
      '<button class="mini" type="button" data-a="down" aria-label="Move down"' + (i === draft.stops.length - 1 ? " disabled" : "") + ">▼</button>" +
      '<button class="mini del" type="button" data-a="del" aria-label="Delete stop">✕</button>';
    const inp = row.querySelector("input");
    inp.value = s.name || "";
    inp.addEventListener("input", () => { s.name = inp.value; refreshDatalist(); });
    row.querySelector('[data-a="up"]').addEventListener("click", () => moveStop(i, -1));
    row.querySelector('[data-a="down"]').addEventListener("click", () => moveStop(i, 1));
    row.querySelector('[data-a="del"]').addEventListener("click", () => { draft.stops.splice(i, 1); stopsChanged(); });
    wrap.appendChild(row);
  });
  refreshDatalist();
}
function moveStop(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= draft.stops.length) return;
  const t = draft.stops[i]; draft.stops[i] = draft.stops[j]; draft.stops[j] = t;
  stopsChanged();
}
function stopsChanged() { renderStopList(); drawMap(false); updateGpxInfo(); }
function refreshDatalist() {
  $("stopNames").innerHTML = draft.stops.filter((s) => (s.name || "").trim()).map((s) => '<option value="' + esc(s.name) + '">').join("");
}

/* ---- timetable ---- */
function renderTimetable(which) {
  const wrap = $(which === "morning" ? "ttMorning" : "ttAfternoon");
  const rows = draft.timetable[which];
  wrap.innerHTML = rows.length ? "" : '<div class="muted" style="margin-bottom:6px">No rows – drivers see “No drop times saved” for this part of the day.</div>';
  rows.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = '<input type="text" class="tt-stop" list="stopNames" maxlength="120" placeholder="Stop name" aria-label="Timetable stop">' +
      '<input type="time" class="t tt-time" aria-label="Time">' +
      '<button class="mini del" type="button" aria-label="Delete row">✕</button>';
    const [si, ti] = el.querySelectorAll("input");
    si.value = r.stop || ""; ti.value = r.time || "";
    si.addEventListener("input", () => (r.stop = si.value));
    ti.addEventListener("input", () => (r.time = ti.value));
    el.querySelector("button").addEventListener("click", () => { draft.timetable[which].splice(i, 1); renderTimetable(which); });
    wrap.appendChild(el);
  });
}
function fillFromStops(which) {
  if (!draft.stops.length) { toast("Add some stops first.", true); return; }
  const rows = draft.timetable[which];
  if (rows.length && !confirm("Replace the current " + which + " rows with one row per stop (times left blank for you to fill in)?")) return;
  draft.timetable[which] = draft.stops.map((s, i) => ({ stop: (s.name || "").trim() || "Stop " + (i + 1), time: "" }));
  renderTimetable(which);
}

/* ---- contacts ---- */
function renderContacts() {
  const wrap = $("contactList");
  wrap.innerHTML = "";
  draft.contacts.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = '<input type="text" placeholder="Label (e.g. Depot)" maxlength="80"><input type="tel" placeholder="Telephone" maxlength="40">' +
      '<button class="mini del" type="button" aria-label="Delete contact">✕</button>';
    const [a, b] = el.querySelectorAll("input");
    a.value = c.label; b.value = c.tel;
    a.addEventListener("input", () => (c.label = a.value));
    b.addEventListener("input", () => (c.tel = b.value));
    el.querySelector("button").addEventListener("click", () => { draft.contacts.splice(i, 1); renderContacts(); });
    wrap.appendChild(el);
  });
}

/* ---- map preview ---- */
function initEditorMap() {
  if (edMap) { edMap.remove(); edMap = null; }
  edMap = L.map("edMap", { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([52.5, -2], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", crossOrigin: true
  }).addTo(edMap);
  edTrack = null; edStops = L.layerGroup().addTo(edMap);
  edMap.on("click", (ev) => {
    if (!addingStop) return;
    draft.stops.push({ lat: Math.round(ev.latlng.lat * 1e5) / 1e5, lng: Math.round(ev.latlng.lng * 1e5) / 1e5, name: "Stop " + (draft.stops.length + 1) });
    stopsChanged();
  });
  const mine = edMap;
  setTimeout(() => { if (edMap !== mine) return; edMap.invalidateSize(); drawMap(true); }, 60);
}

function setAddingStop(on) {
  addingStop = on;
  $("addStopBtn").classList.toggle("on", on);
  $("addStopBtn").textContent = on ? "✔ Click the map to place a stop (tap to stop)" : "📍 Add stop on map";
  if (edMap) edMap.getContainer().style.cursor = on ? "crosshair" : "";
}

function drawMap(fit) {
  if (!edMap) return;
  if (edTrack) { edMap.removeLayer(edTrack); edTrack = null; }
  edStops.clearLayers();
  const style = getComputedStyle(document.documentElement);
  const routeCol = style.getPropertyValue("--route").trim() || "#0e8f7d";
  if (draft.track.length > 1) edTrack = L.polyline(draft.track, { color: routeCol, weight: 4, opacity: 0.9 }).addTo(edMap);
  else if (draft.stops.length > 1) edTrack = L.polyline(draft.stops.map((s) => [s.lat, s.lng]), { color: routeCol, weight: 3, dashArray: "6,8" }).addTo(edMap);
  draft.stops.forEach((s, i) => {
    const m = L.marker([s.lat, s.lng], {
      draggable: true,
      icon: L.divIcon({ className: "", html: '<div class="stop-marker"><span>' + (i + 1) + "</span></div>", iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(edStops);
    m.on("dragend", () => {
      const p = m.getLatLng();
      s.lat = Math.round(p.lat * 1e5) / 1e5; s.lng = Math.round(p.lng * 1e5) / 1e5;
    });
  });
  if (fit) {
    const pts = draft.track.length ? draft.track : draft.stops.map((s) => [s.lat, s.lng]);
    if (pts.length) edMap.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
  }
}

/* ---- save ---- */
async function saveDraft() {
  const d = draft;
  if (!d) return;
  try {
    if (!d.name.trim()) throw new Error("Please give the route a name.");
    if (!d.track.length && !d.stops.length) throw new Error("Upload a GPX file or add at least one stop on the map.");
    const toSave = { morning: [], afternoon: [] };
    for (const k of ["morning", "afternoon"]) {
      toSave[k] = d.timetable[k].filter((r) => (r.stop || "").trim() || (r.time || "").trim());
      for (const r of toSave[k]) {
        if (!(r.stop || "").trim()) throw new Error("Every " + k + " timetable row needs a stop name.");
        if (!/^\d{2}:\d{2}$/.test((r.time || "").trim())) throw new Error("Every " + k + " timetable row needs a time (HH:MM). Check “" + r.stop + "”.");
      }
    }
    $("edSave").disabled = true;
    const { data, fit } = buildDoc(Object.assign({}, d, { timetable: Object.assign({}, d.timetable, toSave) }));
    data.updatedAt = serverTimestamp();
    data.updatedBy = ctx.user.uid;
    checkSize(data);
    const ref = editingId ? doc(routesCol(), editingId) : doc(routesCol());
    await setDoc(ref, data);
    toast(fit.simplified ? "Saved (track simplified to " + fit.track.length.toLocaleString() + " points)." : "Route saved.");
    closeEditor();
  } catch (e) {
    console.warn("Save failed:", e && e.message);
    toast(friendlyError(e), true);
  }
  $("edSave").disabled = false;
}

/* =============================================================== drivers */
function subscribeUsers() {
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(
    query(collection(ctx.db, "users"), where("companyId", "==", ctx.companyId)),
    (snap) => renderUsers(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (err) => toast("Could not load team: " + friendlyError(err), true)
  );
}

function renderUsers(users) {
  const wrap = $("driverList");
  users.sort((a, b) => (a.role === b.role ? String(a.name).localeCompare(String(b.name)) : a.role === "admin" ? -1 : 1));
  wrap.innerHTML = "";
  users.forEach((u) => {
    const el = document.createElement("div");
    el.className = "arow";
    el.dataset.uid = u.uid;
    const isMe = u.uid === ctx.user.uid;
    el.innerHTML = '<div class="route-meta"><div class="name">' + esc(u.name || u.email) + (isMe ? " (you)" : "") + "</div>" +
      '<div class="sub"><span class="pill ' + (u.role === "admin" ? "admin" : "") + '">' + esc(u.role) + "</span>" + esc(u.email || "") + "</div></div>" +
      '<div class="arow-actions"></div>';
    const act = el.querySelector(".arow-actions");
    const reset = document.createElement("button");
    reset.className = "btn small"; reset.textContent = "Send password reset";
    reset.addEventListener("click", async () => {
      try { await sendPasswordResetEmail(ctx.auth, u.email); toast("Password-reset email sent to " + u.email + "."); }
      catch (e) { toast(friendlyError(e), true); }
    });
    act.appendChild(reset);
    if (!isMe && u.role !== "admin") {
      const rm = document.createElement("button");
      rm.className = "btn small danger"; rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        if (!confirm("Remove " + (u.name || u.email) + "?\n\nThey lose access to your company's routes straight away.")) return;
        try { await deleteDoc(doc(ctx.db, "users", u.uid)); toast("Removed " + (u.name || u.email) + "."); }
        catch (e) { toast(friendlyError(e), true); }
      });
      act.appendChild(rm);
    }
    wrap.appendChild(el);
  });
}

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ234679";
  const a = new Uint32Array(10); crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

/* Create a driver login WITHOUT signing the admin out: Firebase's
   createUserWithEmailAndPassword always signs in the new user on whichever Auth
   instance it is called on, so we call it on a second, separate app instance. */
async function addDriver(ev) {
  ev.preventDefault();
  const msg = $("driverMsg");
  const name = $("dvName").value.trim(), email = $("dvEmail").value.trim(), pass = $("dvPass").value;
  msg.className = "form-msg"; msg.textContent = "";
  $("dvBtn").disabled = true;
  let sAuth = null, createdNow = false, cred = null;
  try {
    sAuth = await createSecondaryAuth();
    try {
      cred = await createUserWithEmailAndPassword(sAuth, email, pass);
      createdNow = true;
    } catch (e) {
      if (e.code !== "auth/email-already-in-use") throw e;
      // The login may already exist (e.g. a driver removed earlier and re-added): reuse it if the password matches.
      try { cred = await signInWithEmailAndPassword(sAuth, email, pass); }
      catch (e2) { throw new Error("That email already has a login. If this is someone you removed earlier, enter their existing password, or ask them to use “Forgot password?” – or use a different email."); }
    }
    try {
      await setDoc(doc(ctx.db, "users", cred.user.uid), {
        companyId: ctx.companyId, role: "driver", name, email, createdAt: serverTimestamp()
      });
    } catch (e) {
      if (createdNow) { try { await cred.user.delete(); } catch (e3) { /* ignore */ } }
      if (e.code === "permission-denied") throw new Error("That login can't be added – it already belongs to a team (maybe yours, maybe another company).");
      throw e;
    }
    msg.className = "form-msg ok";
    msg.innerHTML = "Driver created. Give them these details:" +
      '<div class="cred-box">Email: <b>' + esc(email) + "</b><br>Password: <b>" + esc(pass) + "</b></div>";
    $("driverForm").reset();
  } catch (e) {
    console.warn("Add driver failed:", e && (e.code || e.message));
    msg.className = "form-msg"; msg.textContent = friendlyError(e);
  } finally {
    if (sAuth) { try { await signOut(sAuth); } catch (e) { /* ignore */ } }
    $("dvBtn").disabled = false;
  }
}
