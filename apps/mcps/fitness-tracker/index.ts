// Fitness Tracker — Galactic MCP App
// Log meals, workouts, sleep, and body metrics. AI-powered calorie estimation.
// Storage: Galactic D1 | Permissions: ai:call

const galactic = (globalThis as any).galactic;

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ── LOG MEAL ──

export async function log_meal(args: {
  description: string;
  meal_type?: string;
  date?: string;
}): Promise<unknown> {
  const { description, meal_type, date } = args;
  const mealDate = date || today();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // AI calorie estimation
  let nutrition = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  try {
    const response = await galactic.ai({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a nutrition estimator. Given a food description, estimate the nutritional content. Respond with ONLY valid JSON, no markdown. Format: {"calories": number, "protein_g": number, "carbs_g": number, "fat_g": number}',
        },
        {
          role: 'user',
          content: 'Estimate nutrition for: ' + description,
        },
      ],
    });
    const text = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    nutrition = JSON.parse(text);
  } catch (e) {
    // If AI fails, store with zero values — user can update later
  }

  await galactic.db.insert('meals', {
    id: id,
    description: description,
    meal_type: meal_type || 'meal',
    date: mealDate,
    calories: nutrition.calories,
    protein_g: nutrition.protein_g,
    carbs_g: nutrition.carbs_g,
    fat_g: nutrition.fat_g,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    meal_id: id,
    description: description,
    calories: nutrition.calories,
    protein_g: nutrition.protein_g,
    carbs_g: nutrition.carbs_g,
    fat_g: nutrition.fat_g,
  };
}

// ── LOG WORKOUT ──

