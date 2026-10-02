/* App entry point: authentication, company/profile loading, and switching between
   the sign-in screen, the Admin screens and the (original) Driver view. */
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, getDoc, collection, onSnapshot, writeBatch, serverTimestamp, terminate, clearIndexedDbPersistence,
  getDocs, setDoc, deleteDoc, updateDoc, query, where
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { isConfigured, isEmulator, auth, db } from "./firebase-init.js";
import { $, setView, toast, friendlyError } from "./ui.js";
import { decodePolyline, densify } from "./geo.js";
import { initAdmin, showAdmin, onRoutesChanged } from "./admin.js";

const session = { user: null, profile: null, company: null, companyId: null, unsubRoutes: null };
let registering = false;

/* ---------- convert a Firestore route doc into the shape the driver view expects ---------- */
export function docToRoute(id, d) {
  const stops = Array.isArray(d.stops) ? d.stops : [];
  const track = d.trackEnc ? densify(decodePolyline(d.trackEnc), 30) : [];
  const upd = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0;
  return {
    id, name: d.name, addedAt: d.addedAt,
    track,
    stops: stops.map((s) => [s.lat, s.lng]),
    stopNames: stops.map((s) => s.name || ""),
    timetable: d.timetable, operator: d.operator, capacity: d.capacity,
    specifiedRoute: d.specifiedRoute, note: d.note, contacts: d.contacts,
    category: d.category, session: d.session,
    _v: upd + ":" + (d.trackEnc ? d.trackEnc.length : 0) + ":" + (d.name || "") + ":" + stops.length
  };
}

/* ---------- boot ---------- */
if (!isConfigured) {
  setView("setup");
} else {
  if (isEmulator) {
    // Test hook, available ONLY on localhost with ?emulator=1
    window.__mc = { auth, db, signOut, getDoc, getDocs, doc, collection, query, where, setDoc, deleteDoc, updateDoc };
  }
  wireAuthForms();
  onAuthStateChanged(auth, (user) => {
    if (registering) return;               // registration finishes the session itself
    if (!user) { teardown(); setView("auth"); return; }
    startSession(user);
  });
}

async function startSession(user) {
  setView("boot");
  teardown();
  try {
    const ps = await getDoc(doc(db, "users", user.uid));
    if (!ps.exists()) {
      $("orphanEmail").textContent = user.email || "";
      setView("orphan");
      return;
    }
    const profile = ps.data();
    const cs = await getDoc(doc(db, "companies", profile.companyId));
    session.user = user; session.profile = profile; session.companyId = profile.companyId;
    session.company = cs.exists() ? cs.data() : { name: "Your company" };

    $("acctLine").textContent = (profile.name || user.email) + " · " + session.company.name +
      " · " + (profile.role === "admin" ? "Administrator" : "Driver");
    $("acctAdmin").style.display = profile.role === "admin" ? "" : "none";
    $("emptyAdminBtn").style.display = profile.role === "admin" ? "" : "none";
    if (profile.role === "admin") $("emptyMsg").textContent = "Your company has no routes yet. Add some from the Admin screen.";

    subscribeRoutes();
    if (profile.role === "admin") {
      initAdmin({ db, auth, user, profile, companyId: session.companyId, company: session.company, openDriver, signOutAndReset });
      showAdmin();
    } else {
      openDriver();
    }
  } catch (e) {
    console.error(e);
    setView("auth");
    $("authMsg").textContent = friendlyError(e);
  }
}

function subscribeRoutes() {
  session.unsubRoutes = onSnapshot(
    collection(db, "companies", session.companyId, "routes"),
    (snap) => {
      const raw = {}, fresh = {};
      snap.docs.forEach((d) => { raw[d.id] = d.data(); fresh[d.id] = docToRoute(d.id, d.data()); });
      window.RoundTracker.setRoutes(fresh);
      onRoutesChanged(raw);
    },
    (err) => { console.error(err); toast("Could not load routes: " + friendlyError(err), true); }
  );
}

function teardown() {
  if (session.unsubRoutes) { session.unsubRoutes(); session.unsubRoutes = null; }
}

export function openDriver() {
  setView("driver");
  window.RoundTracker.show();
}

async function signOutAndReset() {
  teardown();
  try { await signOut(auth); } catch (e) { /* ignore */ }
  // Clear the on-device Firestore cache so nothing from this company stays behind on a shared phone.
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) { /* ignore */ }
  location.reload();
}
$("acctSignOut").addEventListener("click", signOutAndReset);
$("orphanOut").addEventListener("click", signOutAndReset);
$("orphanRetry").addEventListener("click", () => auth.currentUser && startSession(auth.currentUser));
$("acctAdmin").addEventListener("click", () => { $("scrim").click(); showAdmin(); });
$("emptyAdminBtn").addEventListener("click", showAdmin);

/* ---------- sign in / register forms ---------- */
function wireAuthForms() {
  const msg = (t, ok) => { const m = $("authMsg"); m.textContent = t || ""; m.className = "form-msg" + (ok ? " ok" : ""); };
  const tab = (reg) => {
    $("segSignIn").classList.toggle("active", !reg);
    $("segRegister").classList.toggle("active", reg);
    $("signInForm").style.display = reg ? "none" : "";
    $("registerForm").style.display = reg ? "" : "none";
    msg("");
  };
  $("segSignIn").addEventListener("click", () => tab(false));
  $("segRegister").addEventListener("click", () => tab(true));

  $("signInForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    msg(""); $("siBtn").disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $("siEmail").value.trim(), $("siPass").value);
    } catch (e) { msg(friendlyError(e)); }
    $("siBtn").disabled = false;
  });

  $("forgotBtn").addEventListener("click", async () => {
    const email = $("siEmail").value.trim();
    if (!email) { msg("Type your email address above first, then tap “Forgot password?”."); return; }
    try { await sendPasswordResetEmail(auth, email); msg("If that email has an account, a password-reset link is on its way.", true); }
    catch (e) { msg(friendlyError(e)); }
  });

  $("registerForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    msg(""); $("rgBtn").disabled = true;
    const companyName = $("rgCompany").value.trim(), email = $("rgEmail").value.trim(), pass = $("rgPass").value;
    const name = $("rgName").value.trim();
    if (!companyName) { msg("Please enter your company name."); $("rgBtn").disabled = false; return; }
    registering = true;
    let cred = null;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, pass);
      const uid = cred.user.uid;
      const companyRef = doc(collection(db, "companies"));
      const batch = writeBatch(db);
      batch.set(companyRef, { name: companyName, ownerUid: uid, createdAt: serverTimestamp() });
      batch.set(doc(db, "users", uid), {
        companyId: companyRef.id, role: "admin", name: name || email.split("@")[0], email, createdAt: serverTimestamp()
      });
      await batch.commit();
      registering = false;
      await startSession(cred.user);
    } catch (e) {
      registering = false;
      console.error(e);
      msg(friendlyError(e));
      if (cred) { try { await cred.user.delete(); } catch (e2) { try { await signOut(auth); } catch (e3) { /* ignore */ } } }
    }
    $("rgBtn").disabled = false;
  });
}
