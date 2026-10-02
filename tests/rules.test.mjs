// Firestore rules tests. Run with:  npm run test:rules
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, writeBatch,
  collectionGroup, serverTimestamp
} from "firebase/firestore";

let env;
const ts = () => new Date();
before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-multico-rules",
    firestore: { host, port: Number(port), rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") }
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "companies/A"), { name: "Alpha Coaches", ownerUid: "adminA", createdAt: ts() });
    await setDoc(doc(d, "companies/B"), { name: "Bravo Buses", ownerUid: "adminB", createdAt: ts() });
    await setDoc(doc(d, "users/adminA"),  { companyId: "A", role: "admin",  name: "Ann",  email: "a@a.com", createdAt: ts() });
    await setDoc(doc(d, "users/driverA"), { companyId: "A", role: "driver", name: "Dave", email: "d@a.com", createdAt: ts() });
    await setDoc(doc(d, "users/adminB"),  { companyId: "B", role: "admin",  name: "Bob",  email: "b@b.com", createdAt: ts() });
    await setDoc(doc(d, "users/driverB"), { companyId: "B", role: "driver", name: "Dee",  email: "d@b.com", createdAt: ts() });
    await setDoc(doc(d, "companies/A/routes/r1"), { name: "A route", trackEnc: "_p~iF~ps|U" });
    await setDoc(doc(d, "companies/B/routes/r1"), { name: "B route", trackEnc: "_p~iF~ps|U" });
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const newRoute = { name: "New", trackEnc: "abc", stops: [] };

test("unauthenticated users can read nothing", async () => {
  await assertFails(getDoc(doc(anon(), "companies/A/routes/r1")));
  await assertFails(getDoc(doc(anon(), "companies/A")));
  await assertFails(getDoc(doc(anon(), "users/adminA")));
  await assertFails(getDocs(collection(anon(), "companies/A/routes")));
});

test("signed-in user WITHOUT a profile can read nothing and write nothing", async () => {
  const d = as("stranger");
  await assertFails(getDoc(doc(d, "companies/A/routes/r1")));
  await assertFails(getDoc(doc(d, "companies/A")));
  await assertFails(setDoc(doc(d, "companies/A/routes/x"), newRoute));
});

test("driver: can read own company's routes and company doc", async () => {
  const d = as("driverA");
  await assertSucceeds(getDoc(doc(d, "companies/A/routes/r1")));
  await assertSucceeds(getDocs(collection(d, "companies/A/routes")));
  await assertSucceeds(getDoc(doc(d, "companies/A")));
});

test("driver: cannot create / update / delete routes", async () => {
  const d = as("driverA");
  await assertFails(setDoc(doc(d, "companies/A/routes/new"), newRoute));
  await assertFails(updateDoc(doc(d, "companies/A/routes/r1"), { name: "hacked" }));
  await assertFails(deleteDoc(doc(d, "companies/A/routes/r1")));
});

test("driver: cannot see other company's data", async () => {
  const d = as("driverA");
  await assertFails(getDoc(doc(d, "companies/B/routes/r1")));
  await assertFails(getDocs(collection(d, "companies/B/routes")));
  await assertFails(getDoc(doc(d, "companies/B")));
  await assertFails(getDocs(collectionGroup(d, "routes")));
});

test("admin: full CRUD on own company's routes", async () => {
  const d = as("adminA");
  await assertSucceeds(setDoc(doc(d, "companies/A/routes/new"), newRoute));
  await assertSucceeds(updateDoc(doc(d, "companies/A/routes/new"), { name: "Renamed" }));
  await assertSucceeds(getDoc(doc(d, "companies/A/routes/new")));
  await assertSucceeds(deleteDoc(doc(d, "companies/A/routes/new")));
});

test("admin: cannot read or write another company's routes", async () => {
  const d = as("adminA");
  await assertFails(getDoc(doc(d, "companies/B/routes/r1")));
  await assertFails(getDocs(collection(d, "companies/B/routes")));
  await assertFails(setDoc(doc(d, "companies/B/routes/evil"), newRoute));
  await assertFails(updateDoc(doc(d, "companies/B/routes/r1"), { name: "x" }));
  await assertFails(deleteDoc(doc(d, "companies/B/routes/r1")));
});