export async function log_workout(args: {
  type: string;
  duration_min: number;
  calories_burned?: number;
  notes?: string;
  date?: string;
}): Promise<unknown> {
  const { type, duration_min, calories_burned, notes, date } = args;
  const workoutDate = date || today();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await galactic.db.insert('workouts', {
    id: id,
    type: type,
    duration_min: duration_min,
    calories_burned: calories_burned || 0,
    notes: notes || '',
    date: workoutDate,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    workout_id: id,
    type: type,
    duration_min: duration_min,
    calories_burned: calories_burned || 0,
  };
}

// ── LOG SLEEP ──

export async function log_sleep(args: {
  hours: number;
  quality?: number;
  notes?: string;
  date?: string;
}): Promise<unknown> {
  const { hours, quality, notes, date } = args;
  const sleepDate = date || today();
  const now = new Date().toISOString();
  const qualityVal = quality !== undefined ? Math.min(5, Math.max(1, quality)) : null;

  // Upsert: replace if already logged for this date
  const existing = await galactic.db.first('sleep_logs', {
    columns: ['id'],
    where: { date: sleepDate },
  });

  if (existing) {
    await galactic.db.update('sleep_logs', {
      set: { hours: hours, quality: qualityVal, notes: notes || '', updated_at: now },
      where: { id: existing.id },
    });
  } else {
    const id = crypto.randomUUID();
    await galactic.db.insert('sleep_logs', {
      id: id,
      hours: hours,
      quality: qualityVal,
      notes: notes || '',
      date: sleepDate,
      created_at: now,
      updated_at: now,
    });
  }

  return {
    success: true,
    date: sleepDate,
    hours: hours,
    quality: qualityVal,
  };
}

// ── LOG WEIGHT ──

export async function log_weight(args: {
  value: number;
  unit?: string;
  date?: string;
}): Promise<unknown> {
  const { value, unit, date } = args;
  const weightDate = date || today();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await galactic.db.insert('weight_logs', {
    id: id,
    value: value,
    unit: unit || 'lbs',
    date: weightDate,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    date: weightDate,
    value: value,
    unit: unit || 'lbs',
  };
}

// ── SUMMARY ──

export async function summary(args: {
  period?: string;
  date?: string;
}): Promise<unknown> {
  const { period, date } = args;
  const targetDate = date || today();

  if (period === 'weekly') {
    // Get the last 7 days
    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }
    const startDate = days[days.length - 1];
    const endDate = days[0];

    const mealStats = await galactic.db.first('meals', {
      columns: [
        { fn: 'count', as: 'count' },
        { fn: 'sum', column: 'calories', as: 'total_calories' },
        { fn: 'sum', column: 'protein_g', as: 'protein_g' },
        { fn: 'sum', column: 'carbs_g', as: 'carbs_g' },
        { fn: 'sum', column: 'fat_g', as: 'fat_g' },
      ],
      where: { date: { gte: startDate, lte: endDate } },
    });

    const workoutStats = await galactic.db.first('workouts', {
      columns: [
        { fn: 'count', as: 'count' },
        { fn: 'sum', column: 'duration_min', as: 'total_minutes' },
        { fn: 'sum', column: 'calories_burned', as: 'total_calories_burned' },
      ],
      where: { date: { gte: startDate, lte: endDate } },
    });

    const sleepStats = await galactic.db.first('sleep_logs', {
      columns: [
        { fn: 'count', as: 'days_logged' },
        { fn: 'avg', column: 'hours', as: 'avg_hours' },
      ],
      where: { date: { gte: startDate, lte: endDate } },
    });

    return {
      period: 'weekly',
      days: 7,
      meals: {
        count: mealStats?.count || 0,
        total_calories: mealStats?.total_calories || 0,
        avg_daily_calories: Math.round((mealStats?.total_calories || 0) / 7),
        protein_g: mealStats?.protein_g || 0,
        carbs_g: mealStats?.carbs_g || 0,
        fat_g: mealStats?.fat_g || 0,
      },
      workouts: {
        count: workoutStats?.count || 0,
        total_minutes: workoutStats?.total_minutes || 0,
        total_calories_burned: workoutStats?.total_calories_burned || 0,
      },
      sleep: {
        days_logged: sleepStats?.days_logged || 0,
        avg_hours: sleepStats?.days_logged > 0 ? Math.round(sleepStats.avg_hours * 10) / 10 : 0,
      },
    };
  }

  // Default: daily summary
  const meals = await galactic.db.select('meals', {
    where: { date: targetDate },
  });

  const workouts = await galactic.db.select('workouts', {
    where: { date: targetDate },
  });

  const daySleep = await galactic.db.first('sleep_logs', {
    where: { date: targetDate },
  });

  const dayWeight = await galactic.db.first('weight_logs', {
    where: { date: targetDate },
    orderBy: { column: 'created_at', dir: 'desc' },
  });

  let totalCal = 0;
  let totalProt = 0;
  let totalCarb = 0;
  let totalFatD = 0;
  for (const meal of meals) {
    totalCal += meal.calories || 0;
    totalProt += meal.protein_g || 0;
    totalCarb += meal.carbs_g || 0;
    totalFatD += meal.fat_g || 0;
  }

  let workoutMin = 0;
  let calBurned = 0;
  for (const workout of workouts) {
    workoutMin += workout.duration_min || 0;
    calBurned += workout.calories_burned || 0;
  }

  return {
    period: 'daily',
    date: targetDate,
    meals: { items: meals, total_calories: totalCal, protein_g: totalProt, carbs_g: totalCarb, fat_g: totalFatD },
    workouts: { items: workouts, total_minutes: workoutMin, calories_burned: calBurned },
    sleep: daySleep || null,
    weight: dayWeight || null,
    net_calories: totalCal - calBurned,
  };
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  const todayStr = today();

  const mealCount = await galactic.db.count('meals', {
    where: { date: todayStr },
  });

  const workoutCount = await galactic.db.count('workouts', {
    where: { date: todayStr },
  });

  const todaySleep = await galactic.db.first('sleep_logs', {
    columns: ['id'],
    where: { date: todayStr },
  });

  const todayWeight = await galactic.db.first('weight_logs', {
    columns: ['id'],
    where: { date: todayStr },
  });

  return {
    date: todayStr,
    meals_logged_today: mealCount || 0,
    workouts_logged_today: workoutCount || 0,
    sleep_logged_today: todaySleep ? true : false,
    weight_logged_today: todayWeight ? true : false,
  };
}
