// Reading List — Galactic MCP App
// Track books, articles, tweets, and papers. Save highlights, notes, and search semantically.
// Storage: Galactic D1 | Permissions: ai:call, net:fetch

const galactic = (globalThis as any).galactic;

// ── SAVE URL / ITEM ──

export async function save(args: {
  url?: string;
  title?: string;
  type?: string;
  tags?: string[];
  notes?: string;
}): Promise<unknown> {
  const { url, title, type, tags, notes } = args;
  const id = crypto.randomUUID();

  let itemTitle = title || '';
  let contentSnippet = '';
  let itemType = type || 'article';

  // Fetch URL content if provided
  if (url) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Galactic-ReadingList/1.0' },
      });
      const html = await response.text();

      // Extract title from HTML
      if (!itemTitle) {
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          itemTitle = titleMatch[1].trim();
        }
      }

      // Extract meta description
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      if (descMatch) {
        contentSnippet = descMatch[1].trim();
      }

      // Fallback: extract first meaningful text
      if (!contentSnippet) {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
          const text = bodyMatch[1]
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          contentSnippet = text.slice(0, 500);
        }
      }

      // Detect type from URL
      if (!type) {
        if (url.includes('twitter.com') || url.includes('x.com')) {
          itemType = 'tweet';
        } else if (url.includes('arxiv.org') || url.includes('scholar.google')) {
          itemType = 'paper';
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
          itemType = 'video';
        }
      }
    } catch (e) {
      // URL fetch failed — still save the item with what we have
    }
  }

  if (!itemTitle && !url) {
    return { success: false, error: 'Provide at least a URL or title.' };
  }

  // Generate embedding for semantic search
  let embedding: string | null = null;
  const embeddingText = (itemTitle + ' ' + contentSnippet + ' ' + (tags || []).join(' ')).trim();
  if (embeddingText) {
    try {
      const response = await galactic.ai({
        model: 'openai/text-embedding-3-small',
        input: embeddingText,
      });
      if (response && response.embedding) {
        embedding = JSON.stringify(response.embedding);
      }
    } catch (e) {
      // Embedding failed — save without it
    }
  }

  const now = new Date().toISOString();
  const finalTitle = itemTitle || url || 'Untitled';

  await galactic.db.insert('books', {
    id: id,
    url: url || null,
    title: finalTitle,
    type: itemType,
    content_snippet: contentSnippet,
    tags: JSON.stringify(tags || []),
    notes: notes || '',
    embedding: embedding,
    read_status: 'unread',
    saved_at: now,
    created_at: now,
    updated_at: now,
  });

  return {
    success: true,
    item_id: id,
    title: finalTitle,
    type: itemType,
    has_content: contentSnippet.length > 0,
    has_embedding: embedding !== null,
  };
}

// ── LIST ITEMS ──

export async function list(args: {
  tags?: string[];
  type?: string;
  status?: string;
  limit?: number;
}): Promise<unknown> {
  const { tags, type, status, limit } = args;

  const where: Record<string, any> = {};
  if (type) {
    where.type = type;
  }
  if (status) {
    where.read_status = status;
  }

  let items = await galactic.db.select('books', {
    columns: ['id', 'title', 'url', 'type', 'tags', 'read_status', 'saved_at'],
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { column: 'saved_at', dir: 'desc' },
    limit: limit || 20,
  });

  // Parse tags JSON and filter by tags in app layer if needed
  items = items.map((item: any) => ({
    ...item,
    tags: JSON.parse(item.tags || '[]'),
  }));

  if (tags && tags.length > 0) {
    items = items.filter((item: any) => {
      const itemTags = item.tags || [];
      return tags.some((t: string) => itemTags.includes(t));
    });
  }

  // Count highlights per item
  const result = [];
  for (const item of items) {
    const hCount = await galactic.db.count('highlights', {
      where: { book_id: item.id },
    });
    result.push({
      id: item.id,
      title: item.title,
      url: item.url,
      type: item.type,
      tags: item.tags,
      read_status: item.read_status,
      saved_at: item.saved_at,
      highlights_count: hCount,
    });
  }

  return {
    items: result,
    count: result.length,
  };
}

