export function rupeesToPaise(value) {
  const numeric = Number(String(value ?? 0).replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

export function netTicketPricePaise(listPricePaise) {
  return Math.max(Number(listPricePaise || 0) - 500, 0);
}

export function calculateCollection(categories) {
  const normalized = (categories || []).map((category) => {
    const capacity = Math.max(Number(category.capacity || 0), 0);
    const available = Math.max(Number(category.available || 0), 0);
    const sold = Math.max(Number(category.sold ?? capacity - available), 0);
    const unknown = Math.max(Number(category.unknown || 0), 0);
    const listPricePaise = Number(
      category.listPricePaise ?? rupeesToPaise(category.price ?? category.listPrice)
    );
    const netPricePaise = netTicketPricePaise(listPricePaise);

    return {
      name: category.name || "Category",
      listPricePaise,
      netPricePaise,
      capacity,
      available,
      sold,
      unknown,
      collectionPaise: sold * netPricePaise
    };
  });

  const totals = normalized.reduce(
    (result, category) => ({
      capacity: result.capacity + category.capacity,
      available: result.available + category.available,
      sold: result.sold + category.sold,
      unknown: result.unknown + category.unknown,
      collectionPaise: result.collectionPaise + category.collectionPaise
    }),
    { capacity: 0, available: 0, sold: 0, unknown: 0, collectionPaise: 0 }
  );

  return {
    categories: normalized,
    ...totals,
    occupancyPercent: totals.capacity
      ? Number(((totals.sold / totals.capacity) * 100).toFixed(2))
      : 0
  };
}