test("users collection: own profile readable; others only by admins of the same company", async () => {
  await assertSucceeds(getDoc(doc(as("driverA"), "users/driverA")));
  await assertFails(getDoc(doc(as("driverA"), "users/adminA")));
  await assertFails(getDocs(query(collection(as("driverA"), "users"), where("companyId", "==", "A"))));
  await assertSucceeds(getDocs(query(collection(as("adminA"), "users"), where("companyId", "==", "A"))));
  await assertSucceeds(getDoc(doc(as("adminA"), "users/driverA")));
  await assertFails(getDoc(doc(as("adminA"), "users/driverB")));
  await assertFails(getDocs(query(collection(as("adminA"), "users"), where("companyId", "==", "B"))));
  await assertFails(getDocs(collection(as("adminA"), "users")));        // unfiltered list
});

test("admin can add a driver to own company only", async () => {
  const d = as("adminA");
  const base = { companyId: "A", role: "driver", name: "New", email: "n@a.com", createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(d, "users/newDriver"), base));
  await assertFails(setDoc(doc(d, "users/x1"), { ...base, companyId: "B" }));          // other company
  await assertFails(setDoc(doc(d, "users/x2"), { ...base, role: "admin" }));          // no new admins
  await assertFails(setDoc(doc(d, "users/x3"), { ...base, isSuper: true }));          // extra field
});

test("driver cannot add users", async () => {
  const base = { companyId: "A", role: "driver", name: "New", email: "n@a.com", createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(as("driverA"), "users/x1"), base));
});

test("nobody can promote themselves or change roles/companies", async () => {
  await assertFails(updateDoc(doc(as("driverA"), "users/driverA"), { role: "admin" }));
  await assertFails(updateDoc(doc(as("driverA"), "users/driverA"), { companyId: "B" }));
  await assertFails(updateDoc(doc(as("adminA"), "users/driverA"), { role: "admin" }));
  await assertFails(updateDoc(doc(as("adminA"), "users/driverA"), { companyId: "B" }));
  await assertSucceeds(updateDoc(doc(as("adminA"), "users/driverA"), { name: "Dave R." }));
  await assertFails(updateDoc(doc(as("adminA"), "users/driverB"), { name: "x" }));       // other company
});

test("admin can remove a driver, but not themselves or other companies' users", async () => {
  await assertFails(deleteDoc(doc(as("adminA"), "users/adminA")));
  await assertFails(deleteDoc(doc(as("adminA"), "users/driverB")));
  await assertFails(deleteDoc(doc(as("driverA"), "users/adminA")));
  await assertSucceeds(deleteDoc(doc(as("adminA"), "users/driverA")));
});

test("registration: new user creates company + own admin profile in one batch", async () => {
  const d = as("newOwner");
  const b = writeBatch(d);
  b.set(doc(d, "companies/C"), { name: "Charlie Travel", ownerUid: "newOwner", createdAt: serverTimestamp() });
  b.set(doc(d, "users/newOwner"), { companyId: "C", role: "admin", name: "Cat", email: "c@c.com", createdAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  await assertSucceeds(getDoc(doc(d, "companies/C")));
  await assertSucceeds(setDoc(doc(d, "companies/C/routes/r"), newRoute));
});

test("registration abuse: cannot join / take over an existing company", async () => {
  const d = as("mallory");
  // admin profile pointing at existing company B
  await assertFails(setDoc(doc(d, "users/mallory"), { companyId: "B", role: "admin", name: "M", email: "m@m.com", createdAt: serverTimestamp() }));
  // company that already exists, re-created with Mallory as owner
  const b = writeBatch(d);
  b.set(doc(d, "companies/B"), { name: "Bravo Buses", ownerUid: "mallory", createdAt: serverTimestamp() });
  b.set(doc(d, "users/mallory"), { companyId: "B", role: "admin", name: "M", email: "m@m.com", createdAt: serverTimestamp() });
  await assertFails(b.commit());
  // owner uid that is not yourself
  await assertFails(setDoc(doc(d, "companies/D"), { name: "D", ownerUid: "someoneElse", createdAt: serverTimestamp() }));
  // profile for another uid
  await assertFails(setDoc(doc(d, "users/other"), { companyId: "D", role: "admin", name: "x", email: "x", createdAt: serverTimestamp() }));
  // driver role via the self-registration path
  const b2 = writeBatch(d);
  b2.set(doc(d, "companies/E"), { name: "E", ownerUid: "mallory", createdAt: serverTimestamp() });
  b2.set(doc(d, "users/mallory"), { companyId: "E", role: "driver", name: "M", email: "m", createdAt: serverTimestamp() });
  await assertFails(b2.commit());
});

test("an existing user (with profile) cannot create another company", async () => {
  await assertFails(setDoc(doc(as("adminA"), "companies/Z"), { name: "Z", ownerUid: "adminA", createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as("driverA"), "companies/Z"), { name: "Z", ownerUid: "driverA", createdAt: serverTimestamp() }));
});

test("company doc: admin can rename, nobody can delete or change owner, drivers can't rename", async () => {
  await assertSucceeds(updateDoc(doc(as("adminA"), "companies/A"), { name: "Alpha Coaches Ltd" }));
  await assertFails(updateDoc(doc(as("adminA"), "companies/A"), { ownerUid: "driverA" }));
  await assertFails(updateDoc(doc(as("driverA"), "companies/A"), { name: "x" }));
  await assertFails(updateDoc(doc(as("adminA"), "companies/B"), { name: "x" }));
  await assertFails(deleteDoc(doc(as("adminA"), "companies/A")));
});

test("unknown collections are closed", async () => {
  await assertFails(setDoc(doc(as("adminA"), "secrets/x"), { a: 1 }));
  await assertFails(getDoc(doc(as("adminA"), "secrets/x")));
});

/* ------------------------------------------------------------------ runs (submitted driver runs) */
const mkRun = (uid, extra = {}) => ({
  routeId: "r1", routeName: "A route", session: "AM", driverUid: uid, driverName: "Dave",
  startedAt: new Date(), submittedAt: serverTimestamp(),
  totalBoarded: 5, totalAlighted: 2, unscheduledBoarded: 1, unscheduledAlighted: 0,
  stops: [{ index: 0, name: "Stop 1", boarded: 4, alighted: 2 }],
  ...extra
});
const seedRun = async (path, uid = "driverA", extra = {}) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), { ...mkRun(uid, extra), submittedAt: new Date() });
  });
};

