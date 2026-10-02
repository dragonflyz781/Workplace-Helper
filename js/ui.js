export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
export function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast" + (isErr ? " err" : ""); }, isErr ? 6000 : 3200);
}

/* view: boot | setup | auth | orphan | admin | editor | driver */
export function setView(name) {
  document.body.className = document.body.className.replace(/\bview-\S+/g, "").trim() + " view-" + name;
}

export function friendlyError(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-password": "Please enter a password.",
    "auth/weak-password": "Password is too weak - use at least 6 characters.",
    "auth/email-already-in-use": "There is already an account with that email address.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
    "auth/network-request-failed": "Can't reach the server - check your internet connection.",
    "auth/operation-not-allowed": "Email/password sign-in isn't switched on in your Firebase project (Authentication -> Sign-in method).",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Can't reach the server - check your internet connection."
  };
  return map[code] || (e && e.message) || "Something went wrong.";
}

/* Theme toggle that shares the driver app's saved preference (localStorage 'rt_theme'). */
export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : cur === "light" ? null :
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
  if (next) document.documentElement.setAttribute("data-theme", next); else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("rt_theme", next || ""); } catch (e) { /* ignore */ }
}
