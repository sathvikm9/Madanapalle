(function attachBookMyShowHelpers(root) {
  const VERIFIED_LAYOUTS = Object.freeze({
    SKMD: Object.freeze([
      Object.freeze({ name: "RESERVED CLASS", capacity: 493 }),
      Object.freeze({ name: "SECOND CLASS", capacity: 164 })
    ]),
    RTDM: Object.freeze([
      Object.freeze({ name: "BALCONY", capacity: 132 }),
      Object.freeze({ name: "RESERVED", capacity: 213 }),
      Object.freeze({ name: "FIRST CLASS", capacity: 112 }),
      Object.freeze({ name: "SECOND CLASS", capacity: 180 })
    ]),
    ASRM: Object.freeze([
      Object.freeze({ name: "RESERVED", capacity: 386 }),
      Object.freeze({ name: "SECOND CLASS", capacity: 134 })
    ])
  });

  const normalizedName = (value) => String(value || "").trim().toUpperCase();

  function enabledTicketOptions(select) {
    return Array.from(select?.options || []).filter((option) => option.value && !option.disabled);
  }

  function singleTicketOption(select) {
    const options = enabledTicketOptions(select);
    return options.find((option) => {
      const text = `${option.label || ""} ${option.textContent || ""}`.trim();
      return option.value === "1" || Number(option.value) === 1 || /(^|\D)1(\D|$)/.test(text);
    }) || options[0] || null;
  }

  function isFullySold(categories) {
    return Array.isArray(categories) && categories.length > 0 && categories.every((category) => (
      Number(category.capacity) > 0 &&
      Number(category.available) === 0 &&
      Number(category.unknown) === 0 &&
      Number(category.sold) === Number(category.capacity)
    ));
  }

  function layoutSignature(categories) {
    if (!Array.isArray(categories) || !categories.length) return "layout-unavailable";
    return JSON.stringify(categories.map((category) => ({
      name: String(category.name || "").trim().toUpperCase(),
      price: Number(category.price || 0),
      capacity: Number(category.capacity || 0)
    })));
  }

  function completeFromVerifiedLayout(venueCode, advertisedCategories, observedCategories) {
    const layout = VERIFIED_LAYOUTS[venueCode];
    if (!layout) throw new Error(`No verified BookMyShow layout exists for ${venueCode}`);
    const advertised = new Map((advertisedCategories || []).map((category) => [normalizedName(category.name), category]));
    const observed = new Map((observedCategories || []).map((category) => [normalizedName(category.name), category]));
    if (advertised.size !== layout.length || layout.some((category) => !advertised.has(category.name))) {
      throw new Error(`BookMyShow categories no longer match the verified ${venueCode} layout`);
    }

    return layout.map((expected) => {
      const live = observed.get(expected.name);
      const listing = advertised.get(expected.name);
      if (!live && String(listing.availabilityStatus) !== "0") {
        throw new Error(`${expected.name} disappeared without BookMyShow marking it sold out`);
      }
      if (live && Number(live.capacity) > expected.capacity) {
        throw new Error(`${expected.name} exposed more seats than the verified layout`);
      }
      const observedCapacity = Number(live?.capacity || 0);
      const omittedSold = expected.capacity - observedCapacity;
      return {
        name: expected.name,
        price: Number(listing.listPricePaise || 0) / 100,
        capacity: expected.capacity,
        available: Number(live?.available || 0),
        sold: Number(live?.sold || 0) + omittedSold,
        unknown: Number(live?.unknown || 0)
      };
    });
  }

  root.SKCTBookMyShow = {
    VERIFIED_LAYOUTS,
    enabledTicketOptions,
    singleTicketOption,
    isFullySold,
    layoutSignature,
    completeFromVerifiedLayout
  };
})(globalThis);