// ── SEARCH (SEMANTIC) ──

export async function search(args: {
  query: string;
  limit?: number;
}): Promise<unknown> {
  const { query, limit } = args;

  // Generate query embedding
  let queryEmbedding: number[] | null = null;
  try {
    const response = await galactic.ai({
      model: 'openai/text-embedding-3-small',
      input: query,
    });
    if (response && response.embedding) {
      queryEmbedding = response.embedding;
    }
  } catch (e) {
    // Fall back to text search
  }

  const items = await galactic.db.select('books', {
    columns: ['id', 'title', 'url', 'type', 'tags', 'content_snippet', 'notes', 'embedding', 'read_status'],
  });

  let scored: Array<{ item: any; score: number }> = [];

  if (queryEmbedding) {
    // Semantic search via cosine similarity
    for (const item of items) {
      const itemEmbedding = item.embedding ? JSON.parse(item.embedding) : null;
      if (itemEmbedding && itemEmbedding.length > 0) {
        const score = cosineSimilarity(queryEmbedding, itemEmbedding);
        scored.push({ item: item, score: score });
      } else {
        // Text fallback for items without embeddings
        const textScore = textMatch(query, item);
        if (textScore > 0) {
          scored.push({ item: item, score: textScore * 0.5 });
        }
      }
    }
  } else {
    // Pure text search fallback
    for (const item of items) {
      const textScore = textMatch(query, item);
      if (textScore > 0) {
        scored.push({ item: item, score: textScore });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, limit || 10);

  return {
    query: query,
    results: topResults.map((s) => ({
      id: s.item.id,
      title: s.item.title,
      url: s.item.url,
      type: s.item.type,
      tags: JSON.parse(s.item.tags || '[]'),
      score: Math.round(s.score * 100) / 100,
      snippet: s.item.content_snippet ? s.item.content_snippet.slice(0, 200) : '',
    })),
    count: topResults.length,
    method: queryEmbedding ? 'semantic' : 'text',
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

function textMatch(query: string, item: any): number {
  const q = query.toLowerCase();
  let score = 0;
  if (item.title && item.title.toLowerCase().includes(q)) score += 1;
  if (item.content_snippet && item.content_snippet.toLowerCase().includes(q)) score += 0.5;
  if (item.notes && item.notes.toLowerCase().includes(q)) score += 0.3;
  const parsedTags = JSON.parse(item.tags || '[]');
  if (parsedTags.some((t: string) => t.toLowerCase().includes(q))) score += 0.3;
  return score;
}

// ── HIGHLIGHT ──

export async function highlight(args: {
  item_id: string;
  text: string;
  note?: string;
}): Promise<unknown> {
  const { item_id, text, note } = args;

  const item = await galactic.db.first('books', {
    columns: ['id', 'title', 'read_status'],
    where: { id: item_id },
  });
  if (!item) {
    return { success: false, error: 'Item not found: ' + item_id };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await galactic.db.insert('highlights', {
    id: id,
    book_id: item_id,
    text: text,
    note: note || '',
    created_at: now,
    updated_at: now,
  });

  // Mark as reading if unread
  if (item.read_status === 'unread') {
    await galactic.db.update('books', {
      set: { read_status: 'reading', updated_at: now },
      where: { id: item_id },
    });
  }

  const hCount = await galactic.db.count('highlights', {
    where: { book_id: item_id },
  });

  return {
    success: true,
    item_title: item.title,
    highlights_count: hCount,
  };
}

// ── STATUS ──

export async function status(args?: {}): Promise<unknown> {
  const items = await galactic.db.select('books', {
    columns: ['id', 'type', 'read_status'],
  });

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    byStatus[item.read_status] = (byStatus[item.read_status] || 0) + 1;
  }

  const totalHighlights = await galactic.db.count('highlights');

  return {
    total_items: items.length,
    by_type: byType,
    by_status: byStatus,
    total_highlights: totalHighlights,
  };
}
