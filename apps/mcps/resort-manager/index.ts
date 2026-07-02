// Resort Manager — Galactic MCP App
//
// Complete ski/golf resort management system:
// rooms, ski rentals/lessons, golf tee times, restaurant,
// store, guidelines, email agent, and admin approval queue.
//
// Storage: Galactic D1 (14 tables across 3 migrations) via the scoped
//          structured API (galactic.db.select/first/count/insert/update/
//          delete/upsert/batch). Per-user scoping is injected host-side —
//          app code never touches user_id.
// AI: galactic.ai() for email classification + reply drafting
// Network: Resend API for outbound email
// Permissions: ai:call, net:fetch

const galactic = (globalThis as any).galactic;

interface RoomRow {
  id: string;
  room_number: string;
  building: number;
  floor_room: number;
  tier: string;
  listed_price: number;
  status: string;
  current_reservation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RoomReservationRow {
  id: string;
  room_number: string;
  guest_name: string;
  num_guests: number;
  nights_staying: number;
  check_in_date: string;
  check_out_date: string;
  group_name: string | null;
  payment_method: string | null;
  payment_status: string;
  payment_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface RoomNumberRow {
  room_number: string;
}

interface PaymentAmountRow {
  id: string;
  payment_amount: number | null;
  payment_status?: string;
}

interface SkiEquipmentRow {
  id: string;
  category: string;
  brand: string | null;
  product: string | null;
  size: string | null;
  gender: string | null;
  qty_total: number;
  qty_rented: number;
  qty_available?: number;
  created_at?: string;
  updated_at?: string;
}

interface EquipmentIdRow {
  equipment_id: string;
}

interface TeeTimeRow {
  id: string;
  tee_date: string;
  tee_time: string;
  guest_name: string;
  room_number: string | null;
  starting_hole: number;
  num_in_party: number;
  payment_status: string;
  payment_amount: number;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

interface LessonRow {
  id: string;
  lesson_date: string;
  lesson_time: string;
  instructor: string | null;
  guest_name: string;
  room_number: string | null;
  num_students: number;
  skill_level: string | null;
  payment_status: string;
  payment_amount: number;
  notes: string | null;
}

interface RestaurantReservationRow {
  id: string;
  res_date: string;
  res_time: string;
  num_people: number;
  set_menu: string | null;
  allergies: string | null;
  guest_name: string;
  room_number: string | null;
  payment_status: string;
  payment_amount?: number | null;
  notes: string | null;
}

interface StoreProductRow {
  id: string;
  name: string;
  category: string | null;
  brand: string | null;
  price: number;
  qty_available: number;
  created_at?: string;
  updated_at?: string;
}

interface StoreTransactionRow {
  id: string;
  product_id: string;
  quantity: number;
  guest_name: string | null;
  room_number: string | null;
  payment_method: string | null;
  payment_status: string;
  payment_amount: number;
  product_name?: string | null;
  product_category?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface GuidelineRow {
  id?: string;
  key: string;
  value: string;
  category: string | null;
}

interface ApprovalQueueRow {
  id: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  summary: string;
  payload: string | null;
  original_email_id: string | null;
  resolved_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface EmailClassificationChange {
  table?: string;
  action?: string;
  data?: Record<string, unknown>;
  reason?: string;
}

interface EmailClassificationResult {
  classification: string;
  should_reply: boolean;
  reason: string;
  priority: 'high' | 'normal' | 'low';
  db_changes: EmailClassificationChange[];
}

interface ParsedApprovalQueueRow extends Omit<ApprovalQueueRow, 'payload'> {
  payload: Record<string, unknown>;
}

interface ApprovalCounts {
  pending: number;
  approved_today: number;
  rejected_today: number;
}

function sumPaymentAmounts<T extends { payment_amount?: number | null }>(items: T[]): number {
  return items.reduce((sum, item) => sum + (item.payment_amount || 0), 0);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// ============================================
// INTERNAL HELPERS
// ============================================

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function nowISO(): string {
  return new Date().toISOString();
}

function normalizeGuestName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

// Day-after helper for date-range filters. All timestamps in this app are ISO
// strings (nowISO), so `DATE(col) = d` translates to `col >= d AND col < d+1day`
// under plain string comparison.
function nextDayISO(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// Structured-where range equivalent of `DATE(col) = date`.
function dayRange(date: string): { gte: string; lt: string } {
  return { gte: date, lt: nextDayISO(date) };
}

// D1 caps bound parameters per statement, so bulk inserts are chunked.
function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

// Guest lookup filter — explicit allowlist of the only two filter columns this
// app supports. Anything else throws instead of being interpolated.
type GuestFilter =
  | { field: 'room_number'; value: string }
  | { field: 'guest_name'; value: string };

function guestScope(filter: GuestFilter): Record<string, unknown> {
  switch (filter.field) {
    case 'room_number':
      return { room_number: filter.value };
    case 'guest_name':
      return { guest_name: { like: '%' + filter.value + '%' } };
    default:
      throw new Error('Unknown guest filter: ' + (filter as { field: string }).field);
  }
}

function buildGuestFilter(room_number: string | undefined, guest_name: string | undefined): GuestFilter {
  if (room_number) return { field: 'room_number', value: room_number };
  return { field: 'guest_name', value: normalizeGuestName(guest_name!) };
}

// ============================================
// 1. ROOMS — Initialize, List, Book, Update, Check-in, Check-out
// ============================================

// ── ROOMS INITIALIZE ──

export async function rooms_initialize(args: {
  tier_map?: Record<string, string>;
  price_map?: Record<string, number>;
}): Promise<unknown> {
  const { tier_map, price_map } = args;

  // Check if already initialized
  const existingCount: number = await galactic.db.count('rooms');
  if (existingCount > 0) {
    return { success: false, message: 'Rooms already initialized. Found ' + existingCount + ' rooms.', total_rooms: existingCount };
  }

  // Default tier assignment: Twin (01-20), Corner King (21-28), Junior Suite (29-33), Onsen Suite (34-37)
  function defaultTier(floorRoom: number): string {
    if (floorRoom >= 34) return 'Onsen Suite';
    if (floorRoom >= 29) return 'Junior Suite';
    if (floorRoom >= 21) return 'Corner King';
    return 'Twin';
  }

  // Default prices per tier
  const defaultPrices: Record<string, number> = {
    'Twin': 15000,
    'Corner King': 20000,
    'Junior Suite': 25000,
    'Onsen Suite': 35000,
  };
  const prices = price_map || defaultPrices;

  const now = nowISO();
  const rows: Record<string, unknown>[] = [];
  const tierCounts: Record<string, number> = {};

  for (let building = 4; building <= 8; building++) {
    for (let room = 1; room <= 37; room++) {
      const roomStr = room.toString().padStart(2, '0');
      const roomNumber = '' + building + roomStr;
      const tier = (tier_map && tier_map[roomNumber]) || defaultTier(room);
      const price = prices[tier] || 15000;

      tierCounts[tier] = (tierCounts[tier] || 0) + 1;

      rows.push({
        id: crypto.randomUUID(),
        room_number: roomNumber,
        building: building,
        floor_room: room,
        tier: tier,
        listed_price: price,
        status: 'available',
        created_at: now,
        updated_at: now,
      });
    }
  }

  // Bulk seed: one insert op per chunk (values array = bulk insert), chunked
  // to stay under D1's bound-parameter limit per statement.
  await galactic.db.batch(
    chunkRows(rows, 8).map((values) => ({ op: 'insert', table: 'rooms', values })),
  );

  return {
    success: true,
    total_rooms: rows.length,
    by_tier: tierCounts,
    prices: prices,
  };
}

// ── ROOMS LIST ──

export async function rooms_list(args: {
  status?: string;
  tier?: string;
  building?: number;
  check_in?: string;
  check_out?: string;
  room_number?: string;
}): Promise<unknown> {
  const { status, tier, building, check_in, check_out, room_number } = args;

  const where: Record<string, unknown> = {};
  if (room_number) where.room_number = room_number;
  if (status) where.status = status;
  if (tier) where.tier = tier;
  if (building) where.building = building;

  let rooms: RoomRow[] = await galactic.db.select('rooms', {
    where,
    orderBy: { column: 'room_number', dir: 'asc' },
  });

  // Filter by date availability if requested
  if (check_in && check_out) {
    const booked: RoomNumberRow[] = await galactic.db.select('room_reservations', {
      columns: ['room_number'],
      where: {
        status: { ne: 'cancelled' },
        check_in_date: { lt: check_out },
        check_out_date: { gt: check_in },
      },
    });
    const bookedSet = new Set(booked.map((reservation) => reservation.room_number));
    rooms = rooms.filter((room) => !bookedSet.has(room.room_number));
  }

  return { rooms: rooms, total: rooms.length };
}

// ── ROOMS BOOK ──

export async function rooms_book(args: {
  room_number: string;
  guest_name: string;
  num_guests: number;
  check_in_date: string;
  check_out_date: string;
  nights_staying: number;
  group_name?: string;
  payment_method?: string;
  payment_amount?: number;
  notes?: string;
}): Promise<unknown> {
  const { room_number, guest_name, num_guests, check_in_date, check_out_date, nights_staying, group_name, payment_method, payment_amount, notes } = args;

  if (!room_number || !guest_name || !check_in_date || !check_out_date) {
    throw new Error('room_number, guest_name, check_in_date, and check_out_date are required');
  }

  // Verify room exists
  const room: RoomRow | null = await galactic.db.first('rooms', {
    where: { room_number: room_number },
  });
  if (!room) {
    throw new Error('Room ' + room_number + ' not found');
  }

  // Check for conflicts
  const conflict: Pick<RoomReservationRow, 'id' | 'guest_name' | 'check_in_date' | 'check_out_date'> | null = await galactic.db.first('room_reservations', {
    columns: ['id', 'guest_name', 'check_in_date', 'check_out_date'],
    where: {
      room_number: room_number,
      status: { ne: 'cancelled' },
      check_in_date: { lt: check_out_date },
      check_out_date: { gt: check_in_date },
    },
  });
  if (conflict) {
    throw new Error('Room ' + room_number + ' is already booked from ' + conflict.check_in_date + ' to ' + conflict.check_out_date + ' by ' + conflict.guest_name);
  }

  const id = crypto.randomUUID();
  const now = nowISO();
  const name = normalizeGuestName(guest_name);

  await galactic.db.insert('room_reservations', {
    id: id,
    room_number: room_number,
    guest_name: name,
    num_guests: num_guests || 1,
    nights_staying: nights_staying || 1,
    check_in_date: check_in_date,
    check_out_date: check_out_date,
    group_name: group_name || null,
    payment_method: payment_method || null,
    payment_status: 'unpaid',
    payment_amount: payment_amount || 0,
    status: 'confirmed',
    notes: notes || null,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    reservation: {
      id: id,
      room_number: room_number,
      room_tier: room.tier,
      guest_name: name,
      check_in_date: check_in_date,
      check_out_date: check_out_date,
      nights_staying: nights_staying || 1,
      status: 'confirmed',
    },
  };
}

// ── ROOMS UPDATE ──

export async function rooms_update(args: {
  reservation_id: string;
  room_number?: string;
  check_in_date?: string;
  check_out_date?: string;
  nights_staying?: number;
  num_guests?: number;
  guest_name?: string;
  group_name?: string;
  payment_method?: string;
  payment_status?: string;
  payment_amount?: number;
  status?: string;
  notes?: string;
}): Promise<unknown> {
  const { reservation_id } = args;
  if (!reservation_id) throw new Error('reservation_id is required');

  const existing: RoomReservationRow | null = await galactic.db.first('room_reservations', {
    where: { id: reservation_id },
  });
  if (!existing) throw new Error('Reservation not found: ' + reservation_id);

  const now = nowISO();

  const fields: Record<string, string | number | null | undefined> = {
    room_number: args.room_number,
    check_in_date: args.check_in_date,
    check_out_date: args.check_out_date,
    nights_staying: args.nights_staying,
    num_guests: args.num_guests,
    guest_name: args.guest_name ? normalizeGuestName(args.guest_name) : undefined,
    group_name: args.group_name,
    payment_method: args.payment_method,
    payment_status: args.payment_status,
    payment_amount: args.payment_amount,
    status: args.status,
    notes: args.notes,
  };

  const set: Record<string, string | number | null> = { updated_at: now };
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      set[key] = val;
    }
  }

  await galactic.db.update('room_reservations', {
    set,
    where: { id: reservation_id },
  });

  const updated: RoomReservationRow | null = await galactic.db.first('room_reservations', {
    where: { id: reservation_id },
  });

  return { success: true, reservation: updated };
}

// ── ROOMS CHECK-IN ──

export async function rooms_checkin(args: {
  reservation_id: string;
}): Promise<unknown> {
  const { reservation_id } = args;
  if (!reservation_id) throw new Error('reservation_id is required');

  const res: RoomReservationRow | null = await galactic.db.first('room_reservations', {
    where: { id: reservation_id },
  });
  if (!res) throw new Error('Reservation not found: ' + reservation_id);
  if (res.status === 'checked_in') throw new Error('Guest already checked in');

  const now = nowISO();

  await galactic.db.batch([
    {
      op: 'update',
      table: 'room_reservations',
      set: { status: 'checked_in', updated_at: now },
      where: { id: reservation_id },
    },
    {
      op: 'update',
      table: 'rooms',
      set: { status: 'occupied', current_reservation_id: reservation_id, updated_at: now },
      where: { room_number: res.room_number },
    },
  ]);

  const room: RoomRow | null = await galactic.db.first('rooms', {
    where: { room_number: res.room_number },
  });

  return {
    success: true,
    reservation: { ...res, status: 'checked_in' },
    room: room,
  };
}

// ── ROOMS CHECK-OUT ──

export async function rooms_checkout(args: {
  reservation_id: string;
}): Promise<unknown> {
  const { reservation_id } = args;
  if (!reservation_id) throw new Error('reservation_id is required');

  const res: RoomReservationRow | null = await galactic.db.first('room_reservations', {
    where: { id: reservation_id },
  });
  if (!res) throw new Error('Reservation not found: ' + reservation_id);

  const now = nowISO();

  await galactic.db.batch([
    {
      op: 'update',
      table: 'room_reservations',
      set: { status: 'checked_out', updated_at: now },
      where: { id: reservation_id },
    },
    {
      op: 'update',
      table: 'rooms',
      set: { status: 'available', current_reservation_id: null, updated_at: now },
      where: { room_number: res.room_number },
    },
  ]);

  // Gather all unpaid items for this room/guest
  const unpaidRooms: PaymentAmountRow[] = await galactic.db.select('room_reservations', {
    columns: ['id', 'payment_amount'],
    where: { room_number: res.room_number, payment_status: 'unpaid', id: reservation_id },
  });
  const unpaidSki: PaymentAmountRow[] = await galactic.db.select('ski_rentals', {
    columns: ['id', 'payment_amount'],
    where: { room_number: res.room_number, payment_status: 'unpaid' },
  });
  const unpaidLessons: PaymentAmountRow[] = await galactic.db.select('ski_lessons', {
    columns: ['id', 'payment_amount'],
    where: { room_number: res.room_number, payment_status: 'unpaid' },
  });
  const unpaidGolf: PaymentAmountRow[] = await galactic.db.select('tee_times', {
    columns: ['id', 'payment_amount'],
    where: { room_number: res.room_number, payment_status: 'unpaid' },
  });
  const unpaidRestaurant: Pick<PaymentAmountRow, 'id'>[] = await galactic.db.select('restaurant_reservations', {
    columns: ['id'],
    where: { room_number: res.room_number, payment_status: 'unpaid' },
  });
  const unpaidStore: PaymentAmountRow[] = await galactic.db.select('store_transactions', {
    columns: ['id', 'payment_amount'],
    where: { room_number: res.room_number, payment_status: 'unpaid' },
  });

  const unpaid_items = {
    room: { count: unpaidRooms.length, subtotal: sumPaymentAmounts(unpaidRooms) },
    ski_rentals: { count: unpaidSki.length, subtotal: sumPaymentAmounts(unpaidSki) },
    ski_lessons: { count: unpaidLessons.length, subtotal: sumPaymentAmounts(unpaidLessons) },
    golf: { count: unpaidGolf.length, subtotal: sumPaymentAmounts(unpaidGolf) },
    restaurant: { count: unpaidRestaurant.length, subtotal: 0 },
    store: { count: unpaidStore.length, subtotal: sumPaymentAmounts(unpaidStore) },
    grand_total: sumPaymentAmounts(unpaidRooms) + sumPaymentAmounts(unpaidSki) + sumPaymentAmounts(unpaidLessons) + sumPaymentAmounts(unpaidGolf) + sumPaymentAmounts(unpaidStore),
  };

  return {
    success: true,
    reservation: { ...res, status: 'checked_out' },
    unpaid_items: unpaid_items,
  };
}

// ============================================
// 2. SKI — Equipment, Rentals, Lessons
// ============================================

// Computed column (qty_total - qty_rented) is derived in JS now.
function withAvailability<T extends { qty_total: number; qty_rented: number }>(eq: T): T & { qty_available: number } {
  return { ...eq, qty_available: eq.qty_total - eq.qty_rented };
}

// ── SKI INVENTORY ──

export async function ski_inventory(args: {
  category?: string;
  available_only?: boolean;
}): Promise<unknown> {
  const { category, available_only } = args;

  const where: Record<string, unknown> = {};
  if (category) where.category = category.toLowerCase().trim();

  const rows: SkiEquipmentRow[] = await galactic.db.select('ski_equipment', {
    where,
    orderBy: ['category', 'brand', 'size'],
  });

  let equipment = rows.map(withAvailability);
  if (available_only) {
    equipment = equipment.filter((eq) => eq.qty_available > 0);
  }

  return { equipment: equipment, total: equipment.length };
}

// ── SKI EQUIPMENT MANAGE ──

export async function ski_equipment_manage(args: {
  action: string;
  equipment_id?: string;
  category?: string;
  brand?: string;
  product?: string;
  size?: string;
  gender?: string;
  qty_total?: number;
}): Promise<unknown> {
  const { action, equipment_id, category, brand, product, size, gender, qty_total } = args;
  const now = nowISO();

  if (action === 'add') {
    if (!category) throw new Error('category is required when adding equipment');
    const id = crypto.randomUUID();
    await galactic.db.insert('ski_equipment', {
      id: id,
      category: category.toLowerCase().trim(),
      brand: brand || null,
      product: product || null,
      size: size || null,
      gender: gender || null,
      qty_total: qty_total || 0,
      qty_rented: 0,
      created_at: now,
      updated_at: now,
    });
    const created: SkiEquipmentRow | null = await galactic.db.first('ski_equipment', { where: { id: id } });
    return { success: true, equipment: created ? withAvailability(created) : null };
  }

  if (action === 'update') {
    if (!equipment_id) throw new Error('equipment_id is required for update');

    const set: Record<string, string | number | null> = { updated_at: now };
    if (category !== undefined) set.category = category.toLowerCase().trim();
    if (brand !== undefined) set.brand = brand;
    if (product !== undefined) set.product = product;
    if (size !== undefined) set.size = size;
    if (gender !== undefined) set.gender = gender;
    if (qty_total !== undefined) set.qty_total = qty_total;

    await galactic.db.update('ski_equipment', {
      set,
      where: { id: equipment_id },
    });
    const updated: SkiEquipmentRow | null = await galactic.db.first('ski_equipment', { where: { id: equipment_id } });
    return { success: true, equipment: updated ? withAvailability(updated) : null };
  }

  throw new Error('action must be "add" or "update"');
}

// ── SKI RENT ──

export async function ski_rent(args: {
  guest_name: string;
  room_number?: string;
  tohoku_pass?: boolean;
  equipment_ids: string[];
  payment_method?: string;
  payment_amount?: number;
}): Promise<unknown> {
  const { guest_name, room_number, tohoku_pass, equipment_ids, payment_method, payment_amount } = args;

  if (!guest_name || !equipment_ids || equipment_ids.length === 0) {
    throw new Error('guest_name and equipment_ids are required');
  }

  // Validate availability for all items
  for (const eqId of equipment_ids) {
    const eq: Pick<SkiEquipmentRow, 'id' | 'category' | 'qty_total' | 'qty_rented'> | null = await galactic.db.first('ski_equipment', {
      columns: ['id', 'category', 'qty_total', 'qty_rented'],
      where: { id: eqId },
    });
    if (!eq) throw new Error('Equipment not found: ' + eqId);
    if (eq.qty_total - eq.qty_rented <= 0) {
      throw new Error('Equipment ' + eqId + ' (' + eq.category + ') is not available');
    }
  }

  const rentalId = crypto.randomUUID();
  const now = nowISO();
  const name = normalizeGuestName(guest_name);

  const ops: Record<string, unknown>[] = [];

  // Create rental
  ops.push({
    op: 'insert',
    table: 'ski_rentals',
    values: {
      id: rentalId,
      guest_name: name,
      room_number: room_number || null,
      tohoku_pass: tohoku_pass ? 1 : 0,
      status: 'active',
      payment_method: payment_method || null,
      payment_status: 'unpaid',
      payment_amount: payment_amount || 0,
      created_at: now,
      updated_at: now,
    },
  });

  // Create junction rows and increment qty_rented
  for (const eqId of equipment_ids) {
    ops.push({
      op: 'insert',
      table: 'ski_rental_items',
      values: {
        id: crypto.randomUUID(),
        rental_id: rentalId,
        equipment_id: eqId,
        created_at: now,
        updated_at: now,
      },
    });
    ops.push({
      op: 'update',
      table: 'ski_equipment',
      set: { qty_rented: { op: 'increment', value: 1 }, updated_at: now },
      where: { id: eqId },
    });
  }

  await galactic.db.batch(ops);

  // Fetch the items for the response
  const items: SkiEquipmentRow[] = await galactic.db.select('ski_equipment', {
    joins: [{
      table: 'ski_rental_items',
      as: 'ri',
      type: 'inner',
      on: { fromColumn: 'id', foreignColumn: 'equipment_id' },
    }],
    where: { 'ri.rental_id': rentalId },
  });

  return {
    success: true,
    rental: { id: rentalId, guest_name: name, room_number: room_number || null, tohoku_pass: !!tohoku_pass, status: 'active' },
    items: items,
    item_count: equipment_ids.length,
  };
}

// ── SKI RETURN ──

export async function ski_return(args: {
  rental_id: string;
}): Promise<unknown> {
  const { rental_id } = args;
  if (!rental_id) throw new Error('rental_id is required');

  const rental: { id: string; status: string } | null = await galactic.db.first('ski_rentals', {
    where: { id: rental_id },
  });
  if (!rental) throw new Error('Rental not found: ' + rental_id);
  if (rental.status === 'returned') throw new Error('Rental already returned');

  const items: EquipmentIdRow[] = await galactic.db.select('ski_rental_items', {
    columns: ['equipment_id'],
    where: { rental_id: rental_id },
  });

  const now = nowISO();
  const ops: Record<string, unknown>[] = [];

  ops.push({
    op: 'update',
    table: 'ski_rentals',
    set: { status: 'returned', updated_at: now },
    where: { id: rental_id },
  });

  // Decrement qty_rented, clamped at 0 (was MAX(0, qty_rented - 1) per item).
  const returnCounts = new Map<string, number>();
  for (const item of items) {
    returnCounts.set(item.equipment_id, (returnCounts.get(item.equipment_id) || 0) + 1);
  }
  if (returnCounts.size > 0) {
    const equipmentRows: Pick<SkiEquipmentRow, 'id' | 'qty_rented'>[] = await galactic.db.select('ski_equipment', {
      columns: ['id', 'qty_rented'],
      where: { id: { in: Array.from(returnCounts.keys()) } },
    });
    for (const eq of equipmentRows) {
      ops.push({
        op: 'update',
        table: 'ski_equipment',
        set: { qty_rented: Math.max(0, eq.qty_rented - (returnCounts.get(eq.id) || 0)), updated_at: now },
        where: { id: eq.id },
      });
    }
  }

  await galactic.db.batch(ops);

  return { success: true, rental_id: rental_id, returned_items: items.length };
}

// ── SKI BOOK LESSON ──

export async function ski_book_lesson(args: {
  guest_name: string;
  room_number?: string;
  lesson_date: string;
  lesson_time: string;
  duration_minutes?: number;
  instructor?: string;
  num_students?: number;
  skill_level?: string;
  payment_method?: string;
  payment_amount?: number;
  notes?: string;
}): Promise<unknown> {
  const { guest_name, room_number, lesson_date, lesson_time, duration_minutes, instructor, num_students, skill_level, payment_method, payment_amount, notes } = args;

  if (!guest_name || !lesson_date || !lesson_time) {
    throw new Error('guest_name, lesson_date, and lesson_time are required');
  }

  const id = crypto.randomUUID();
  const now = nowISO();
  const name = normalizeGuestName(guest_name);

  await galactic.db.insert('ski_lessons', {
    id: id,
    lesson_date: lesson_date,
    lesson_time: lesson_time,
    duration_minutes: duration_minutes || 60,
    instructor: instructor || null,
    guest_name: name,
    room_number: room_number || null,
    num_students: num_students || 1,
    skill_level: skill_level || null,
    payment_method: payment_method || null,
    payment_status: 'unpaid',
    payment_amount: payment_amount || 0,
    notes: notes || null,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    lesson: { id: id, guest_name: name, lesson_date: lesson_date, lesson_time: lesson_time, instructor: instructor || null, status: 'booked' },
  };
}

// ── SKI LESSONS LIST ──

export async function ski_lessons_list(args: {
  date?: string;
  instructor?: string;
  guest_name?: string;
}): Promise<unknown> {
  const { date, instructor, guest_name } = args;

  const where: Record<string, unknown> = {};
  if (date) where.lesson_date = date;
  if (instructor) where.instructor = instructor;
  if (guest_name) where.guest_name = { like: '%' + normalizeGuestName(guest_name) + '%' };

  const lessons: LessonRow[] = await galactic.db.select('ski_lessons', {
    where,
    orderBy: [
      { column: 'lesson_date', dir: 'asc' },
      { column: 'lesson_time', dir: 'asc' },
    ],
  });

  return { lessons: lessons, total: lessons.length };
}

// ============================================
// 3. GOLF — Tee Times
// ============================================

// ── GOLF BOOK TEE ──

export async function golf_book_tee(args: {
  guest_name: string;
  room_number?: string;
  tee_date: string;
  tee_time: string;
  starting_hole?: number;
  num_in_party?: number;
  cart_ids?: string[];
  payment_method?: string;
  payment_amount?: number;
  notes?: string;
}): Promise<unknown> {
  const { guest_name, room_number, tee_date, tee_time, starting_hole, num_in_party, cart_ids, payment_method, payment_amount, notes } = args;

  if (!guest_name || !tee_date || !tee_time) {
    throw new Error('guest_name, tee_date, and tee_time are required');
  }

  const teeId = crypto.randomUUID();
  const now = nowISO();
  const name = normalizeGuestName(guest_name);

  const ops: Record<string, unknown>[] = [];

  ops.push({
    op: 'insert',
    table: 'tee_times',
    values: {
      id: teeId,
      tee_date: tee_date,
      tee_time: tee_time,
      guest_name: name,
      room_number: room_number || null,
      starting_hole: starting_hole || 1,
      num_in_party: num_in_party || 1,
      payment_method: payment_method || null,
      payment_status: 'unpaid',
      payment_amount: payment_amount || 0,
      notes: notes || null,
      created_at: now,
      updated_at: now,
    },
  });

  if (cart_ids && cart_ids.length > 0) {
    // Bulk insert: one op, values array.
    ops.push({
      op: 'insert',
      table: 'tee_time_carts',
      values: cart_ids.map((cartId) => ({
        id: crypto.randomUUID(),
        tee_time_id: teeId,
        cart_id: cartId,
        created_at: now,
        updated_at: now,
      })),
    });
  }

  await galactic.db.batch(ops);

  return {
    success: true,
    tee_time: { id: teeId, guest_name: name, tee_date: tee_date, tee_time: tee_time, starting_hole: starting_hole || 1, num_in_party: num_in_party || 1 },
    carts: cart_ids || [],
  };
}

// ── GOLF AVAILABILITY ──

export async function golf_availability(args: {
  date: string;
  starting_hole?: number;
}): Promise<unknown> {
  const { date, starting_hole } = args;
  if (!date) throw new Error('date is required');

  const where: Record<string, unknown> = { tee_date: date };
  if (starting_hole) where.starting_hole = starting_hole;

  const booked: TeeTimeRow[] = await galactic.db.select('tee_times', {
    where,
    orderBy: { column: 'tee_time', dir: 'asc' },
  });

  // Generate all possible tee times (every 10 minutes from 06:00 to 16:00)
  const allTimes: string[] = [];
  for (let h = 6; h <= 16; h++) {
    for (let m = 0; m < 60; m += 10) {
      if (h === 16 && m > 0) break;
      allTimes.push(h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0'));
    }
  }

  const bookedTimes = new Set(booked.map((teeTime) => teeTime.tee_time));
  const available = allTimes.filter((t) => !bookedTimes.has(t));

  return { date: date, available_times: available, booked: booked, total_booked: booked.length };
}

// ── GOLF CANCEL ──

export async function golf_cancel(args: {
  tee_time_id: string;
}): Promise<unknown> {
  const { tee_time_id } = args;
  if (!tee_time_id) throw new Error('tee_time_id is required');

  const tee: TeeTimeRow | null = await galactic.db.first('tee_times', {
    where: { id: tee_time_id },
  });
  if (!tee) throw new Error('Tee time not found: ' + tee_time_id);

  await galactic.db.batch([
    { op: 'delete', table: 'tee_time_carts', where: { tee_time_id: tee_time_id } },
    { op: 'delete', table: 'tee_times', where: { id: tee_time_id } },
  ]);

  return { success: true, cancelled: tee };
}

// ============================================
// 4. RESTAURANT
// ============================================

// ── RESTAURANT BOOK ──

export async function restaurant_book(args: {
  guest_name: string;
  room_number?: string;
  res_date: string;
  res_time: string;
  num_people: number;
  set_menu?: string;
  allergies?: string;
  payment_method?: string;
  notes?: string;
}): Promise<unknown> {
  const { guest_name, room_number, res_date, res_time, num_people, set_menu, allergies, payment_method, notes } = args;

  if (!guest_name || !res_date || !res_time) {
    throw new Error('guest_name, res_date, and res_time are required');
  }

  const id = crypto.randomUUID();
  const now = nowISO();
  const name = normalizeGuestName(guest_name);

  await galactic.db.insert('restaurant_reservations', {
    id: id,
    res_date: res_date,
    res_time: res_time,
    num_people: num_people || 1,
    set_menu: set_menu || null,
    allergies: allergies || null,
    guest_name: name,
    room_number: room_number || null,
    payment_method: payment_method || null,
    payment_status: 'unpaid',
    notes: notes || null,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    reservation: { id: id, guest_name: name, res_date: res_date, res_time: res_time, num_people: num_people || 1, set_menu: set_menu || null },
  };
}

// ── RESTAURANT TODAY ──

export async function restaurant_today(args: {
  date?: string;
}): Promise<unknown> {
  const date = args.date || todayISO();

  const reservations: RestaurantReservationRow[] = await galactic.db.select('restaurant_reservations', {
    where: { res_date: date },
    orderBy: { column: 'res_time', dir: 'asc' },
  });

  const totalCovers = reservations.reduce((sum, reservation) => sum + (reservation.num_people || 0), 0);

  return { date: date, reservations: reservations, total_covers: totalCovers, total_reservations: reservations.length };
}

// ── RESTAURANT CANCEL ──

export async function restaurant_cancel(args: {
  reservation_id: string;
}): Promise<unknown> {
  const { reservation_id } = args;
  if (!reservation_id) throw new Error('reservation_id is required');

  const res: RestaurantReservationRow | null = await galactic.db.first('restaurant_reservations', {
    where: { id: reservation_id },
  });
  if (!res) throw new Error('Restaurant reservation not found: ' + reservation_id);

  await galactic.db.delete('restaurant_reservations', {
    where: { id: reservation_id },
  });

  return { success: true, cancelled: res };
}

// ============================================
// 5. STORE
// ============================================

// ── STORE SELL ──

export async function store_sell(args: {
  product_id: string;
  quantity?: number;
  guest_name?: string;
  room_number?: string;
  payment_method?: string;
  payment_amount?: number;
}): Promise<unknown> {
  const { product_id, quantity, guest_name, room_number, payment_method, payment_amount } = args;

  if (!product_id) throw new Error('product_id is required');

  const product: StoreProductRow | null = await galactic.db.first('store_products', {
    where: { id: product_id },
  });
  if (!product) throw new Error('Product not found: ' + product_id);

  const qty = quantity || 1;
  if (product.qty_available < qty) {
    throw new Error('Insufficient stock. Available: ' + product.qty_available + ', requested: ' + qty);
  }

  const txId = crypto.randomUUID();
  const now = nowISO();
  const amount = payment_amount !== undefined ? payment_amount : product.price * qty;

  await galactic.db.batch([
    {
      op: 'insert',
      table: 'store_transactions',
      values: {
        id: txId,
        product_id: product_id,
        quantity: qty,
        guest_name: guest_name ? normalizeGuestName(guest_name) : null,
        room_number: room_number || null,
        payment_method: payment_method || null,
        payment_status: 'unpaid',
        payment_amount: amount,
        created_at: now,
        updated_at: now,
      },
    },
    {
      op: 'update',
      table: 'store_products',
      set: { qty_available: { op: 'increment', value: -qty }, updated_at: now },
      where: { id: product_id },
    },
  ]);

  return {
    success: true,
    transaction: { id: txId, product_id: product_id, product_name: product.name, quantity: qty, amount: amount },
  };
}

// ── STORE INVENTORY ──

export async function store_inventory(args: {
  category?: string;
  low_stock_only?: boolean;
}): Promise<unknown> {
  const { category, low_stock_only } = args;

  const where: Record<string, unknown> = {};
  if (category) where.category = category.toLowerCase().trim();
  if (low_stock_only) where.qty_available = { lt: 5 };

  const products: StoreProductRow[] = await galactic.db.select('store_products', {
    where,
    orderBy: ['category', 'name'],
  });

  return { products: products, total: products.length };
}

// ── STORE MANAGE ──

export async function store_manage(args: {
  action: string;
  product_id?: string;
  name?: string;
  category?: string;
  brand?: string;
  price?: number;
  qty_add?: number;
}): Promise<unknown> {
  const { action, product_id, name, category, brand, price, qty_add } = args;
  const now = nowISO();

  if (action === 'add') {
    if (!name) throw new Error('name is required when adding a product');
    const id = crypto.randomUUID();
    await galactic.db.insert('store_products', {
      id: id,
      name: name,
      category: category ? category.toLowerCase().trim() : null,
      brand: brand || null,
      price: price || 0,
      qty_available: qty_add || 0,
      created_at: now,
      updated_at: now,
    });
    const created: StoreProductRow | null = await galactic.db.first('store_products', { where: { id: id } });
    return { success: true, product: created };
  }

  if (action === 'restock') {
    if (!product_id || !qty_add) throw new Error('product_id and qty_add are required for restock');
    await galactic.db.update('store_products', {
      set: { qty_available: { op: 'increment', value: qty_add }, updated_at: now },
      where: { id: product_id },
    });
    const updated: StoreProductRow | null = await galactic.db.first('store_products', { where: { id: product_id } });
    return { success: true, product: updated };
  }

  if (action === 'update_price') {
    if (!product_id || price === undefined) throw new Error('product_id and price are required for update_price');
    await galactic.db.update('store_products', {
      set: { price: price, updated_at: now },
      where: { id: product_id },
    });
    const updated: StoreProductRow | null = await galactic.db.first('store_products', { where: { id: product_id } });
    return { success: true, product: updated };
  }

  throw new Error('action must be "add", "restock", or "update_price"');
}

// ── STORE SALES ──

export async function store_sales(args: {
  date?: string;
  guest_name?: string;
  product_id?: string;
  limit?: number;
}): Promise<unknown> {
  const { date, guest_name, product_id, limit } = args;

  const where: Record<string, unknown> = {};
  if (date) where.created_at = dayRange(date);
  if (guest_name) where.guest_name = { like: '%' + normalizeGuestName(guest_name) + '%' };
  if (product_id) where.product_id = product_id;

  const transactions: StoreTransactionRow[] = await galactic.db.select('store_transactions', {
    columns: [
      '*',
      { table: 'p', column: 'name', as: 'product_name' },
      { table: 'p', column: 'category', as: 'product_category' },
    ],
    joins: [{
      table: 'store_products',
      as: 'p',
      type: 'left',
      on: { fromColumn: 'product_id', foreignColumn: 'id' },
    }],
    where,
    orderBy: { column: 'created_at', dir: 'desc' },
    limit: limit || 50,
  });

  const totalRevenue = transactions.reduce((sum, transaction) => sum + (transaction.payment_amount || 0), 0);

  return { transactions: transactions, total_revenue: totalRevenue, count: transactions.length };
}

// ============================================
// 6. CROSS-DOMAIN — Guest Summary, Billing, Reports
// ============================================

// ── GUEST SUMMARY ──

export async function guest_summary(args: {
  guest_name?: string;
  room_number?: string;
  sections?: string[];
}): Promise<unknown> {
  const { guest_name, room_number } = args;
  // Default sections: lightweight overview. Pass ["all"] or specific sections for more.
  // Available sections: room, reservation, ski_rentals, ski_lessons, tee_times, restaurant, store, billing
  const sections = args.sections || ['room', 'reservation', 'billing'];
  const wantAll = sections.includes('all');
  const want = (s: string) => wantAll || sections.includes(s);

  if (!guest_name && !room_number) {
    throw new Error('Either guest_name or room_number is required');
  }

  let room = null;
  let reservation = null;

  if (room_number) {
    if (want('room')) {
      room = await galactic.db.first('rooms', {
        where: { room_number: room_number },
      });
    }
    reservation = await galactic.db.first('room_reservations', {
      where: { room_number: room_number, status: { in: ['confirmed', 'checked_in'] } },
      orderBy: { column: 'check_in_date', dir: 'desc' },
    });
  }

  // Build filter (allowlisted: room_number equality or guest_name LIKE)
  const filter = buildGuestFilter(room_number, guest_name);

  if (!reservation && guest_name) {
    reservation = await galactic.db.first('room_reservations', {
      where: {
        guest_name: { like: '%' + normalizeGuestName(guest_name) + '%' },
        status: { in: ['confirmed', 'checked_in'] },
      },
      orderBy: { column: 'check_in_date', dir: 'desc' },
    });
  }

  // Only fetch detailed sections if requested
  const ski_rentals = want('ski_rentals') ? await galactic.db.select('ski_rentals', {
    where: guestScope(filter),
    orderBy: { column: 'created_at', dir: 'desc' },
    limit: 20,
  }) as PaymentAmountRow[] : [];
  const ski_lessons = want('ski_lessons') ? await galactic.db.select('ski_lessons', {
    where: guestScope(filter),
    orderBy: { column: 'lesson_date', dir: 'desc' },
    limit: 20,
  }) as PaymentAmountRow[] : [];
  const golf_tee_times = want('tee_times') ? await galactic.db.select('tee_times', {
    where: guestScope(filter),
    orderBy: { column: 'tee_date', dir: 'desc' },
    limit: 20,
  }) as PaymentAmountRow[] : [];
  const restaurant = want('restaurant') ? await galactic.db.select('restaurant_reservations', {
    where: guestScope(filter),
    orderBy: { column: 'res_date', dir: 'desc' },
    limit: 20,
  }) as RestaurantReservationRow[] : [];
  const store = want('store') ? await galactic.db.select('store_transactions', {
    where: guestScope(filter),
    orderBy: { column: 'created_at', dir: 'desc' },
    limit: 20,
  }) as PaymentAmountRow[] : [];

  // Always calculate unpaid total (lightweight — uses counts if full data not fetched)
  let total_unpaid = 0;
  if (reservation && reservation.payment_status === 'unpaid') {
    total_unpaid += reservation.payment_amount || 0;
  }

  if (want('billing') || wantAll) {
    // If we already fetched the data, sum from it
    const sumUnpaid = <T extends { payment_status?: string; payment_amount?: number | null }>(items: T[]) =>
      items.filter((item) => item.payment_status === 'unpaid').reduce((sum, item) => sum + (item.payment_amount || 0), 0);

    if (ski_rentals.length || ski_lessons.length || golf_tee_times.length || store.length) {
      total_unpaid += sumUnpaid(ski_rentals) + sumUnpaid(ski_lessons) + sumUnpaid(golf_tee_times) + sumUnpaid(store);
    } else {
      // Fetch just unpaid totals via aggregate queries (COALESCE -> ?? in JS)
      const unpaidSum = async (table: string) => {
        const row: { total: number | null } | null = await galactic.db.first(table, {
          columns: [{ fn: 'sum', column: 'payment_amount', as: 'total' }],
          where: { ...guestScope(filter), payment_status: 'unpaid' },
        });
        return row?.total ?? 0;
      };
      total_unpaid += await unpaidSum('ski_rentals') + await unpaidSum('ski_lessons') + await unpaidSum('tee_times') + await unpaidSum('store_transactions');
    }
  }

  const result: Record<string, unknown> = {
    reservation: reservation,
    total_unpaid: total_unpaid,
  };

  if (want('room')) result.room = room;
  if (want('ski_rentals')) result.ski_rentals = ski_rentals;
  if (want('ski_lessons')) result.ski_lessons = ski_lessons;
  if (want('tee_times')) result.tee_times = golf_tee_times;
  if (want('restaurant')) result.restaurant_reservations = restaurant;
  if (want('store')) result.store_purchases = store;
  if (!wantAll && !sections.includes('room')) {
    result._note = 'Default lightweight summary. Pass sections: ["all"] or specific sections like ["ski_rentals", "store"] for full details.';
  }

  return result;
}

// ── GUEST BILLING ──

export async function guest_billing(args: {
  room_number?: string;
  guest_name?: string;
  payment_status?: string;
  itemized?: boolean;
}): Promise<unknown> {
  const { room_number, guest_name } = args;
  const payStatus = args.payment_status || 'unpaid';
  const itemized = args.itemized === true;

  if (!room_number && !guest_name) {
    throw new Error('Either room_number or guest_name is required');
  }

  const filter = buildGuestFilter(room_number, guest_name);

  if (!itemized) {
    // Totals-only mode (default) — fast aggregate queries, minimal response
    const sumFrom = async (table: string) => {
      const row: { count: number; total: number | null } | null = await galactic.db.first(table, {
        columns: [
          { fn: 'count', as: 'count' },
          { fn: 'sum', column: 'payment_amount', as: 'total' },
        ],
        where: { ...guestScope(filter), payment_status: payStatus },
      });
      return { count: row?.count || 0, subtotal: row?.total ?? 0 };
    };

    const rooms = await sumFrom('room_reservations');
    const ski_rentals = await sumFrom('ski_rentals');
    const ski_lessons = await sumFrom('ski_lessons');
    const golf = await sumFrom('tee_times');
    const restaurant = await sumFrom('restaurant_reservations');
    const store = await sumFrom('store_transactions');

    return {
      rooms, ski_rentals, ski_lessons, golf, restaurant, store,
      grand_total: rooms.subtotal + ski_rentals.subtotal + ski_lessons.subtotal + golf.subtotal + store.subtotal,
      _note: 'Totals-only summary. Pass itemized: true for line-item details.',
    };
  }

  // Itemized mode — full line items
  const itemColumns = ['id', 'room_number', 'guest_name', 'payment_amount', 'payment_status'];
  const itemWhere = { ...guestScope(filter), payment_status: payStatus };

  const roomItems: PaymentAmountRow[] = await galactic.db.select('room_reservations', {
    columns: itemColumns, where: itemWhere, limit: 50,
  });
  const skiItems: PaymentAmountRow[] = await galactic.db.select('ski_rentals', {
    columns: itemColumns, where: itemWhere, limit: 50,
  });
  const lessonItems: PaymentAmountRow[] = await galactic.db.select('ski_lessons', {
    columns: itemColumns, where: itemWhere, limit: 50,
  });
  const golfItems: PaymentAmountRow[] = await galactic.db.select('tee_times', {
    columns: itemColumns, where: itemWhere, limit: 50,
  });
  const restItems: Pick<PaymentAmountRow, 'id' | 'payment_status'>[] = await galactic.db.select('restaurant_reservations', {
    columns: ['id', 'room_number', 'guest_name', 'payment_status'], where: itemWhere, limit: 50,
  });
  const storeItems: PaymentAmountRow[] = await galactic.db.select('store_transactions', {
    columns: itemColumns, where: itemWhere, limit: 50,
  });

  return {
    rooms: { items: roomItems, subtotal: sumPaymentAmounts(roomItems) },
    ski_rentals: { items: skiItems, subtotal: sumPaymentAmounts(skiItems) },
    ski_lessons: { items: lessonItems, subtotal: sumPaymentAmounts(lessonItems) },
    golf: { items: golfItems, subtotal: sumPaymentAmounts(golfItems) },
    restaurant: { items: restItems, subtotal: 0 },
    store: { items: storeItems, subtotal: sumPaymentAmounts(storeItems) },
    grand_total: sumPaymentAmounts(roomItems) + sumPaymentAmounts(skiItems) + sumPaymentAmounts(lessonItems) + sumPaymentAmounts(golfItems) + sumPaymentAmounts(storeItems),
  };
}

// ── REPORT DAILY ──

export async function report_daily(args: {
  date?: string;
}): Promise<unknown> {
  const date = args.date || todayISO();

  // Occupancy
  const total: number = await galactic.db.count('rooms');
  const occupied: number = await galactic.db.count('rooms', { where: { status: 'occupied' } });

  // Check-ins and check-outs for this date
  const checkIns: RoomReservationRow[] = await galactic.db.select('room_reservations', {
    where: { check_in_date: date, status: { in: ['confirmed', 'checked_in'] } },
  });
  const checkOuts: RoomReservationRow[] = await galactic.db.select('room_reservations', {
    where: { check_out_date: date, status: { in: ['checked_in', 'checked_out'] } },
  });

  // Active ski rentals
  const activeRentals: number = await galactic.db.count('ski_rentals', { where: { status: 'active' } });

  // Today's lessons
  const lessons: LessonRow[] = await galactic.db.select('ski_lessons', {
    where: { lesson_date: date },
    orderBy: 'lesson_time',
  });

  // Today's tee times
  const teeTimes: TeeTimeRow[] = await galactic.db.select('tee_times', {
    where: { tee_date: date },
    orderBy: 'tee_time',
  });

  // Restaurant covers (COALESCE -> ?? in JS)
  const restRow: { covers: number | null } | null = await galactic.db.first('restaurant_reservations', {
    columns: [{ fn: 'sum', column: 'num_people', as: 'covers' }],
    where: { res_date: date },
  });
  const restaurantCovers = restRow?.covers ?? 0;

  // Store revenue today (DATE(created_at) = date -> range in JS)
  const storeRow: { revenue: number | null } | null = await galactic.db.first('store_transactions', {
    columns: [{ fn: 'sum', column: 'payment_amount', as: 'revenue' }],
    where: { created_at: dayRange(date) },
  });
  const storeRevenue = storeRow?.revenue ?? 0;

  // Pending approvals
  const pendingApprovals: number = await galactic.db.count('approval_queue', { where: { status: 'pending' } });

  // Revenue by service today (DATE(updated_at) = date -> range in JS)
  const paidRevenue = async (table: string): Promise<number> => {
    const row: { rev: number | null } | null = await galactic.db.first(table, {
      columns: [{ fn: 'sum', column: 'payment_amount', as: 'rev' }],
      where: { payment_status: 'paid', updated_at: dayRange(date) },
    });
    return row?.rev ?? 0;
  };
  const roomRev = await paidRevenue('room_reservations');
  const skiRev = await paidRevenue('ski_rentals');
  const lessonRev = await paidRevenue('ski_lessons');
  const golfRev = await paidRevenue('tee_times');

  return {
    date: date,
    occupancy: {
      total_rooms: total,
      occupied: occupied,
      available: total - occupied,
      rate: total > 0 ? Math.round((occupied / total) * 100) + '%' : '0%',
    },
    check_ins: checkIns,
    check_outs: checkOuts,
    ski_rentals_active: activeRentals,
    lessons_today: lessons,
    tee_times_today: teeTimes,
    restaurant_covers: restaurantCovers,
    store_revenue: storeRevenue,
    pending_approvals: pendingApprovals,
    revenue_today: {
      rooms: roomRev,
      ski: skiRev,
      lessons: lessonRev,
      golf: golfRev,
      store: storeRevenue,
      total: roomRev + skiRev + lessonRev + golfRev + storeRevenue,
    },
  };
}

// ── REPORT REVENUE ──

export async function report_revenue(args: {
  start_date: string;
  end_date: string;
}): Promise<unknown> {
  const { start_date, end_date } = args;
  if (!start_date || !end_date) throw new Error('start_date and end_date are required');

  // DATE(col) BETWEEN start AND end -> col >= start AND col < end+1day (ISO strings)
  const createdRange = { gte: start_date, lt: nextDayISO(end_date) };

  const revenueSum = async (table: string, where: Record<string, unknown>): Promise<number> => {
    const row: { rev: number | null } | null = await galactic.db.first(table, {
      columns: [{ fn: 'sum', column: 'payment_amount', as: 'rev' }],
      where,
    });
    return row?.rev ?? 0;
  };

  const rooms = await revenueSum('room_reservations', { check_in_date: { gte: start_date, lte: end_date } });
  const ski = await revenueSum('ski_rentals', { created_at: createdRange });
  const lessons = await revenueSum('ski_lessons', { lesson_date: { gte: start_date, lte: end_date } });
  const golf = await revenueSum('tee_times', { tee_date: { gte: start_date, lte: end_date } });
  const store = await revenueSum('store_transactions', { created_at: createdRange });

  // By payment method (GROUP BY)
  const byMethod: Array<{ payment_method: string | null; total: number }> = await galactic.db.select('room_reservations', {
    columns: ['payment_method', { fn: 'sum', column: 'payment_amount', as: 'total' }],
    where: {
      check_in_date: { gte: start_date, lte: end_date },
      payment_method: { isNull: false },
    },
    groupBy: ['payment_method'],
  });

  // Unpaid total (COALESCE -> ?? in JS)
  const unpaidRow: { total: number | null } | null = await galactic.db.first('room_reservations', {
    columns: [{ fn: 'sum', column: 'payment_amount', as: 'total' }],
    where: {
      check_in_date: { gte: start_date, lte: end_date },
      payment_status: 'unpaid',
    },
  });

  const methodMap: Record<string, number> = {};
  for (const m of byMethod) {
    methodMap[m.payment_method || 'unknown'] = m.total;
  }

  return {
    period: { start: start_date, end: end_date },
    by_service: { rooms: rooms, ski_rentals: ski, ski_lessons: lessons, golf: golf, store: store },
    by_payment_method: methodMap,
    total: rooms + ski + lessons + golf + store,
    unpaid: unpaidRow?.total ?? 0,
  };
}

// ============================================
// 7. GUIDELINES
// ============================================

// ── GUIDELINES GET ──

export async function guidelines_get(args: {
  key?: string;
  category?: string;
}): Promise<unknown> {
  const { key, category } = args;

  if (key) {
    const row: GuidelineRow | null = await galactic.db.first('guidelines', {
      where: { key: key },
    });
    return { guidelines: row ? [row] : [], total: row ? 1 : 0 };
  }

  const where: Record<string, unknown> = {};
  if (category) where.category = category;

  const rows: GuidelineRow[] = await galactic.db.select('guidelines', {
    where,
    orderBy: ['category', 'key'],
  });

  return { guidelines: rows, total: rows.length };
}

// ── GUIDELINES SET ──

export async function guidelines_set(args: {
  key: string;
  value: string;
  category?: string;
}): Promise<unknown> {
  const { key, value, category } = args;
  if (!key || !value) throw new Error('key and value are required');

  const now = nowISO();
  const existing: Pick<GuidelineRow, 'id'> | null = await galactic.db.first('guidelines', {
    columns: ['id'],
    where: { key: key },
  });

  if (existing) {
    // COALESCE(?, category) -> only touch category when one was provided
    const set: Record<string, string | null> = { value: value, updated_at: now };
    if (category) set.category = category;
    await galactic.db.update('guidelines', {
      set,
      where: { id: existing.id },
    });
  } else {
    const id = crypto.randomUUID();
    await galactic.db.insert('guidelines', {
      id: id,
      key: key,
      value: value,
      category: category || null,
      created_at: now,
      updated_at: now,
    });
  }

  return { success: true, guideline: { key: key, value: value, category: category || null } };
}

// ── GUIDELINES REMOVE ──

export async function guidelines_remove(args: {
  key: string;
}): Promise<unknown> {
  const { key } = args;
  if (!key) throw new Error('key is required');

  await galactic.db.delete('guidelines', {
    where: { key: key },
  });

  return { success: true, removed: true, key: key };
}

// ============================================
// 8. EMAIL AGENT
// ============================================

// ── EMAIL PROCESS ──

export async function email_process(args: {
  emails?: Array<{
    from: string;
    to?: string;
    subject: string;
    body: string;
    thread_id?: string;
  }>;
}): Promise<unknown> {
  const { emails } = args;

  if (!emails || emails.length === 0) {
    return { processed: 0, message: 'No emails provided. Pass emails array or connect to an inbox API.' };
  }

  const now = nowISO();
  const results: Array<Record<string, unknown>> = [];

  // Load guidelines for AI context
  const allGuidelines: Pick<GuidelineRow, 'key' | 'value' | 'category'>[] = await galactic.db.select('guidelines', {
    columns: ['key', 'value', 'category'],
  });
  const guidelinesText = allGuidelines.map((guideline) => guideline.key + ': ' + guideline.value).join('\n');

  // Check room availability for context
  const availableRooms: number = await galactic.db.count('rooms', { where: { status: 'available' } });

  for (const email of emails) {
    // 1. Log inbound email
    const emailId = crypto.randomUUID();
    await galactic.db.insert('email_log', {
      id: emailId,
      direction: 'inbound',
      from_address: email.from,
      to_address: email.to || null,
      subject: email.subject,
      body_text: email.body,
      thread_id: email.thread_id || null,
      status: 'processing',
      created_at: now,
      updated_at: now,
    });

    try {
      // 2. AI Classification
      const classifyResponse = await galactic.ai({
        model: 'openai/gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an email classifier for a ski/golf resort. Classify this email and decide whether it needs a reply.\n\nResort guidelines:\n' + guidelinesText + '\n\nAvailable rooms: ' + availableRooms + '\n\nRespond with JSON only:\n{\n  "classification": "reservation_request|cancellation|inquiry|complaint|confirmation|spam|other",\n  "should_reply": true/false,\n  "reason": "brief explanation",\n  "priority": "high|normal|low",\n  "db_changes": [\n    { "table": "table_name", "action": "insert|update|delete", "data": {}, "reason": "why this change" }\n  ]\n}'
          },
          {
            role: 'user',
            content: 'From: ' + email.from + '\nSubject: ' + email.subject + '\n\n' + email.body,
          },
        ],
      });

      let classification: EmailClassificationResult;
      try {
        const content = classifyResponse.content || classifyResponse.text || '';
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
        classification = JSON.parse(jsonMatch[1] || content) as EmailClassificationResult;
      } catch (e) {
        classification = { classification: 'other', should_reply: false, reason: 'Failed to parse AI classification', priority: 'normal', db_changes: [] };
      }

      // Update email log with classification
      await galactic.db.update('email_log', {
        set: { classification: classification.classification, status: 'queued', updated_at: now },
        where: { id: emailId },
      });

      // 3. If should reply, draft a response
      if (classification.should_reply) {
        // Look up guest data if we can identify them
        let guestContext = '';
        const guestReservation: Pick<RoomReservationRow, 'guest_name' | 'room_number' | 'check_in_date' | 'check_out_date'> | null = await galactic.db.first('room_reservations', {
          where: { status: { in: ['confirmed', 'checked_in'] } },
          orderBy: { column: 'check_in_date', dir: 'desc' },
        });
        if (guestReservation) {
          guestContext = '\nGuest context: ' + guestReservation.guest_name + ' in room ' + guestReservation.room_number + ', check-in: ' + guestReservation.check_in_date + ', check-out: ' + guestReservation.check_out_date;
        }

        const draftResponse = await galactic.ai({
          model: 'openai/gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'Draft a professional reply for this resort email. Be warm, helpful, and accurate.\n\nResort guidelines:\n' + guidelinesText + guestContext + '\n\nMatch the language of the incoming email (Japanese/English).',
            },
            {
              role: 'user',
              content: 'Reply to:\nFrom: ' + email.from + '\nSubject: ' + email.subject + '\n\n' + email.body + '\n\nClassification: ' + classification.classification,
            },
          ],
        });

        const draftBody = draftResponse.content || draftResponse.text || '';

        // Queue email reply approval
        const approvalId = crypto.randomUUID();
        await galactic.db.insert('approval_queue', {
          id: approvalId,
          type: 'email_reply',
          status: 'pending',
          priority: classification.priority || 'normal',
          title: 'Reply to: ' + email.subject,
          summary: 'From ' + email.from + ' — ' + classification.reason,
          payload: JSON.stringify({ to: email.from, subject: 'Re: ' + email.subject, draft_body: draftBody, original_body: email.body }),
          original_email_id: emailId,
          created_at: now,
          updated_at: now,
        });

        await galactic.db.update('email_log', {
          set: { approval_id: approvalId, updated_at: now },
          where: { id: emailId },
        });

        results.push({ email_id: emailId, classification: classification.classification, action: 'reply_queued', approval_id: approvalId });
      } else {
        // Queue skip notification
        const approvalId = crypto.randomUUID();
        await galactic.db.insert('approval_queue', {
          id: approvalId,
          type: 'email_skip',
          status: 'pending',
          priority: 'low',
          title: 'Skip: ' + email.subject,
          summary: classification.reason,
          payload: JSON.stringify({ from: email.from, subject: email.subject, reason: classification.reason, original_body: email.body }),
          original_email_id: emailId,
          created_at: now,
          updated_at: now,
        });

        results.push({ email_id: emailId, classification: classification.classification, action: 'skip_queued', approval_id: approvalId });
      }

      // 4. Queue any suggested DB changes
      if (classification.db_changes && classification.db_changes.length > 0) {
        for (const change of classification.db_changes) {
          const changeApprovalId = crypto.randomUUID();
          await galactic.db.insert('approval_queue', {
            id: changeApprovalId,
            type: 'db_change',
            status: 'pending',
            priority: classification.priority || 'normal',
            title: 'DB: ' + change.action + ' ' + change.table,
            summary: change.reason,
            payload: JSON.stringify(change),
            original_email_id: emailId,
            created_at: now,
            updated_at: now,
          });
        }
      }
    } catch (err) {
      await galactic.db.update('email_log', {
        set: { status: 'failed', error_message: err instanceof Error ? err.message : String(err), updated_at: now },
        where: { id: emailId },
      });
      results.push({ email_id: emailId, action: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed: results.length, results: results };
}

// ── EMAIL SEND ──

export async function email_send(args: {
  to: string;
  subject: string;
  body: string;
  in_reply_to?: string;
}): Promise<unknown> {
  const { to, subject, body, in_reply_to } = args;

  if (!to || !subject || !body) throw new Error('to, subject, and body are required');

  const apiKey = galactic.env.RESEND_API_KEY;
  const fromAddress = galactic.env.RESORT_EMAIL_ADDRESS || 'resort@resend.dev';
  const resortName = galactic.env.RESORT_NAME || 'Resort';

  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured. Set it via ul.set env vars.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resortName + ' <' + fromAddress + '>',
      to: [to],
      subject: subject,
      html: body.replace(/\n/g, '<br>'),
    }),
  });

  const now = nowISO();
  const emailId = crypto.randomUUID();

  if (response.ok) {
    await galactic.db.insert('email_log', {
      id: emailId,
      direction: 'outbound',
      from_address: fromAddress,
      to_address: to,
      subject: subject,
      body_html: body,
      in_reply_to: in_reply_to || null,
      status: 'sent',
      sent_at: now,
      created_at: now,
      updated_at: now,
    });
    return { success: true, email_id: emailId, to: to, subject: subject };
  } else {
    const errBody = await response.text();
    await galactic.db.insert('email_log', {
      id: emailId,
      direction: 'outbound',
      from_address: fromAddress,
      to_address: to,
      subject: subject,
      body_html: body,
      status: 'failed',
      error_message: errBody,
      created_at: now,
      updated_at: now,
    });
    throw new Error('Email send failed: ' + errBody);
  }
}

// ── EMAIL LOG LIST ──

export async function email_log_list(args: {
  direction?: string;
  status?: string;
  limit?: number;
}): Promise<unknown> {
  const { direction, status, limit } = args;

  const where: Record<string, unknown> = {};
  if (direction) where.direction = direction;
  if (status) where.status = status;

  const emails = await galactic.db.select('email_log', {
    columns: ['id', 'direction', 'from_address', 'to_address', 'subject', 'classification', 'status', 'sent_at', 'created_at'],
    where,
    orderBy: { column: 'created_at', dir: 'desc' },
    limit: limit || 50,
  });
  return { emails: emails, total: emails.length };
}

// ============================================
// 9. APPROVAL QUEUE
// ============================================

// Tables this app owns — the ONLY tables an approval-payload db_change may
// touch. Anything else throws (payload table names arrive from AI output).
const APP_TABLES = new Set([
  'rooms', 'room_reservations', 'ski_equipment', 'ski_rentals', 'ski_rental_items',
  'ski_lessons', 'tee_times', 'tee_time_carts', 'restaurant_reservations',
  'store_products', 'store_transactions', 'guidelines', 'approval_queue', 'email_log',
]);

// ── APPROVALS LIST ──

export async function approvals_list(args: {
  status?: string;
  type?: string;
  limit?: number;
}): Promise<unknown> {
  const targetStatus = args.status || 'pending';
  const { type, limit } = args;

  const where: Record<string, unknown> = { status: targetStatus };
  if (type) where.type = type;

  // ORDER BY CASE priority ... isn't expressible in the structured API:
  // fetch ordered by created_at, rank priority in JS (stable sort), then slice.
  const rows: ApprovalQueueRow[] = await galactic.db.select('approval_queue', {
    where,
    orderBy: { column: 'created_at', dir: 'asc' },
  });

  const priorityRank: Record<string, number> = { high: 1, normal: 2, low: 3 };
  const approvals = rows
    .slice()
    .sort((a, b) => (priorityRank[a.priority] || 4) - (priorityRank[b.priority] || 4))
    .slice(0, limit || 20);

  // Parse payloads
  const parsed: ParsedApprovalQueueRow[] = approvals.map((approval) => ({
    ...approval,
    payload: parseJsonObject(approval.payload),
  }));

  // Counts (DATE(resolved_at) = today -> range in JS)
  const today = todayISO();
  const pendingCount: number = await galactic.db.count('approval_queue', { where: { status: 'pending' } });
  const approvedToday: number = await galactic.db.count('approval_queue', {
    where: { status: 'executed', resolved_at: dayRange(today) },
  });
  const rejectedToday: number = await galactic.db.count('approval_queue', {
    where: { status: 'rejected', resolved_at: dayRange(today) },
  });

  return {
    approvals: parsed,
    total: parsed.length,
    counts: {
      pending: pendingCount,
      approved_today: approvedToday,
      rejected_today: rejectedToday,
    },
  };
}

// ── APPROVALS ACT ──

export async function approvals_act(args: {
  approval_id: string;
  action: string;
  revision?: string;
  admin_notes?: string;
}): Promise<unknown> {
  const { approval_id, action, revision, admin_notes } = args;

  if (!approval_id || !action) throw new Error('approval_id and action are required');
  if (!['approve', 'reject', 'revise'].includes(action)) throw new Error('action must be "approve", "reject", or "revise"');

  const approval: ApprovalQueueRow | null = await galactic.db.first('approval_queue', {
    where: { id: approval_id },
  });
  if (!approval) throw new Error('Approval not found: ' + approval_id);
  if (approval.status !== 'pending') throw new Error('Approval already resolved: ' + approval.status);

  const payload = parseJsonObject(approval.payload);
  const now = nowISO();
  let result: unknown = null;

  if (action === 'reject') {
    await galactic.db.update('approval_queue', {
      set: { status: 'rejected', admin_notes: admin_notes || null, resolved_at: now, updated_at: now },
      where: { id: approval_id },
    });
    return { success: true, approval_id: approval_id, action: 'rejected' };
  }

  // Approve or revise
  if (approval.type === 'email_reply') {
    const emailBody = revision || (typeof payload.draft_body === 'string' ? payload.draft_body : '');
    const to = typeof payload.to === 'string' ? payload.to : '';
    const subject = typeof payload.subject === 'string' ? payload.subject : '';
    try {
      result = await email_send({
        to,
        subject,
        body: emailBody,
        in_reply_to: approval.original_email_id || undefined,
      });
    } catch (err) {
      // Still mark as executed but record the error
      result = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (approval.type === 'email_skip' && action === 'revise' && revision) {
    // Admin overrides skip — create a new reply approval with the revision as draft
    const newApprovalId = crypto.randomUUID();
    await galactic.db.insert('approval_queue', {
      id: newApprovalId,
      type: 'email_reply',
      status: 'pending',
      priority: 'normal',
      title: 'Override reply: ' + payload.subject,
      summary: 'Admin requested reply to previously skipped email',
      payload: JSON.stringify({ to: payload.from, subject: 'Re: ' + payload.subject, draft_body: revision, original_body: payload.original_body }),
      original_email_id: approval.original_email_id,
      created_at: now,
      updated_at: now,
    });
    result = { new_approval_id: newApprovalId, message: 'Reply draft created for approval' };
  }

  if (approval.type === 'db_change') {
    // Execute the proposed DB change via the structured API. The table name
    // arrives from the approval payload, so it is checked against an explicit
    // allowlist of this app's own tables — anything else throws.
    try {
      const data = asRecord(payload.data);
      const table = typeof payload.table === 'string' ? payload.table : '';
      if (payload.action === 'insert' && table && data) {
        if (!APP_TABLES.has(table)) {
          throw new Error('Table not allowed for approval-driven changes: ' + table);
        }
        const values: Record<string, unknown> = { id: crypto.randomUUID() };
        for (const [k, v] of Object.entries(data)) {
          if (k !== 'id' && k !== 'user_id') values[k] = v;
        }
        values.created_at = now;
        values.updated_at = now;
        await galactic.db.insert(table, values);
        result = { table: payload.table, action: 'inserted', data };
      } else if (payload.action === 'update' && table && data && data.id) {
        if (!APP_TABLES.has(table)) {
          throw new Error('Table not allowed for approval-driven changes: ' + table);
        }
        const id = data.id;
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          if (k !== 'id' && k !== 'user_id') set[k] = v;
        }
        set.updated_at = now;
        await galactic.db.update(table, { set, where: { id: id } });
        result = { table: payload.table, action: 'updated', id: id };
      } else {
        result = { message: 'DB change not auto-executable. Please apply manually.', payload: payload };
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const finalStatus = action === 'revise' ? 'revised' : 'executed';
  await galactic.db.update('approval_queue', {
    set: { status: finalStatus, admin_notes: admin_notes || null, resolved_at: now, updated_at: now },
    where: { id: approval_id },
  });

  return { success: true, approval_id: approval_id, action: finalStatus, result: result };
}

// ============================================
// 10. ADMIN & DB ACCESS
// ============================================

// ── DB TABLES ──

export async function db_tables(args: {}): Promise<unknown> {
  // Static schema reflection — we know our own tables
  const tables = [
    'rooms', 'room_reservations', 'ski_equipment', 'ski_rentals', 'ski_rental_items',
    'ski_lessons', 'tee_times', 'tee_time_carts', 'restaurant_reservations',
    'store_products', 'store_transactions', 'guidelines', 'approval_queue', 'email_log',
  ];

  const result: Array<{ name: string; row_count: number; error?: string }> = [];

  for (const table of tables) {
    try {
      const rowCount: number = await galactic.db.count(table);
      result.push({
        name: table,
        row_count: rowCount,
      });
    } catch (e) {
      result.push({ name: table, row_count: 0, error: 'table may not exist yet' });
    }
  }

  return { tables: result, total: result.length };
}
