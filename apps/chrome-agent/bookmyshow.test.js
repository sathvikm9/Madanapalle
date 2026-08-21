import assert from "node:assert/strict";
import test from "node:test";

await import("./bookmyshow.js");
const {
  enabledTicketOptions,
  singleTicketOption,
  isFullySold,
  layoutSignature,
  completeFromVerifiedLayout
} = globalThis.SKCTBookMyShow;

function select(options) {
  return { options: options.map((option) => ({ disabled: false, label: "", textContent: "", ...option })) };
}

test("recognizes a usable one-ticket option without depending on its exact value", () => {
  const quantity = select([
    { value: "", label: "Select Quantity" },
    { value: "ticket-1", label: "1 Ticket" }
  ]);
  assert.equal(enabledTicketOptions(quantity).length, 1);
  assert.equal(singleTicketOption(quantity).value, "ticket-1");
});

test("recognizes a BookMyShow quantity control with no selectable tickets", () => {
  const quantity = select([
    { value: "", label: "Select Quantity" },
    { value: "1", label: "1 Ticket", disabled: true }
  ]);
  assert.equal(enabledTicketOptions(quantity).length, 0);
  assert.equal(singleTicketOption(quantity), null);
});

test("requires every real seat in every category to be sold", () => {
  const full = [
    { name: "BALCONY", price: 105, capacity: 132, available: 0, sold: 132, unknown: 0 },
    { name: "SECOND CLASS", price: 84, capacity: 180, available: 0, sold: 180, unknown: 0 }
  ];
  assert.equal(isFullySold(full), true);
  assert.equal(isFullySold([{ ...full[0], available: 1, sold: 131 }]), false);
  assert.equal(isFullySold([]), false);
  assert.equal(layoutSignature(full), layoutSignature(full.map((category) => ({ ...category, sold: 0, available: category.capacity }))));
});

test("restores BookMyShow classes and rows omitted because they are sold out", () => {
  const advertised = [
    { name: "BALCONY", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "RESERVED", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "FIRST CLASS", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "SECOND CLASS", listPricePaise: 8400, availabilityStatus: "3" }
  ];
  const result = completeFromVerifiedLayout("RTDM", advertised, [
    { name: "SECOND CLASS", price: 84, capacity: 92, available: 15, sold: 77, unknown: 0 }
  ]);
  assert.deepEqual(result.map(({ name, capacity, available, sold }) => ({ name, capacity, available, sold })), [
    { name: "BALCONY", capacity: 132, available: 0, sold: 132 },
    { name: "RESERVED", capacity: 213, available: 0, sold: 213 },
    { name: "FIRST CLASS", capacity: 112, available: 0, sold: 112 },
    { name: "SECOND CLASS", capacity: 180, available: 15, sold: 165 }
  ]);
  assert.equal(isFullySold(result), false);
});

test("builds an exact full Ravi show when every advertised class is sold out", () => {
  const result = completeFromVerifiedLayout("RTDM", [
    { name: "BALCONY", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "RESERVED", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "FIRST CLASS", listPricePaise: 10500, availabilityStatus: "0" },
    { name: "SECOND CLASS", listPricePaise: 8400, availabilityStatus: "0" }
  ], []);
  assert.equal(isFullySold(result), true);
  assert.equal(result.reduce((sum, category) => sum + category.sold, 0), 637);
  assert.equal(result.reduce((sum, category) => sum + category.sold * (category.price - 5), 0), 59_920);
});

test("rejects a missing BookMyShow class unless the session marks it sold out", () => {
  const advertised = [
    { name: "RESERVED", listPricePaise: 10500, availabilityStatus: "2" },
    { name: "SECOND CLASS", listPricePaise: 8400, availabilityStatus: "3" }
  ];
  assert.throws(
    () => completeFromVerifiedLayout("ASRM", advertised, [{ name: "SECOND CLASS", capacity: 134, available: 134, sold: 0, unknown: 0 }]),
    /disappeared without BookMyShow marking it sold out/
  );
});
