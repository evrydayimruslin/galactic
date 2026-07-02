// Smart Budget — Galactic MCP App
// Track spending, manage budgets, and get financial insights.
// Storage: Galactic D1 (transactions, budgets)

const galactic = (globalThis as any).galactic;

// ── ADD TRANSACTION ──

export async function add(args: {
  amount: number;
  category: string;
  description?: string;
  date?: string;
  type?: string;
}): Promise<unknown> {
  const { amount, category, description, date, type } = args;
  const txDate = date || new Date().toISOString().split('T')[0];
  const id = crypto.randomUUID();
  const txType = type || 'expense';
  const now = new Date().toISOString();
  const cat = category.toLowerCase().trim();

  await galactic.db.insert('transactions', {
    id,
    amount,
    category: cat,
    description: description || '',
    date: txDate,
    type: txType,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    transaction_id: id,
    amount: amount,
    category: cat,
    type: txType,
    date: txDate,
  };
}

// ── REMOVE TRANSACTION ──

export async function remove(args: {
  transaction_id?: string;
  description?: string;
}): Promise<unknown> {
  const { transaction_id, description } = args;
  if (!transaction_id && !description) {
    return { success: false, error: 'Provide transaction_id or description.' };
  }

  const tx = transaction_id
    ? await galactic.db.first('transactions', { where: { id: transaction_id } })
    : await galactic.db.first('transactions', { where: { description: description } });

  if (!tx) {
    return { success: false, error: 'Transaction not found.' };
  }

  await galactic.db.delete('transactions', { where: { id: tx.id } });

  return {
    success: true,
    removed: {
      id: tx.id,
      amount: tx.amount,
      category: tx.category,
      description: tx.description,
      date: tx.date,
    },
  };
}

// ── LIST TRANSACTIONS ──

export async function list(args: {
  category?: string;
  month?: string;
  type?: string;
  limit?: number;
}): Promise<unknown> {
  const { category, month, type, limit } = args;
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const monthStart = targetMonth + '-01';
  const monthEnd = targetMonth + '-31';

  const where: Record<string, unknown> = {
    date: { gte: monthStart, lte: monthEnd },
  };
  if (category) {
    where.category = category.toLowerCase().trim();
  }
  if (type) {
    where.type = type;
  }

  const transactions = await galactic.db.select('transactions', {
    where,
    orderBy: { column: 'date', dir: 'desc' },
    limit: limit || 50,
  });

  const total = transactions.reduce((sum: number, t: any) => {
    return t.type === 'income' ? sum + t.amount : sum - t.amount;
  }, 0);

  return {
    month: targetMonth,
    count: transactions.length,
    transactions: transactions,
    net_total: total,
  };
}

// ── MONTHLY SUMMARY ──

export async function summary(args: {
  month?: string;
}): Promise<unknown> {
  const { month } = args;
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const monthStart = targetMonth + '-01';
  const monthEnd = targetMonth + '-31';

  const byCategory = await galactic.db.select('transactions', {
    columns: [
      'category',
      'type',
      { fn: 'count', as: 'count' },
      { fn: 'sum', column: 'amount', as: 'total' },
    ],
    where: { date: { gte: monthStart, lte: monthEnd } },
    groupBy: ['category', 'type'],
  });

  const categoryMap: Record<string, { spent: number; income: number; count: number }> = {};
  let totalSpent = 0;
  let totalIncome = 0;
  let transactionCount = 0;

  for (const row of byCategory) {
    if (!categoryMap[row.category]) {
      categoryMap[row.category] = { spent: 0, income: 0, count: 0 };
    }
    categoryMap[row.category].count += row.count;
    transactionCount += row.count;
    if (row.type === 'income') {
      categoryMap[row.category].income += row.total;
      totalIncome += row.total;
    } else {
      categoryMap[row.category].spent += row.total;
      totalSpent += row.total;
    }
  }

  // Check budgets for warnings
  const budgetWarnings: Array<{ category: string; limit: number; spent: number }> = [];
  for (const cat of Object.keys(categoryMap)) {
    const budgetData = await galactic.db.first('budgets', {
      where: { category: cat },
    });
    if (budgetData && budgetData.limit_amount) {
      if (categoryMap[cat].spent > budgetData.limit_amount * 0.8) {
        budgetWarnings.push({
          category: cat,
          limit: budgetData.limit_amount,
          spent: categoryMap[cat].spent,
        });
      }
    }
  }

  return {
    month: targetMonth,
    total_spent: totalSpent,
    total_income: totalIncome,
    net: totalIncome - totalSpent,
    transaction_count: transactionCount,
    by_category: categoryMap,
    budget_warnings: budgetWarnings,
  };
}

// ── BUDGET MANAGEMENT ──

export async function budget(args: {
  action?: string;
  category?: string;
  limit_amount?: number;
  period?: string;
}): Promise<unknown> {
  const { action, category, limit_amount, period } = args;

  // If limit_amount provided or action is "set", set the budget
  if (limit_amount !== undefined || action === 'set') {
    if (!category) {
      return { success: false, error: 'category is required when setting a budget' };
    }
    const cat = category.toLowerCase().trim();
    const now = new Date().toISOString();
    const per = period || 'monthly';

    const existing = await galactic.db.first('budgets', {
      columns: ['id'],
      where: { category: cat },
    });

    if (existing) {
      await galactic.db.update('budgets', {
        set: { limit_amount: limit_amount || 0, period: per, updated_at: now },
        where: { id: existing.id },
      });
    } else {
      const id = crypto.randomUUID();
      await galactic.db.insert('budgets', {
        id,
        category: cat,
        limit_amount: limit_amount || 0,
        period: per,
        created_at: now,
        updated_at: now,
      });
    }

    return { success: true, budget: { category: cat, limit_amount: limit_amount || 0, period: per, updated_at: now } };
  }

  // Otherwise, view budgets
  const budgets = await galactic.db.select('budgets');

  if (budgets.length === 0) {
    return { budgets: [], message: 'No budgets set yet. Use budget with category and limit_amount to set one.' };
  }

  return {
    budgets: budgets,
  };
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthStart = currentMonth + '-01';
  const monthEnd = currentMonth + '-31';

  // SUM(CASE WHEN type=... ) is not expressible — one grouped select on type, folded in JS.
  const byType = await galactic.db.select('transactions', {
    columns: [
      'type',
      { fn: 'count', as: 'count' },
      { fn: 'sum', column: 'amount', as: 'total' },
    ],
    where: { date: { gte: monthStart, lte: monthEnd } },
    groupBy: ['type'],
  });

  let transactionCount = 0;
  let totalSpent = 0;
  let totalIncome = 0;
  for (const row of byType) {
    transactionCount += row.count;
    if (row.type === 'income') {
      totalIncome += row.total ?? 0;
    } else if (row.type === 'expense') {
      totalSpent += row.total ?? 0;
    }
  }

  const categoriesUsed = await galactic.db.count('transactions', {
    where: { date: { gte: monthStart, lte: monthEnd } },
    column: 'category',
    distinct: true,
  });

  const budgetCount = await galactic.db.count('budgets');

  return {
    current_month: currentMonth,
    transaction_count: transactionCount,
    total_spent: totalSpent,
    total_income: totalIncome,
    net: totalIncome - totalSpent,
    categories_used: categoriesUsed || 0,
    budgets_set: budgetCount || 0,
  };
}
