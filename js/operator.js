/* Operator details (name / address / telephone / email) - pure helpers, no Firebase, unit-tested.

   The company has ONE default operator (companies/{cid}.operator). Every route may carry its own
   copy (routes/{id}.operator) plus a flag  operatorCustom:
     true  = the admin typed route-specific details ("Custom for this route")
     false = the route follows the company operator ("Using company operator details")
     absent (older routes) = custom if it has operator details that differ from the company's, else following.
   A route with NO operator details always falls back to the company operator (drivers' Schedule too). */

export const OP_LIMITS = { name: 120, address: 250, tel: 40, email: 120 };
const KEYS = ["name", "address", "tel", "email"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;      /* same shape as the Firestore rule */

/* trimmed copy with only the four known keys; empty values dropped */
export function normOp(o) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  KEYS.forEach((k) => {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  });
  return out;
}
export const opEmpty = (o) => Object.keys(normOp(o)).length === 0;
export function opEqual(a, b) {
  const x = normOp(a), y = normOp(b);
  return KEYS.every((k) => (x[k] || "") === (y[k] || ""));
}

/* null when valid, otherwise a human-readable message. name required, email format, tel free text. */
export function validateOperator(o) {
  const v = o || {};
  const name = String(v.name || "").trim(), email = String(v.email || "").trim();
  if (!name) return "Please enter the operator's name.";
  if (name.length > OP_LIMITS.name) return "Operator name is too long (max " + OP_LIMITS.name + " characters).";
  if (String(v.address || "").trim().length > OP_LIMITS.address) return "Address is too long (max " + OP_LIMITS.address + " characters).";
  if (String(v.tel || "").trim().length > OP_LIMITS.tel) return "Telephone is too long (max " + OP_LIMITS.tel + " characters).";
  if (email && email.length > OP_LIMITS.email) return "Email is too long (max " + OP_LIMITS.email + " characters).";
  if (email && !EMAIL_RE.test(email)) return "That email address doesn't look right (expected name@example.com).";
  return null;
}

/* Is this route's operator "custom" (route-specific)? */
export function routeIsCustom(route, companyOp) {
  if (route && route.operatorCustom === true) return true;
  if (route && route.operatorCustom === false) return false;
  const ro = normOp(route && route.operator);
  return Object.keys(ro).length > 0 && !opEqual(ro, companyOp);
}

/* What the driver should see: custom route details win; an empty route falls back to the company
   operator; a route that follows the company shows the company's CURRENT details. */
export function resolveOperator(route, companyOp) {
  const ro = normOp(route && route.operator), co = normOp(companyOp);
  const has = (o) => Object.keys(o).length > 0;
  if (!has(ro)) return has(co) ? co : undefined;
  if (routeIsCustom(route, co)) return ro;
  return has(co) ? co : ro;
}

/* Which routes would "Apply to all routes" change?
   mode "fill": routes with no operator + routes already following the company whose copy is out of date
                (custom routes are kept).
   mode "all" : every route that is not already exactly the company operator (custom ones are overwritten). */
export function planApply(routes, companyOp, mode) {
  const co = normOp(companyOp);
  const plan = { targets: [], keptCustom: 0, alreadyCurrent: 0, total: 0 };
  Object.keys(routes || {}).forEach((id) => {
    const r = routes[id];
    plan.total++;
    const current = opEqual(r.operator, co) && r.operatorCustom !== true;   // already shows the company details
    if (current) plan.alreadyCurrent++;
    else if (mode !== "all" && routeIsCustom(r, co)) plan.keptCustom++;
    else plan.targets.push(id);
  });
  return plan;
}