test("runs: driver can create a run for own company with own uid", async () => {
  await assertSucceeds(setDoc(doc(as("driverA"), "companies/A/runs/run1"), mkRun("driverA")));
});

test("runs: admin (driving) can also create a run with own uid", async () => {
  await assertSucceeds(setDoc(doc(as("adminA"), "companies/A/runs/run1"), mkRun("adminA")));
});

test("runs: driverUid must equal the signed-in uid (no impersonation)", async () => {
  await assertFails(setDoc(doc(as("driverA"), "companies/A/runs/x1"), mkRun("adminA")));
  await assertFails(setDoc(doc(as("adminA"), "companies/A/runs/x2"), mkRun("driverA")));
});

test("runs: cross-company create is denied (driver and admin of B cannot write into A, nor A into B)", async () => {
  await assertFails(setDoc(doc(as("driverB"), "companies/A/runs/x1"), mkRun("driverB")));
  await assertFails(setDoc(doc(as("adminB"), "companies/A/runs/x2"), mkRun("adminB")));
  await assertFails(setDoc(doc(as("driverA"), "companies/B/runs/x3"), mkRun("driverA")));
  await assertFails(setDoc(doc(as("stranger"), "companies/A/runs/x4"), mkRun("stranger")));
  await assertFails(setDoc(doc(anon(), "companies/A/runs/x5"), mkRun("driverA")));
});

test("runs: restricted key set (no extra fields, no missing fields, correct types)", async () => {
  const d = as("driverA");
  await assertFails(setDoc(doc(d, "companies/A/runs/k1"), mkRun("driverA", { isAdmin: true })));          // extra key
  await assertFails(setDoc(doc(d, "companies/A/runs/k2"), mkRun("driverA", { companyId: "A" })));         // extra key
  const { stops, ...noStops } = mkRun("driverA");
  await assertFails(setDoc(doc(d, "companies/A/runs/k3"), noStops));                                      // missing key
  await assertFails(setDoc(doc(d, "companies/A/runs/k4"), mkRun("driverA", { totalBoarded: "5" })));      // wrong type
  await assertFails(setDoc(doc(d, "companies/A/runs/k5"), mkRun("driverA", { totalBoarded: -1 })));       // negative
  await assertFails(setDoc(doc(d, "companies/A/runs/k6"), mkRun("driverA", { totalBoarded: 1e7 })));      // absurd
  await assertFails(setDoc(doc(d, "companies/A/runs/k7"), mkRun("driverA", { stops: "none" })));          // not a list
  await assertFails(setDoc(doc(d, "companies/A/runs/k8"), mkRun("driverA", { startedAt: "yesterday" }))); // not a timestamp
});

