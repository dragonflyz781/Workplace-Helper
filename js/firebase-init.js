/* Loads the Firebase modular SDK from Google's CDN and creates the app,
   Auth and Firestore handles used by the rest of the site.
   No build step: the browser imports these URLs directly.            */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, connectFirestoreEmulator,
  persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig as userConfig } from "./firebase-config.js";

/* Emulator mode is only honoured on localhost, e.g. http://localhost:5000/?emulator=1
   It lets you try the whole app with fake data and no Firebase project at all. */
export const isEmulator =
  new URLSearchParams(location.search).has("emulator") &&
  ["localhost", "127.0.0.1"].includes(location.hostname);

export const isConfigured = isEmulator || !String(userConfig.apiKey || "").startsWith("PASTE");

export const firebaseConfig = isEmulator
  ? { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-multico", appId: "demo" }
  : userConfig;

const EMU_HOST = "127.0.0.1";
export const EMU = { auth: "http://" + EMU_HOST + ":9099", fsHost: EMU_HOST, fsPort: 8080 };

export let app = null, auth = null, db = null;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    // Offline cache: the driver's routes keep working in patchy signal.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    console.warn("Persistent cache unavailable, using memory cache", e);
    db = getFirestore(app);
  }
  if (isEmulator) {
    connectAuthEmulator(auth, EMU.auth, { disableWarnings: true });
    connectFirestoreEmulator(db, EMU.fsHost, EMU.fsPort);
  }
}

/* A second, throw-away Firebase app instance. The admin uses it to create a
   driver's login without being signed out of their own session (creating a
   user always signs that user in on the instance used). */
export async function createSecondaryAuth() {
  const { getApps, getApp, initializeApp: init } =
    await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js");
  const existing = getApps().find((a) => a.name === "secondary");
  const sec = existing || init(firebaseConfig, "secondary");
  const sAuth = getAuth(sec);
  if (isEmulator && !existing) connectAuthEmulator(sAuth, EMU.auth, { disableWarnings: true });
  return sAuth;
}
