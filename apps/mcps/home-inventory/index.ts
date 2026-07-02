// Home Inventory — Galactic MCP App
// Catalog belongings for insurance, moving, or organization.
// Storage: Galactic D1 (items)

const galactic = (globalThis as any).galactic;

// ── ADD ITEM ──

export async function add(args: {
  name: string;
  location: string;
  value?: number;
  category?: string;
  notes?: string;
  purchase_date?: string;
  warranty_expires?: string;
}): Promise<unknown> {
  const { name, location, value, category, notes, purchase_date, warranty_expires } = args;
  const id = crypto.randomUUID();
  const loc = location.toLowerCase().trim();
  const cat = category ? category.toLowerCase().trim() : 'uncategorized';
  const now = new Date().toISOString();

  await galactic.db.insert('items', {
    id: id,
    name: name,
    location: loc,
    category: cat,
    value: value || 0,
    notes: notes || '',
    purchase_date: purchase_date || null,
    warranty_expires: warranty_expires || null,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    item_id: id,
    name: name,
    location: loc,
    category: cat,
    value: value || 0,
  };
}

// ── LIST ITEMS ──

export async function list(args: {
  location?: string;
  category?: string;
  limit?: number;
}): Promise<unknown> {
  const { location, category, limit } = args;

  const where: Record<string, unknown> = {};
  if (location) {
    where.location = location.toLowerCase().trim();
  }
  if (category) {
    where.category = category.toLowerCase().trim();
  }

  const items = await galactic.db.select('items', {
    where: where,
    orderBy: { column: 'name', dir: 'asc' },
    limit: limit || 100,
  });
  const totalValue = items.reduce((sum: number, item: any) => sum + (item.value || 0), 0);

  return {
    items: items,
    count: items.length,
    total_value: totalValue,
  };
}

// ── SEARCH ITEMS ──

export async function search(args: {
  query: string;
}): Promise<unknown> {
  const { query } = args;
  const q = '%' + query.toLowerCase() + '%';

  const results = await galactic.db.select('items', {
    where: {
      _or: [
        { name: { like: q } },
        { notes: { like: q } },
        { location: { like: q } },
        { category: { like: q } },
      ],
    },
    orderBy: { column: 'name', dir: 'asc' },
  });

  return {
    query: query,
    results: results,
    count: results.length,
  };
}

// ── VALUE SUMMARY ──

export async function value(args: {
  location?: string;
  category?: string;
}): Promise<unknown> {
  const { location, category } = args;

  const where: Record<string, unknown> = {};
  if (location) {
    where.location = location.toLowerCase().trim();
  }
  if (category) {
    where.category = category.toLowerCase().trim();
  }

  const groupBy = location ? 'category' : 'location';

  const breakdown = await galactic.db.select('items', {
    columns: [
      { column: groupBy, as: 'group_key' },
      { fn: 'count', as: 'count' },
      { fn: 'sum', column: 'value', as: 'total_value' },
    ],
    where: where,
    groupBy: [groupBy],
  });

  const grouped: Record<string, { count: number; total_value: number }> = {};
  let grandTotal = 0;
  let itemCount = 0;

  for (const row of breakdown) {
    grouped[row.group_key] = { count: row.count, total_value: row.total_value };
    grandTotal += row.total_value || 0;
    itemCount += row.count;
  }

  return {
    total_value: grandTotal,
    item_count: itemCount,
    grouped_by: groupBy,
    breakdown: grouped,
  };
}

// ── EXPORT FOR INSURANCE ──

export async function export_summary(args: {
  format?: string;
}): Promise<unknown> {
  const items = await galactic.db.select('items', {
    orderBy: [
      { column: 'location', dir: 'asc' },
      { column: 'name', dir: 'asc' },
    ],
  });

  // Group by location
  const byLocation: Record<string, any[]> = {};
  let grandTotal = 0;

  for (const item of items) {
    if (!byLocation[item.location]) {
      byLocation[item.location] = [];
    }
    byLocation[item.location].push({
      name: item.name,
      category: item.category,
      value: item.value,
      purchase_date: item.purchase_date,
      warranty_expires: item.warranty_expires,
      notes: item.notes,
    });
    grandTotal += item.value || 0;
  }

  return {
    title: 'Home Inventory Summary',
    generated_at: new Date().toISOString(),
    total_items: items.length,
    total_value: grandTotal,
    by_location: byLocation,
  };
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  const stats = await galactic.db.first('items', {
    columns: [
      { fn: 'count', as: 'total_items' },
      { fn: 'count', column: 'location', distinct: true, as: 'total_locations' },
      { fn: 'count', column: 'category', distinct: true, as: 'total_categories' },
      { fn: 'sum', column: 'value', as: 'total_value' },
    ],
  });

  return {
    total_items: stats?.total_items || 0,
    total_locations: stats?.total_locations || 0,
    total_categories: stats?.total_categories || 0,
    total_value: stats?.total_value ?? 0,
  };
}
