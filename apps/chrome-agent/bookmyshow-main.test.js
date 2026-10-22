import assert from "node:assert/strict";
import test from "node:test";

await import("./bookmyshow-main.js");
const { invokeReactClick, performAction, setRangeValue } = globalThis.SKCTBookMyShowMain;

test("invokes BookMyShow's current React click handler directly", () => {
  const control = { id: "quantity-1" };
  let received = null;
  control.__reactProps$test = {
    onClick(event) { received = event; }
  };
  assert.equal(invokeReactClick(control), true);
  assert.equal(received.currentTarget, control);
  assert.equal(received.target, control);
});

test("selects one ticket through BookMyShow's React quantity handler", () => {
  let calls = 0;
  const quantityOne = {
    id: "quantity-1",
    __reactProps$test: { onClick() { calls += 1; } }
  };
  const documentRef = {
    querySelector(selector) {
      return selector === "#quantity-1" ? quantityOne : null;
    }
  };
  assert.deepEqual(performAction(documentRef, "set_quantity_one"), {
    ok: true,
    control: "quantity-1"
  });
  assert.equal(calls, 1);
});

test("activates Select Seats through the main-world React handler", () => {
  let calls = 0;
  const button = {
    textContent: "Select Seats",
    getAttribute: () => null,
    __reactProps$test: { onClick() { calls += 1; } }
  };
  const documentRef = {
    querySelectorAll: () => [button],
    querySelector: () => null
  };
  assert.deepEqual(performAction(documentRef, "select_seats"), {
    ok: true,
    control: "select_seats"
  });
  assert.equal(calls, 1);
});

test("falls back to BookMyShow's quantity range when the list item is absent", () => {
  const events = [];
  const previousInput = globalThis.HTMLInputElement;
  const previousEvent = globalThis.Event;
  class Input {}
  Object.defineProperty(Input.prototype, "value", {
    set(value) { this.storedValue = value; }
  });
  globalThis.HTMLInputElement = Input;
  globalThis.Event = class {
    constructor(type) { this.type = type; }
  };
  try {
    const range = new Input();
    range.dispatchEvent = (event) => events.push(event.type);
    const documentRef = {
      querySelector(selector) {
        if (selector === "#quantity-1") return null;
        if (selector === 'input[type="range"]') return range;
        return null;
      }
    };
    assert.equal(performAction(documentRef, "set_quantity_one").ok, true);
    assert.equal(range.storedValue, "1");
    assert.deepEqual(events, ["input", "change"]);
    assert.equal(setRangeValue(null, "1"), false);
  } finally {
    globalThis.HTMLInputElement = previousInput;
    globalThis.Event = previousEvent;
  }
});
