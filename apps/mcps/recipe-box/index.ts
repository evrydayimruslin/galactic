// Recipe Box — Galactic MCP App
// Save recipes, plan meals, generate grocery lists, and get AI recipe suggestions.
// Storage: Galactic D1 | Permissions: ai:call

const galactic = (globalThis as any).galactic;

// ── ADD RECIPE ──

export async function add_recipe(args: {
  name: string;
  ingredients: string[];
  steps: string[];
  prep_time?: number;
  cook_time?: number;
  servings?: number;
  tags?: string[];
  source?: string;
}): Promise<unknown> {
  const { name, ingredients, steps, prep_time, cook_time, servings, tags, source } = args;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await galactic.db.insert('recipes', {
    id,
    name,
    ingredients: JSON.stringify(ingredients),
    steps: JSON.stringify(steps),
    prep_time: prep_time || null,
    cook_time: cook_time || null,
    servings: servings || null,
    tags: JSON.stringify(tags || []),
    source: source || null,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    recipe_id: id,
    name: name,
    ingredients_count: ingredients.length,
    steps_count: steps.length,
  };
}

// ── GROCERY LIST ──

export async function grocery_list(args: {
  recipe_ids?: string[];
  items?: string[];
  name?: string;
}): Promise<unknown> {
  const { recipe_ids, items, name } = args;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const allItems: string[] = items ? [...items] : [];

  // Aggregate ingredients from recipes
  if (recipe_ids && recipe_ids.length > 0) {
    for (const recipeId of recipe_ids) {
      const recipe = await galactic.db.first('recipes', { where: { id: recipeId } });
      if (recipe) {
        const recipeIngredients = JSON.parse(recipe.ingredients);
        for (const ing of recipeIngredients) {
          if (!allItems.includes(ing)) {
            allItems.push(ing);
          }
        }
      }
    }
  }

  const listName = name || 'Grocery List ' + new Date().toISOString().split('T')[0];

  await galactic.db.insert('grocery_lists', {
    id,
    name: listName,
    items: JSON.stringify(allItems),
    checked_items: JSON.stringify([]),
    recipe_ids: JSON.stringify(recipe_ids || []),
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    list_id: id,
    name: listName,
    items: allItems,
    item_count: allItems.length,
  };
}

// ── MEAL PLAN ──

export async function meal_plan(args: {
  week_start?: string;
  day: string;
  meal_type: string;
  recipe_id?: string;
  description?: string;
}): Promise<unknown> {
  const { week_start, day, meal_type, recipe_id, description } = args;
  const weekKey = week_start || getWeekStart();
  const dayLower = day.toLowerCase();
  const now = new Date().toISOString();

  // Get recipe name if recipe_id provided
  let recipeName = description || '';
  if (recipe_id) {
    const recipe = await galactic.db.first('recipes', {
      columns: ['name'],
      where: { id: recipe_id },
    });
    if (recipe) {
      recipeName = recipe.name;
    }
  }

  const id = crypto.randomUUID();
  await galactic.db.insert('meal_plans', {
    id,
    week_start: weekKey,
    day: dayLower,
    meal_type,
    recipe_id: recipe_id || null,
    description: recipeName || description || '',
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    week_start: weekKey,
    day: dayLower,
    meal_type: meal_type,
    description: recipeName || description,
  };
}

function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  return monday.toISOString().split('T')[0];
}

// ── SUGGEST RECIPES (AI) ──

export async function suggest(args: {
  ingredients: string[];
  cuisine?: string;
  dietary?: string;
  count?: number;
}): Promise<unknown> {
  const { ingredients, cuisine, dietary, count } = args;

  let prompt = 'Suggest ' + (count || 3) + ' recipes using these ingredients: ' + ingredients.join(', ') + '.';
  if (cuisine) prompt += ' Cuisine preference: ' + cuisine + '.';
  if (dietary) prompt += ' Dietary restriction: ' + dietary + '.';
  prompt += ' For each recipe, provide: name, full ingredients list (including ones not in my list), and step-by-step instructions. Respond with ONLY valid JSON array, no markdown. Format: [{"name": "...", "ingredients": ["..."], "steps": ["..."]}]';

  try {
    const response = await galactic.ai({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a creative chef. Suggest recipes based on available ingredients. Respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    });

    const text = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const suggestions = JSON.parse(text);

    return {
      suggestions: suggestions,
      count: suggestions.length,
      based_on: ingredients,
    };
  } catch (e) {
    return { success: false, error: 'Could not generate recipe suggestions. Try again.' };
  }
}

// ── RECIPE WALKTHROUGH (AI) ──

export async function walkthrough(args: {
  recipe_id: string;
  step_number?: number;
}): Promise<unknown> {
  const { recipe_id, step_number } = args;

  const recipe = await galactic.db.first('recipes', { where: { id: recipe_id } });
  if (!recipe) {
    return { success: false, error: 'Recipe not found: ' + recipe_id };
  }

  const recipeIngredients = JSON.parse(recipe.ingredients);
  const recipeSteps = JSON.parse(recipe.steps);

  let prompt = '';
  if (step_number !== undefined && step_number >= 0 && step_number < recipeSteps.length) {
    prompt = 'Recipe: ' + recipe.name + '\nCurrent step (' + (step_number + 1) + ' of ' + recipeSteps.length + '): ' + recipeSteps[step_number] + '\n\nProvide detailed guidance for this step: timing tips, technique details, common mistakes to avoid, and how to know when it\'s done right.';
  } else {
    prompt = 'Recipe: ' + recipe.name + '\nIngredients: ' + recipeIngredients.join(', ') + '\nSteps:\n' + recipeSteps.map((s: string, i: number) => (i + 1) + '. ' + s).join('\n') + '\n\nProvide a complete walkthrough with timing tips, technique details, and helpful hints for each step.';
  }

  try {
    const response = await galactic.ai({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a friendly cooking instructor. Guide the user through the recipe with clear, helpful instructions.' },
        { role: 'user', content: prompt },
      ],
    });

    return {
      recipe_name: recipe.name,
      step_number: step_number !== undefined ? step_number + 1 : null,
      total_steps: recipeSteps.length,
      guidance: response.content,
    };
  } catch (e) {
    return { success: false, error: 'Could not generate walkthrough.' };
  }
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  const recipeCount = await galactic.db.count('recipes');

  const groceryCount = await galactic.db.count('grocery_lists');

  const planCount = await galactic.db.count('meal_plans', {
    column: 'week_start',
    distinct: true,
  });

  // Check this week's meal plan
  const weekKey = getWeekStart();
  const mealsThisWeek = await galactic.db.count('meal_plans', {
    where: { week_start: weekKey },
  });

  return {
    total_recipes: recipeCount || 0,
    grocery_lists: groceryCount || 0,
    meal_plans: planCount || 0,
    meals_planned_this_week: mealsThisWeek || 0,
  };
}
