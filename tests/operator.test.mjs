// Unit tests for js/operator.js (operator-details helpers). Run: npm run test:geo (also runs this file)
import { test } from "node:test";
import assert from "node:assert/strict";
import { normOp, opEmpty, opEqual, validateOperator, routeIsCustom, resolveOperator, planApply } from "../js/operator.js";

const CO = { name: "Alpha Coaches", address: "1 High St", tel: "01792 1", email: "a@alpha.test" };

test("normOp trims, drops empties and unknown keys", () => {
  assert.deepEqual(normOp({ name: " X ", address: "", tel: "  ", email: "e@x.io", junk: 1 }), { name: "X", email: "e@x.io" });
  assert.deepEqual(normOp(undefined), {}); assert.ok(opEmpty(null)); assert.ok(opEmpty({ name: " " }));
  assert.ok(opEqual({ name: "X " }, { name: "X", tel: "" })); assert.ok(!opEqual({ name: "X" }, { name: "Y" }));
});

test("validateOperator: name required, email format, phone free text, limits", () => {
  assert.ok(validateOperator({ name: "" })); assert.ok(validateOperator({ name: "   ", tel: "1" })); assert.ok(validateOperator(null));
  assert.equal(validateOperator({ name: "A" }), null);
  assert.equal(validateOperator({ name: "A", tel: "ext 5 / +44 (0)1792 - after 9" }), null);
  assert.equal(validateOperator({ name: "A", email: "" }), null);
  assert.equal(validateOperator({ name: "A", email: "a@b.co" }), null);
  ["plain", "a@b", "@b.co", "a b@c.de", "a@@b.co"].forEach((e) => assert.ok(validateOperator({ name: "A", email: e }), e));
  assert.ok(validateOperator({ name: "x".repeat(121) })); assert.ok(validateOperator({ name: "A", address: "x".repeat(251) }));
  assert.ok(validateOperator({ name: "A", tel: "1".repeat(41) }));
});

test("routeIsCustom: flag wins; legacy routes are custom only if they differ from the company", () => {
  assert.equal(routeIsCustom({ operatorCustom: true, operator: CO }, CO), true);
  assert.equal(routeIsCustom({ operatorCustom: false, operator: { name: "Old" } }, CO), false);
  assert.equal(routeIsCustom({}, CO), false);
  assert.equal(routeIsCustom({ operator: CO }, CO), false);
  assert.equal(routeIsCustom({ operator: { name: "Other" } }, CO), true);
  assert.equal(routeIsCustom({ operator: { name: "Other" } }, {}), true);
});

test("resolveOperator: what drivers see", () => {
  assert.deepEqual(resolveOperator({}, CO), CO);                                              // no operator -> company
  assert.deepEqual(resolveOperator({ operator: {} }, CO), CO);
  assert.deepEqual(resolveOperator({ operator: { name: " " } }, CO), CO);
  assert.deepEqual(resolveOperator({ operator: { name: "Mine" }, operatorCustom: true }, CO), { name: "Mine" });
  assert.deepEqual(resolveOperator({ operator: { name: "Old Co" }, operatorCustom: false }, CO), CO);   // follows company -> current
  assert.deepEqual(resolveOperator({ operator: { name: "Legacy" } }, CO), { name: "Legacy" });
  assert.equal(resolveOperator({}, {}), undefined);
  assert.deepEqual(resolveOperator({ operator: { name: "Mine" }, operatorCustom: false }, {}), { name: "Mine" });
});

test("planApply: fill keeps custom routes; all overwrites them; routes already current are skipped", () => {
  const routes = {
    empty: { name: "e" },
    follow: { operator: { name: "Old" }, operatorCustom: false },
    current: { operator: CO, operatorCustom: false },
    custom: { operator: { name: "Mine" }, operatorCustom: true },
    legacy: { operator: { name: "Legacy" } },
    sameLegacy: { operator: CO }
  };
  const fill = planApply(routes, CO, "fill");
  assert.deepEqual(fill.targets.sort(), ["empty", "follow"]);
  assert.equal(fill.keptCustom, 2); assert.equal(fill.alreadyCurrent, 2); assert.equal(fill.total, 6);
  const all = planApply(routes, CO, "all");
  assert.deepEqual(all.targets.sort(), ["custom", "empty", "follow", "legacy"]);
  assert.equal(all.keptCustom, 0); assert.equal(all.alreadyCurrent, 2);
});