test("runs: sane size limits (names, stops list, session)", async () => {
  const d = as("driverA");
  await assertFails(setDoc(doc(d, "companies/A/runs/s1"), mkRun("driverA", { routeName: "x".repeat(201) })));
  await assertFails(setDoc(doc(d, "companies/A/runs/s2"), mkRun("driverA", { driverName: "x".repeat(121) })));
  await assertFails(setDoc(doc(d, "companies/A/runs/s3"), mkRun("driverA", { session: "morning-and-more" })));
  await assertFails(setDoc(doc(d, "companies/A/runs/s4"), mkRun("driverA", { routeId: "" })));
  const many = Array.from({ length: 501 }, (_, i) => ({ index: i, name: "s", boarded: 0, alighted: 0 }));
  await assertFails(setDoc(doc(d, "companies/A/runs/s5"), mkRun("driverA", { stops: many })));
  const ok = Array.from({ length: 500 }, (_, i) => ({ index: i, name: "s", boarded: 0, alighted: 0 }));
  await assertSucceeds(setDoc(doc(d, "companies/A/runs/s6"), mkRun("driverA", { stops: ok })));
});

test("runs: submittedAt must be the server time (cannot back-date)", async () => {
  await assertFails(setDoc(doc(as("driverA"), "companies/A/runs/t1"), mkRun("driverA", { submittedAt: new Date("2020-01-01") })));
});

test("runs: nobody can update a run (driver, owner-driver, admin, other company)", async () => {
  await seedRun("companies/A/runs/u1");
  await assertFails(updateDoc(doc(as("driverA"), "companies/A/runs/u1"), { totalBoarded: 999 }));
  await assertFails(updateDoc(doc(as("adminA"), "companies/A/runs/u1"), { totalBoarded: 999 }));
  await assertFails(updateDoc(doc(as("adminB"), "companies/A/runs/u1"), { totalBoarded: 999 }));
  // overwriting with set() on an existing id is an update too
  await assertFails(setDoc(doc(as("driverA"), "companies/A/runs/u1"), mkRun("driverA", { totalBoarded: 999 })));
});

test("runs: admin reads all runs of own company; driver only their own; other companies nothing", async () => {
  await seedRun("companies/A/runs/mine", "driverA");
  await seedRun("companies/A/runs/admins", "adminA");
  await seedRun("companies/B/runs/b1", "driverB");
  // admin A: everything in A
  const all = await assertSucceeds(getDocs(collection(as("adminA"), "companies/A/runs")));
  assert.equal(all.size, 2);
  await assertSucceeds(getDoc(doc(as("adminA"), "companies/A/runs/mine")));
  // driver A: own only
  await assertSucceeds(getDoc(doc(as("driverA"), "companies/A/runs/mine")));
  await assertFails(getDoc(doc(as("driverA"), "companies/A/runs/admins")));
  await assertFails(getDocs(collection(as("driverA"), "companies/A/runs")));                                  // unfiltered list
  const own = await assertSucceeds(getDocs(query(collection(as("driverA"), "companies/A/runs"), where("driverUid", "==", "driverA"))));
  assert.equal(own.size, 1);
  await assertFails(getDocs(query(collection(as("driverA"), "companies/A/runs"), where("driverUid", "==", "adminA"))));
  // cross-company reads denied, incl. collection-group queries
  await assertFails(getDoc(doc(as("adminB"), "companies/A/runs/mine")));
  await assertFails(getDocs(collection(as("adminB"), "companies/A/runs")));
  await assertFails(getDoc(doc(as("driverB"), "companies/A/runs/mine")));
  await assertFails(getDocs(collection(as("adminA"), "companies/B/runs")));
  await assertFails(getDoc(doc(as("stranger"), "companies/A/runs/mine")));
  await assertFails(getDoc(doc(anon(), "companies/A/runs/mine")));
  await assertFails(getDocs(collectionGroup(as("adminA"), "runs")));
});

test("runs: only admins of the company may delete runs", async () => {
  await seedRun("companies/A/runs/d1"); await seedRun("companies/A/runs/d2"); await seedRun("companies/A/runs/d3");
  await assertFails(deleteDoc(doc(as("driverA"), "companies/A/runs/d1")));     // even the run's own driver
  await assertFails(deleteDoc(doc(as("adminB"), "companies/A/runs/d1")));     // other company's admin
  await assertFails(deleteDoc(doc(as("driverB"), "companies/A/runs/d1")));
  await assertSucceeds(deleteDoc(doc(as("adminA"), "companies/A/runs/d1")));
});
