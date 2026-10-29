import assert from "node:assert/strict";
import test from "node:test";

await import("./bookmyshow.js");
const {
  enabledTicketOptions,
  normalizedControlText,
  findSelectSeatsControl,
  findOneTicketControl,
  singleTicketOption,
  selectedTicketCount,
  isFullySold,
  layoutSignature,
  completeFromVerifiedLayout,
  recoveryAction
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

test("recognizes an already-selected BookMyShow ticket quantity without matching unrelated labels", () => {
  assert.equal(selectedTicketCount("2 Tickets"), 2);
  assert.equal(selectedTicketCount("1 Ticket"), 1);
  assert.equal(selectedTicketCount({
    getAttribute: (name) => name === "aria-label" ? "4 Tickets" : null,
    textContent: "Change quantity"
  }), 4);
  assert.equal(selectedTicketCount({
    getAttribute: (name) => name === "aria-label" ? "Change ticket quantity" : null,
    textContent: "2 Tickets"
  }), 2);
  assert.equal(selectedTicketCount("02:00 PM ATMOS 4K"), null);
  assert.equal(selectedTicketCount("Buy 2 Tickets"), null);
});

test("recognizes both modern BookMyShow modal controls without exact whitespace or element types", () => {
  const controls = [
    { getAttribute: () => null, textContent: "  Select\n Seats  " },
    { getAttribute: (name) => name === "aria-label" ? "1 Ticket" : null, textContent: "" },
    { getAttribute: () => null, textContent: "2" }
  ];
  assert.equal(normalizedControlText(controls[0]), "Select Seats");
  assert.equal(findSelectSeatsControl(controls), controls[0]);
  assert.equal(findOneTicketControl(controls), controls[1]);
  assert.ok(findSelectSeatsControl([{ getAttribute: () => "Select Seats button", textContent: "" }]));
  assert.ok(findOneTicketControl([{ getAttribute: () => "Select 1 seat", textContent: "" }]));
});

test("recognizes BookMyShow's list-item quantity even when its DOM value defaults to zero", () => {
  const quantityOne = {
    id: "quantity-1",
    value: 0,
    textContent: "1",
    getAttribute: () => null
  };
  assert.equal(normalizedControlText(quantityOne), "1");
  assert.equal(findOneTicketControl([quantityOne]), quantityOne);
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

test("uses Mini Siddartha's verified 272-seat layout", () => {
  const advertised = [
    { name: "Gold Class", listPricePaise: 10500, availabilityStatus: "3" },
    { name: "Silver Class", listPricePaise: 8400, availabilityStatus: "3" }
  ];
  const result = completeFromVerifiedLayout("MSDR", advertised, [
    { name: "GOLD CLASS", price: 105, capacity: 238, available: 200, sold: 38, unknown: 0 },
    { name: "SILVER CLASS", price: 84, capacity: 34, available: 30, sold: 4, unknown: 0 }
  ]);

  assert.deepEqual(result.map(({ name, capacity, available, sold }) => ({ name, capacity, available, sold })), [
    { name: "GOLD CLASS", capacity: 238, available: 200, sold: 38 },
    { name: "SILVER CLASS", capacity: 34, available: 30, sold: 4 }
  ]);
  assert.equal(result.reduce((sum, category) => sum + category.capacity, 0), 272);
});

test("recovery resumes from the furthest usable BookMyShow control", () => {
  assert.equal(recoveryAction({
    quantity: {}, categorySelect: {}, rowSelect: {}, accessibility: {}, selectSeats: {}
  }), "ready");
  assert.equal(recoveryAction({ categorySelect: {}, rowSelect: {} }), "seat_controls_ready");
  assert.equal(recoveryAction({ quantity: {}, accessibility: {}, selectSeats: {} }), "click_select_seats");
  assert.equal(recoveryAction({ oneTicket: {}, selectSeats: {} }), "click_one_ticket");
  assert.equal(recoveryAction({ categorySelect: {}, accessibility: {} }), "wait_seat_controls");
  assert.equal(recoveryAction({ selectedQuantity: {}, accessibility: {}, selectSeats: {} }), "click_select_seats");
  assert.equal(recoveryAction({ accessibility: {}, selectSeats: {} }), "click_select_seats");
  assert.equal(recoveryAction({ selectSeats: {} }), "click_select_seats");
  assert.equal(recoveryAction({ visualSeatMap: true }), "visual_seat_map_without_accessibility_controls");
  assert.equal(recoveryAction({}), "wait_booking_entry_control");
});
