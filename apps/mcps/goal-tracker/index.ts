// Goal Tracker — Galactic MCP App
// Set goals, break them into milestones, and track progress over time.
// Storage: Galactic D1 (goals, milestones, progress_logs) via the structured
// galactic.db API — the platform scopes every query to the calling user.

const galactic = (globalThis as any).galactic;

// ── ADD GOAL ──

export async function add_goal(args: {
  name: string;
  description?: string;
  target_date?: string;
  milestones?: Array<{ name: string; target_date?: string }>;
}): Promise<unknown> {
  const { name, description, target_date, milestones } = args;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await galactic.db.insert('goals', {
    id,
    name,
    description: description || '',
    target_date: target_date || null,
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  // Create milestones if provided
  let milestonesCreated = 0;
  if (milestones && milestones.length > 0) {
    for (let idx = 0; idx < milestones.length; idx++) {
      const m = milestones[idx];
      const mId = crypto.randomUUID();
      await galactic.db.insert('milestones', {
        id: mId,
        goal_id: id,
        name: m.name,
        target_date: m.target_date || null,
        completed: 0,
        sort_order: idx,
        created_at: now,
        updated_at: now,
      });
      milestonesCreated++;
    }
  }

  return {
    success: true,
    goal_id: id,
    name: name,
    milestones_created: milestonesCreated,
  };
}

// ── ADD MILESTONE ──

export async function add_milestone(args: {
  goal_id: string;
  name: string;
  target_date?: string;
}): Promise<unknown> {
  const { goal_id, name, target_date } = args;

  const goal = await galactic.db.first('goals', { where: { id: goal_id } });
  if (!goal) {
    return { success: false, error: 'Goal not found: ' + goal_id };
  }

  // Get existing milestones count for ordering
  const existingCount = await galactic.db.count('milestones', {
    where: { goal_id: goal_id },
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await galactic.db.insert('milestones', {
    id,
    goal_id,
    name,
    target_date: target_date || null,
    completed: 0,
    sort_order: existingCount || 0,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    milestone_id: id,
    goal_id: goal_id,
    name: name,
  };
}

// ── UPDATE PROGRESS ──

export async function update(args: {
  goal_id?: string;
  milestone_id?: string;
  completed?: boolean;
  notes?: string;
  percent_complete?: number;
  status?: string;
}): Promise<unknown> {
  const { goal_id, milestone_id, completed, notes, percent_complete, status } = args;

  // Update a milestone
  if (milestone_id && goal_id) {
    const milestone = await galactic.db.first('milestones', {
      where: { id: milestone_id, goal_id: goal_id },
    });
    if (!milestone) {
      return { success: false, error: 'Milestone not found' };
    }

    const now = new Date().toISOString();
    const newCompleted = completed !== undefined ? (completed ? 1 : 0) : milestone.completed;
    const newCompletedAt = completed ? now : (completed === false ? null : milestone.completed_at);

    await galactic.db.update('milestones', {
      set: { completed: newCompleted, completed_at: newCompletedAt, updated_at: now },
      where: { id: milestone_id },
    });

    return { success: true, milestone: { ...milestone, completed: newCompleted, completed_at: newCompletedAt } };
  }

  // Update a goal
  if (goal_id) {
    const goal = await galactic.db.first('goals', { where: { id: goal_id } });
    if (!goal) {
      return { success: false, error: 'Goal not found' };
    }

    const now = new Date().toISOString();
    let newStatus = goal.status;
    if (status) newStatus = status;
    if (completed) newStatus = 'completed';

    await galactic.db.update('goals', {
      set: { status: newStatus, updated_at: now },
      where: { id: goal_id },
    });

    // Log progress entry
    if (notes || percent_complete !== undefined) {
      const today = new Date().toISOString().split('T')[0];
      const progressId = crypto.randomUUID();
      await galactic.db.insert('progress_logs', {
        id: progressId,
        goal_id,
        date: today,
        notes: notes || '',
        percent_complete: percent_complete !== undefined ? percent_complete : null,
        created_at: now,
        updated_at: now,
      });
    }

    return { success: true, goal: { ...goal, status: newStatus } };
  }

  return { success: false, error: 'Provide goal_id (and optionally milestone_id) to update' };
}

// ── LIST GOALS ──

export async function list(args: {
  status?: string;
  limit?: number;
}): Promise<unknown> {
  const { status: filterStatus, limit } = args;

  const where: Record<string, unknown> = {};
  if (filterStatus && filterStatus !== 'all') {
    where.status = filterStatus;
  }

  const goalRows = await galactic.db.select('goals', {
    where,
    orderBy: { column: 'created_at', dir: 'desc' },
    limit: limit || 20,
  });

  const goals = [];
  for (const goal of goalRows) {
    const milestones = await galactic.db.select('milestones', {
      where: { goal_id: goal.id },
      orderBy: { column: 'sort_order', dir: 'asc' },
    });

    const completedCount = milestones.filter((m: any) => m.completed).length;
    const progress = milestones.length > 0
      ? Math.round((completedCount / milestones.length) * 100)
      : 0;

    goals.push({
      id: goal.id,
      name: goal.name,
      description: goal.description,
      status: goal.status,
      target_date: goal.target_date,
      milestones: milestones,
      progress_percent: progress,
      milestones_completed: completedCount,
      milestones_total: milestones.length,
    });
  }

  return { goals: goals, count: goals.length };
}

// ── REVIEW ──

export async function review(args?: {}): Promise<unknown> {
  const goalRows = await galactic.db.select('goals', {
    where: { status: 'active' },
  });

  const today = new Date().toISOString().split('T')[0];
  const overdue: any[] = [];
  const upcoming: any[] = [];
  const summaries: any[] = [];

  for (const goal of goalRows) {
    const milestones = await galactic.db.select('milestones', {
      where: { goal_id: goal.id },
    });

    const completedCount = milestones.filter((m: any) => m.completed).length;
    const progress = milestones.length > 0
      ? Math.round((completedCount / milestones.length) * 100)
      : 0;

    summaries.push({
      name: goal.name,
      progress_percent: progress,
      target_date: goal.target_date,
    });

    if (goal.target_date && goal.target_date < today) {
      overdue.push({ name: goal.name, target_date: goal.target_date });
    }

    // Check upcoming milestones (within 7 days)
    const sevenDaysLater = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    for (const m of milestones) {
      if (!m.completed && m.target_date && m.target_date >= today && m.target_date <= sevenDaysLater) {
        upcoming.push({ goal: goal.name, milestone: m.name, target_date: m.target_date });
      }
    }
  }

  return {
    active_goals: summaries.length,
    summaries: summaries,
    overdue: overdue,
    upcoming_milestones: upcoming,
  };
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  // SUM(CASE WHEN status = ...) isn't expressible in the structured API:
  // one grouped count per status, folded in JS.
  const rows = await galactic.db.select('goals', {
    columns: ['status', { fn: 'count', as: 'n' }],
    groupBy: ['status'],
  });

  let total = 0;
  let active = 0;
  let completed = 0;
  for (const row of rows) {
    const n = Number(row.n) || 0;
    total += n;
    if (row.status === 'active') active += n;
    if (row.status === 'completed') completed += n;
  }

  return {
    total_goals: total || 0,
    active: active || 0,
    completed: completed || 0,
  };
}
