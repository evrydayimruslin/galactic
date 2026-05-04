// Memory Wiki — Ultralight MCP App
// Personal knowledge wiki with raw backlog, compiled pages, cross-references, lint.
// 10 tools: search, query, browse, ingest, sync, lint, update_page, create_wiki, widget_wiki_browser_ui, widget_wiki_browser_data
// Storage: Ultralight D1 | Permissions: ai:call

const ultralight = globalThis.ultralight;

type SqlValue = string | number | null;
type LintSeverity = 'info' | 'warning' | 'error';

interface WikiIdRow {
  id: string;
}

interface CountRow {
  count: number;
}

interface WikiPageRow {
  id: string;
  wiki_id: string;
  title: string;
  slug: string;
  content: string;
  page_type: string;
  due_date?: string | null;
}

interface WikiPageListRow {
  id: string;
  title: string;
  slug: string;
  page_type: string;
}

interface WikiPageSearchRow extends WikiPageListRow {
  snippet: string;
}

interface LinkedWikiPageRow extends WikiPageListRow {
  link_type: string;
}

interface WikiSourceRow {
  id: string;
  title: string;
  content: string;
  source_type: string;
  classification: string;
  created_at?: string;
}

interface WikiSourceSearchRow {
  id: string;
  title: string;
  classification: string;
  snippet: string;
}

interface WikiTypeCountRow {
  page_type: string;
  count: number;
}

interface CompiledCreateRow {
  title: string;
  slug: string;
  content: string;
  page_type?: string;
  due_date?: string | null;
}

interface CompiledUpdateRow {
  slug: string;
  append_content: string;
}

interface CompiledWikiPayload {
  creates?: CompiledCreateRow[];
  updates?: CompiledUpdateRow[];
}

interface LintIssue {
  severity: LintSeverity;
  type: string;
  message: string;
  page_slug?: string;
}

interface ContradictionCandidate {
  pages?: string[];
  description: string;
}

interface GapCandidate {
  topic: string;
  reason: string;
}

function extractJsonBlock(raw: string): string {
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return jsonMatch?.[1] || raw;
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function uid() { return ultralight.user.id; }

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function ensureDefaultWiki(): Promise<string> {
  const existing: WikiIdRow | null = await ultralight.db.first(
    'SELECT id FROM wikis WHERE user_id = ? AND name = ?', [uid(), 'Personal']
  );
  if (existing) return existing.id;
  const id = uuid();
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO wikis (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, uid(), 'Personal', 'Your personal knowledge wiki', ts, ts]
  );
  return id;
}

async function resolveWiki(wiki_id?: string): Promise<string> {
  if (wiki_id) {
    const w: WikiIdRow | null = await ultralight.db.first(
      'SELECT id FROM wikis WHERE (id = ? OR name = ?) AND user_id = ?', [wiki_id, wiki_id, uid()]
    );
    if (w) return w.id;
  }
  return ensureDefaultWiki();
}

async function syncLinks(pageId: string, wikiId: string, content: string): Promise<void> {
  await ultralight.db.run('DELETE FROM links WHERE from_page_id = ? AND user_id = ?', [pageId, uid()]);
  const linkMatches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const match of linkMatches) {
    const targetSlug = slugify(match[1]);
    const targetPage: WikiIdRow | null = await ultralight.db.first(
      'SELECT id FROM pages WHERE slug = ? AND wiki_id = ? AND user_id = ?', [targetSlug, wikiId, uid()]
    );
    if (targetPage) {
      await ultralight.db.run(
        'INSERT INTO links (id, user_id, wiki_id, from_page_id, to_page_id, link_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), uid(), wikiId, pageId, targetPage.id, 'mentions', now()]
      );
    }
  }
}

// ── CORE FUNCTIONS ──

export async function ingest(args: {
  content: string; title: string; wiki_id?: string;
  source_type?: string; classification?: string;
}): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);
  const id = uuid();
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO sources (id, user_id, wiki_id, title, content, source_type, classification, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, uid(), wikiId, args.title, args.content, args.source_type || 'note', args.classification || 'general', ts, ts]
  );
  return { source_id: id, title: args.title };
}

export async function search(args: { query: string; wiki_id?: string }): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);
  const q = `%${args.query}%`;

  const pages: WikiPageSearchRow[] = await ultralight.db.all(
    'SELECT id, title, slug, page_type, substr(content, 1, 200) as snippet FROM pages WHERE wiki_id = ? AND user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT 20',
    [wikiId, uid(), q, q]
  );

  const sources: WikiSourceSearchRow[] = await ultralight.db.all(
    'SELECT id, title, classification, substr(content, 1, 200) as snippet FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC LIMIT 10',
    [wikiId, uid(), q, q]
  );

  return { pages: pages, sources: sources };
}

export async function browse(args: {
  wiki_id?: string; page_type?: string; page_id?: string; search?: string;
}): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);

  if (args.page_id) {
    const page: WikiPageRow | null = await ultralight.db.first(
      'SELECT * FROM pages WHERE id = ? AND user_id = ?', [args.page_id, uid()]
    );
    if (!page) return { error: 'Page not found' };

    const linkedPages: LinkedWikiPageRow[] = await ultralight.db.all(
      `SELECT p.id, p.title, p.slug, p.page_type, l.link_type FROM pages p
       JOIN links l ON (l.to_page_id = p.id AND l.from_page_id = ?) OR (l.from_page_id = p.id AND l.to_page_id = ?)
       WHERE p.user_id = ?
       LIMIT 20`,
      [args.page_id, args.page_id, uid()]
    );
    return { page: page, linked_pages: linkedPages };
  }

  if (args.search) {
    const q = `%${args.search}%`;
    const pages: WikiPageListRow[] = await ultralight.db.all(
      'SELECT id, title, slug, page_type FROM pages WHERE wiki_id = ? AND user_id = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT 20',
      [wikiId, uid(), q]
    );
    return { pages: pages };
  }

  if (args.page_type) {
    const pages: WikiPageListRow[] = await ultralight.db.all(
      'SELECT id, title, slug, page_type FROM pages WHERE wiki_id = ? AND user_id = ? AND page_type = ? ORDER BY updated_at DESC LIMIT 30',
      [wikiId, uid(), args.page_type]
    );
    return { pages: pages };
  }

  // Default: overview
  const typeCounts: WikiTypeCountRow[] = await ultralight.db.all(
    'SELECT page_type, COUNT(*) as count FROM pages WHERE wiki_id = ? AND user_id = ? GROUP BY page_type',
    [wikiId, uid()]
  );
  const recentPages: WikiPageListRow[] = await ultralight.db.all(
    'SELECT id, title, slug, page_type FROM pages WHERE wiki_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 5',
    [wikiId, uid()]
  );
  const unsyncedResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL',
    [wikiId, uid()]
  );
  return {
    type_counts: typeCounts,
    recent_pages: recentPages,
    unsynced_count: unsyncedResult?.count || 0,
  };
}

export async function update_page(args: {
  page_id: string; content?: string; title?: string; page_type?: string;
}): Promise<unknown> {
  const page: Pick<WikiPageRow, 'id' | 'wiki_id' | 'slug'> | null = await ultralight.db.first(
    'SELECT id, wiki_id, slug FROM pages WHERE id = ? AND user_id = ?', [args.page_id, uid()]
  );
  if (!page) return { success: false, error: 'Page not found' };

  const fields: string[] = [];
  const values: SqlValue[] = [];
  if (args.content !== undefined) { fields.push('content = ?'); values.push(args.content); }
  if (args.title !== undefined) {
    fields.push('title = ?'); values.push(args.title);
    fields.push('slug = ?'); values.push(slugify(args.title));
  }
  if (args.page_type !== undefined) { fields.push('page_type = ?'); values.push(args.page_type); }

  if (fields.length === 0) return { success: false, error: 'No fields to update' };

  fields.push('updated_at = ?'); values.push(now());
  values.push(args.page_id, uid());

  await ultralight.db.run(`UPDATE pages SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, values);

  if (args.content !== undefined) {
    await syncLinks(args.page_id, page.wiki_id, args.content);
  }

  return { success: true, page_id: args.page_id, slug: args.title ? slugify(args.title) : page.slug };
}

export async function create_wiki(args: { name: string; description?: string }): Promise<unknown> {
  const id = uuid();
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO wikis (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, uid(), args.name, args.description || '', ts, ts]
  );
  return { wiki_id: id, name: args.name };
}

// ── AI FUNCTIONS ──

export async function query(args: {
  question: string; wiki_id?: string; save?: boolean;
}): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);

  // Find relevant pages by keyword from the question
  const words = args.question.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  const conditions = words.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
  const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);

  let relevantPages: WikiPageRow[] = [];
  if (conditions) {
    relevantPages = await ultralight.db.all(
      `SELECT id, title, slug, content, page_type FROM pages WHERE wiki_id = ? AND user_id = ? AND (${conditions}) ORDER BY updated_at DESC LIMIT 10`,
      [wikiId, uid(), ...params]
    );
  }

  if (relevantPages.length === 0) {
    relevantPages = await ultralight.db.all(
      'SELECT id, title, slug, content, page_type FROM pages WHERE wiki_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 5',
      [wikiId, uid()]
    );
  }

  // Follow one level of links
  if (relevantPages.length > 0) {
    const pageIds = relevantPages.map((page) => page.id);
    const placeholders = pageIds.map(() => '?').join(',');
    const linkedPages: WikiPageRow[] = await ultralight.db.all(
      `SELECT DISTINCT p.id, p.title, p.slug, p.content, p.page_type FROM pages p
       JOIN links l ON l.to_page_id = p.id
       WHERE l.from_page_id IN (${placeholders}) AND p.user_id = ? AND p.id NOT IN (${placeholders})
       LIMIT 10`,
      [...pageIds, uid(), ...pageIds]
    );
    relevantPages = [...relevantPages, ...linkedPages];
  }

  // Also check unsynced sources
  const unsyncedSources: Pick<WikiSourceRow, 'title' | 'content'>[] = await ultralight.db.all(
    'SELECT title, content FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL ORDER BY created_at DESC LIMIT 5',
    [wikiId, uid()]
  );

  // Build context
  let context = '';
  for (const p of relevantPages) {
    context += `## ${p.title} [${p.page_type}]\n${p.content}\n\n`;
  }
  for (const s of unsyncedSources) {
    context += `## [Unsynced Note] ${s.title}\n${s.content}\n\n`;
  }

  if (!context) {
    return { answer: 'Your wiki is empty. Use ingest() to add content, then sync() to compile it.', sources: [] };
  }

  const response = await ultralight.ai({
    model: 'openai/gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are answering a question using ONLY the wiki content provided. Cite relevant pages with [[page-slug]] wikilinks. If the wiki lacks information to answer, say so explicitly. Be concise and specific.',
      },
      {
        role: 'user',
        content: `Wiki content:\n${context}\n\nQuestion: ${args.question}`,
      },
    ],
  });

  const answer = response.content || '';
  const citedSlugs = [...answer.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]);

  let savedPageId: string | undefined;
  if (args.save) {
    const pageId = uuid();
    const ts = now();
    const title = `Q: ${args.question.slice(0, 60)}`;
    const slug = slugify(title);
    await ultralight.db.run(
      'INSERT INTO pages (id, user_id, wiki_id, title, slug, content, page_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [pageId, uid(), wikiId, title, slug, answer, 'synthesis', ts, ts]
    );
    await syncLinks(pageId, wikiId, answer);
    savedPageId = pageId;

    await ultralight.db.run(
      'INSERT INTO activity (id, user_id, wiki_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), uid(), wikiId, 'query', `Saved synthesis: ${title}`, ts]
    );
  }

  return { answer: answer, sources: citedSlugs, saved_page_id: savedPageId };
}

export async function sync(args: { wiki_id?: string }): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);

  // 1. Read unsynced sources
  const unsynced: WikiSourceRow[] = await ultralight.db.all(
    'SELECT id, title, content, source_type, classification FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL ORDER BY created_at ASC LIMIT 20',
    [wikiId, uid()]
  );

  if (unsynced.length === 0) {
    return { synced: 0, pages_created: 0, pages_updated: 0, lint_issues: [] };
  }

  // 2. Read existing page titles for merge context
  const existingPages: Pick<WikiPageRow, 'slug' | 'title' | 'page_type'>[] = await ultralight.db.all(
    'SELECT slug, title, page_type FROM pages WHERE wiki_id = ? AND user_id = ?',
    [wikiId, uid()]
  );
  const existingList = existingPages.map((page) => `- [[${page.slug}]] (${page.page_type}): ${page.title}`).join('\n');

  // 3. Build source content for AI
  let sourcesText = '';
  for (const s of unsynced) {
    sourcesText += `### ${s.title} [${s.source_type}/${s.classification}]\n${s.content}\n\n`;
  }

  // 4. Call AI to compile
  const response = await ultralight.ai({
    model: 'openai/gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a knowledge compiler. Given raw source notes and an existing wiki page list, extract discrete typed entities and produce wiki page creates/updates.

Rules:
- Extract DISCRETE entities: each person, decision, commitment, deadline, concept, or preference becomes its own page
- Do NOT create summary pages combining multiple entities — one entity per page
- If a page already exists (matching slug in the existing list), output an UPDATE with content to append
- If no existing page matches, output a CREATE
- Use [[slug]] wikilinks to cross-reference between pages
- page_type must be one of: person, decision, commitment, deadline, concept, preference, app_catalog, comparison
- Slugs: lowercase, hyphen-separated, max 80 chars
- If a source mentions a due date, include due_date in ISO 8601 format
- Be concise — wiki pages should be clear and scannable

Output ONLY valid JSON:
{
  "creates": [
    { "title": "Page Title", "slug": "page-title", "content": "Markdown content with [[wikilinks]]...", "page_type": "concept", "due_date": null }
  ],
  "updates": [
    { "slug": "existing-page-slug", "append_content": "\\n\\nNew information to append..." }
  ]
}`,
      },
      {
        role: 'user',
        content: `## Existing Wiki Pages\n${existingList || '(empty wiki)'}\n\n## New Sources to Compile\n${sourcesText}`,
      },
    ],
  });

  // 5. Parse AI response
  let compiled: CompiledWikiPayload;
  try {
    const raw = response.content || '';
    compiled = JSON.parse(extractJsonBlock(raw)) as CompiledWikiPayload;
  } catch {
    compiled = { creates: [], updates: [] };
  }

  const ts = now();
  let pagesCreated = 0;
  let pagesUpdated = 0;

  // 6. Execute creates
  for (const page of compiled.creates || []) {
    if (!page.title || !page.slug || !page.content) continue;
    const pageId = uuid();
    await ultralight.db.run(
      'INSERT INTO pages (id, user_id, wiki_id, title, slug, content, page_type, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [pageId, uid(), wikiId, page.title, page.slug, page.content, page.page_type || 'concept', page.due_date || null, ts, ts]
    );
    await syncLinks(pageId, wikiId, page.content);
    pagesCreated++;
  }

  // 7. Execute updates
  for (const update of compiled.updates || []) {
    if (!update.slug || !update.append_content) continue;
    const existing: Pick<WikiPageRow, 'id' | 'content'> | null = await ultralight.db.first(
      'SELECT id, content FROM pages WHERE slug = ? AND wiki_id = ? AND user_id = ?',
      [update.slug, wikiId, uid()]
    );
    if (!existing) continue;
    const newContent = existing.content + update.append_content;
    await ultralight.db.run(
      'UPDATE pages SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [newContent, ts, existing.id, uid()]
    );
    await syncLinks(existing.id, wikiId, newContent);
    pagesUpdated++;
  }

  // 8. Mark sources synced
  const sourceIds = unsynced.map((source) => source.id);
  for (const sid of sourceIds) {
    await ultralight.db.run(
      'UPDATE sources SET synced_at = ? WHERE id = ? AND user_id = ?', [ts, sid, uid()]
    );
  }

  // 9. Quick structural lint
  const orphans: Pick<WikiPageRow, 'id' | 'title' | 'slug'>[] = await ultralight.db.all(
    `SELECT p.id, p.title, p.slug FROM pages p
     LEFT JOIN links l ON l.to_page_id = p.id
     WHERE p.wiki_id = ? AND p.user_id = ? AND l.id IS NULL AND p.page_type != 'index'`,
    [wikiId, uid()]
  );
  const lintIssues: LintIssue[] = orphans.map((orphan) => ({
    severity: 'info', type: 'orphan', message: `No inbound links to "${orphan.title}"`, page_slug: orphan.slug,
  }));

  // 10. Log activity
  await ultralight.db.run(
    'INSERT INTO activity (id, user_id, wiki_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uuid(), uid(), wikiId, 'sync', `Synced ${unsynced.length} sources → ${pagesCreated} created, ${pagesUpdated} updated`, ts]
  );

  return {
    synced: unsynced.length,
    pages_created: pagesCreated,
    pages_updated: pagesUpdated,
    lint_issues: lintIssues,
  };
}

export async function lint(args: { wiki_id?: string; depth?: string }): Promise<unknown> {
  const wikiId = await resolveWiki(args.wiki_id);
  const depth = args.depth || 'quick';
  const issues: LintIssue[] = [];

  // Stats
  const pageCountResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM pages WHERE wiki_id = ? AND user_id = ?', [wikiId, uid()]
  );
  const linkCountResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM links WHERE wiki_id = ? AND user_id = ?', [wikiId, uid()]
  );
  const unsyncedResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL', [wikiId, uid()]
  );

  const stats = {
    pages: pageCountResult?.count || 0,
    sources_unsynced: unsyncedResult?.count || 0,
    links: linkCountResult?.count || 0,
  };

  // ── Quick: structural checks (SQL only) ──

  // Orphan pages
  const orphans: Pick<WikiPageRow, 'title' | 'slug'>[] = await ultralight.db.all(
    `SELECT p.title, p.slug FROM pages p
     LEFT JOIN links l ON l.to_page_id = p.id
     WHERE p.wiki_id = ? AND p.user_id = ? AND l.id IS NULL AND p.page_type != 'index'`,
    [wikiId, uid()]
  );
  for (const o of orphans) {
    issues.push({ severity: 'info', type: 'orphan', message: `No inbound links to "${o.title}"`, page_slug: o.slug });
  }

  // Stale pages (>90 days)
  const stale: Pick<WikiPageRow, 'title' | 'slug'>[] = await ultralight.db.all(
    "SELECT title, slug FROM pages WHERE wiki_id = ? AND user_id = ? AND updated_at < datetime('now', '-90 days')",
    [wikiId, uid()]
  );
  for (const s of stale) {
    issues.push({ severity: 'warning', type: 'stale', message: `"${s.title}" not updated in 90+ days`, page_slug: s.slug });
  }

  // Overdue commitments/deadlines
  const overdue: Array<Pick<WikiPageRow, 'title' | 'slug'> & { due_date: string }> = await ultralight.db.all(
    "SELECT title, slug, due_date FROM pages WHERE wiki_id = ? AND user_id = ? AND due_date IS NOT NULL AND due_date < date('now') AND page_type IN ('commitment', 'deadline')",
    [wikiId, uid()]
  );
  for (const o of overdue) {
    issues.push({ severity: 'warning', type: 'overdue', message: `"${o.title}" was due ${o.due_date}`, page_slug: o.slug });
  }

  // Broken wikilinks
  const allPages: Pick<WikiPageRow, 'id' | 'title' | 'slug' | 'content' | 'page_type'>[] = await ultralight.db.all(
    'SELECT id, title, slug, content, page_type FROM pages WHERE wiki_id = ? AND user_id = ?', [wikiId, uid()]
  );
  const slugSet = new Set(allPages.map((page) => page.slug));
  for (const page of allPages) {
    const wikilinks = [...page.content.matchAll(/\[\[([^\]]+)\]\]/g)];
    for (const match of wikilinks) {
      const targetSlug = slugify(match[1]);
      if (!slugSet.has(targetSlug)) {
        issues.push({ severity: 'error', type: 'broken_link', message: `Broken link [[${match[1]}]] in "${page.title}"`, page_slug: page.slug });
      }
    }
  }

  if (depth === 'quick') {
    return { issues: issues, stats: stats };
  }

  // ── Standard: AI contradiction check on recent pages + neighbors ──
  if (depth === 'standard' || depth === 'deep') {
    const recentPages: Pick<WikiPageRow, 'id' | 'title' | 'slug' | 'content' | 'page_type'>[] = await ultralight.db.all(
      "SELECT id, title, slug, content, page_type FROM pages WHERE wiki_id = ? AND user_id = ? AND updated_at > datetime('now', '-30 days') LIMIT 15",
      [wikiId, uid()]
    );

    if (recentPages.length > 1) {
      // Get linked neighbors
      const recentIds = recentPages.map((page) => page.id);
      const placeholders = recentIds.map(() => '?').join(',');
      const neighbors: Pick<WikiPageRow, 'id' | 'title' | 'slug' | 'content' | 'page_type'>[] = await ultralight.db.all(
        `SELECT DISTINCT p.id, p.title, p.slug, p.content, p.page_type FROM pages p
         JOIN links l ON l.to_page_id = p.id OR l.from_page_id = p.id
         WHERE (l.from_page_id IN (${placeholders}) OR l.to_page_id IN (${placeholders}))
         AND p.user_id = ? AND p.id NOT IN (${placeholders})
         LIMIT 10`,
        [...recentIds, ...recentIds, uid(), ...recentIds]
      );

      const checkPages = [...recentPages, ...neighbors];
      let summaries = '';
      for (const p of checkPages) {
        summaries += `## ${p.title} [${p.page_type}]\n${p.content.slice(0, 500)}\n\n`;
      }

      try {
        const contradictionCheck = await ultralight.ai({
          model: 'openai/gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You check wiki pages for contradictions. Return ONLY valid JSON: { "contradictions": [{ "pages": ["slug-a", "slug-b"], "description": "what contradicts" }] }. If no contradictions, return { "contradictions": [] }.',
            },
            { role: 'user', content: summaries },
          ],
        });
        const parsed = JSON.parse(extractJsonBlock(contradictionCheck.content || '{"contradictions":[]}')) as { contradictions?: ContradictionCandidate[] };
        for (const contradiction of parsed.contradictions || []) {
          issues.push({
            severity: 'warning', type: 'contradiction',
            message: `Contradiction between ${(contradiction.pages || []).join(' and ')}: ${contradiction.description}`,
            page_slug: contradiction.pages?.[0],
          });
        }
      } catch { /* skip AI failures */ }
    }
  }

  // ── Deep: AI gap analysis ──
  if (depth === 'deep') {
    const allTitles = allPages.map((page) => `- [[${page.slug}]] (${page.page_type}): ${page.title}`).join('\n');
    try {
      const gapCheck = await ultralight.ai({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You analyze a wiki\'s page list for coverage gaps. Return ONLY valid JSON: { "gaps": [{ "topic": "missing topic", "reason": "why it should exist" }] }. Suggest 3-5 pages that are referenced or implied but don\'t exist. If the wiki is comprehensive, return { "gaps": [] }.',
          },
          { role: 'user', content: `Wiki pages:\n${allTitles}` },
        ],
      });
      const parsed = JSON.parse(extractJsonBlock(gapCheck.content || '{"gaps":[]}')) as { gaps?: GapCandidate[] };
      for (const gap of parsed.gaps || []) {
        issues.push({ severity: 'info', type: 'gap', message: `Missing topic: ${gap.topic} — ${gap.reason}` });
      }
    } catch { /* skip AI failures */ }
  }

  return { issues: issues, stats: stats };
}

// ── WIDGET FUNCTIONS ──

const WIKI_BROWSER_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #1a1a1a; font-size: 14px; }
.header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #e5e5e5; }
.header h1 { font-size: 16px; font-weight: 600; flex: 1; }
.badge { background: #ef4444; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 10px; }
.search-bar { padding: 8px 16px; border-bottom: 1px solid #f0f0f0; }
.search-bar input { width: 100%; padding: 8px 12px; border: 1px solid #e0e0e0; border-radius: 6px; font-size: 13px; outline: none; }
.search-bar input:focus { border-color: #3b82f6; }
.tabs { display: flex; border-bottom: 1px solid #e5e5e5; }
.tab { flex: 1; padding: 10px; text-align: center; font-size: 13px; cursor: pointer; color: #666; border-bottom: 2px solid transparent; }
.tab.active { color: #3b82f6; border-bottom-color: #3b82f6; font-weight: 500; }
.content { padding: 12px 16px; max-height: 600px; overflow-y: auto; }
.page-item { padding: 10px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
.page-item:hover { background: #f9fafb; margin: 0 -16px; padding: 10px 16px; }
.page-item .title { font-weight: 500; color: #1a1a1a; }
.page-item .meta { font-size: 12px; color: #888; margin-top: 2px; }
.page-type { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #f0f0f0; color: #555; }
.page-content { line-height: 1.6; white-space: pre-wrap; }
.back-btn { cursor: pointer; color: #3b82f6; font-size: 13px; }
.linked-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e5e5; }
.linked-section h3 { font-size: 13px; color: #666; margin-bottom: 8px; }
.sync-btn { padding: 8px 16px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.sync-btn:hover { background: #2563eb; }
.source-item { padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.source-item .title { font-weight: 500; }
.source-item .classification { font-size: 11px; color: #888; }
.empty { text-align: center; padding: 40px; color: #999; }
.stats { display: flex; gap: 16px; padding: 12px 0; }
.stat { text-align: center; }
.stat .num { font-size: 20px; font-weight: 600; color: #1a1a1a; }
.stat .label { font-size: 11px; color: #888; }
</style></head><body>
<div class="header">
  <span class="back-btn" id="backBtn" style="display:none" onclick="goBack()">← Back</span>
  <h1 id="headerTitle">Knowledge Wiki</h1>
  <span class="badge" id="badge" style="display:none"></span>
</div>
<div class="search-bar"><input type="text" id="searchInput" placeholder="Search wiki..." onkeyup="if(event.key==='Enter')doSearch()"></div>
<div class="tabs">
  <div class="tab active" id="tabIndex" onclick="switchTab('index')">Wiki</div>
  <div class="tab" id="tabRaw" onclick="switchTab('raw')">Raw</div>
</div>
<div class="content" id="content"><div class="empty">Loading...</div></div>
<script>
var currentView = 'index';
var viewStack = [];

async function loadIndex() {
  var data = await ulAction('browse', {});
  var html = '';
  if (data.type_counts && data.type_counts.length > 0) {
    html += '<div class="stats">';
    var total = 0;
    for (var tc of data.type_counts) { total += tc.count; }
    html += '<div class="stat"><div class="num">' + total + '</div><div class="label">Pages</div></div>';
    html += '<div class="stat"><div class="num">' + (data.unsynced_count || 0) + '</div><div class="label">Unsynced</div></div>';
    html += '</div>';
    for (var tc of data.type_counts) {
      html += '<div style="font-size:12px;color:#888;margin:4px 0"><span class="page-type">' + tc.page_type + '</span> ' + tc.count + ' pages</div>';
    }
    html += '<div style="margin-top:12px">';
  }
  if (data.recent_pages && data.recent_pages.length > 0) {
    html += '<h3 style="font-size:13px;color:#666;margin:12px 0 8px">Recent</h3>';
    for (var p of data.recent_pages) {
      html += '<div class="page-item" onclick="viewPage(\\'' + p.id + '\\')">';
      html += '<div class="title">' + esc(p.title) + '</div>';
      html += '<div class="meta"><span class="page-type">' + p.page_type + '</span></div></div>';
    }
  } else {
    html += '<div class="empty">No pages yet. Ingest content and sync to build your wiki.</div>';
  }
  if (data.unsynced_count > 0) {
    document.getElementById('badge').style.display = 'inline';
    document.getElementById('badge').textContent = data.unsynced_count;
  }
  document.getElementById('content').innerHTML = html;
}

async function loadRaw() {
  var data = await ulAction('widget_wiki_browser_data', { view: 'raw' });
  var html = '';
  if (data.sources && data.sources.length > 0) {
    html += '<div style="margin-bottom:12px"><button class="sync-btn" onclick="doSync()">Sync Now</button></div>';
    for (var s of data.sources) {
      html += '<div class="source-item"><div class="title">' + esc(s.title) + '</div>';
      html += '<div class="classification">' + s.source_type + ' / ' + s.classification + '</div></div>';
    }
  } else {
    html += '<div class="empty">No unsynced sources.</div>';
  }
  document.getElementById('content').innerHTML = html;
}

async function viewPage(pageId) {
  viewStack.push(currentView);
  currentView = 'page';
  document.getElementById('backBtn').style.display = 'inline';
  var data = await ulAction('browse', { page_id: pageId });
  if (!data.page) { document.getElementById('content').innerHTML = '<div class="empty">Page not found</div>'; return; }
  var html = '<h2 style="font-size:16px;margin-bottom:4px">' + esc(data.page.title) + '</h2>';
  html += '<div style="margin-bottom:12px"><span class="page-type">' + data.page.page_type + '</span></div>';
  html += '<div class="page-content">' + esc(data.page.content) + '</div>';
  if (data.linked_pages && data.linked_pages.length > 0) {
    html += '<div class="linked-section"><h3>Linked Pages</h3>';
    for (var lp of data.linked_pages) {
      html += '<div class="page-item" onclick="viewPage(\\'' + lp.id + '\\')">';
      html += '<div class="title">' + esc(lp.title) + ' <span class="page-type">' + lp.page_type + '</span></div></div>';
    }
    html += '</div>';
  }
  document.getElementById('content').innerHTML = html;
  document.getElementById('headerTitle').textContent = data.page.title;
}

function goBack() {
  var prev = viewStack.pop();
  if (!prev || prev === 'index') { switchTab('index'); }
  else if (prev === 'raw') { switchTab('raw'); }
  document.getElementById('backBtn').style.display = viewStack.length > 0 ? 'inline' : 'none';
  document.getElementById('headerTitle').textContent = 'Knowledge Wiki';
}

async function doSearch() {
  var q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  var data = await ulAction('search', { query: q });
  var html = '';
  if (data.pages && data.pages.length > 0) {
    html += '<h3 style="font-size:13px;color:#666;margin-bottom:8px">Pages</h3>';
    for (var p of data.pages) {
      html += '<div class="page-item" onclick="viewPage(\\'' + p.id + '\\')">';
      html += '<div class="title">' + esc(p.title) + ' <span class="page-type">' + p.page_type + '</span></div>';
      html += '<div class="meta">' + esc((p.snippet || '').slice(0, 100)) + '</div></div>';
    }
  }
  if (data.sources && data.sources.length > 0) {
    html += '<h3 style="font-size:13px;color:#666;margin:12px 0 8px">Unsynced Sources</h3>';
    for (var s of data.sources) {
      html += '<div class="source-item"><div class="title">' + esc(s.title) + '</div></div>';
    }
  }
  if (!html) html = '<div class="empty">No results for "' + esc(q) + '"</div>';
  document.getElementById('content').innerHTML = html;
  currentView = 'search';
  viewStack.push('index');
  document.getElementById('backBtn').style.display = 'inline';
}

async function doSync() {
  document.getElementById('content').innerHTML = '<div class="empty">Syncing...</div>';
  var result = await ulAction('sync', {});
  var html = '<div class="empty">Synced ' + result.synced + ' sources.<br>' + result.pages_created + ' pages created, ' + result.pages_updated + ' updated.</div>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('badge').style.display = 'none';
  setTimeout(function() { switchTab('index'); }, 2000);
}

function switchTab(tab) {
  currentView = tab;
  viewStack = [];
  document.getElementById('backBtn').style.display = 'none';
  document.getElementById('headerTitle').textContent = 'Knowledge Wiki';
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  if (tab === 'index') loadIndex();
  else if (tab === 'raw') loadRaw();
}

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

loadIndex();
</script></body></html>`;

export async function widget_wiki_browser_ui(args: {}): Promise<unknown> {
  const wikiId = await ensureDefaultWiki();
  const unsyncedResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL',
    [wikiId, uid()]
  );
  return {
    meta: { title: 'Knowledge Wiki', icon: '📚', badge_count: unsyncedResult?.count || 0 },
    app_html: WIKI_BROWSER_HTML,
    version: '1.0',
  };
}

export async function widget_wiki_browser_data(args: {
  view?: string; page_id?: string; search?: string;
}): Promise<unknown> {
  const wikiId = await ensureDefaultWiki();
  const unsyncedResult: CountRow | null = await ultralight.db.first(
    'SELECT COUNT(*) as count FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL',
    [wikiId, uid()]
  );
  const meta = { title: 'Knowledge Wiki', icon: '📚', badge_count: unsyncedResult?.count || 0 };

  if (args.view === 'raw') {
    const sources: Pick<WikiSourceRow, 'id' | 'title' | 'source_type' | 'classification' | 'created_at'>[] = await ultralight.db.all(
      'SELECT id, title, source_type, classification, created_at FROM sources WHERE wiki_id = ? AND user_id = ? AND synced_at IS NULL ORDER BY created_at DESC LIMIT 30',
      [wikiId, uid()]
    );
    return { meta, sources: sources };
  }

  if (args.page_id) {
    const result = await browse({ page_id: args.page_id });
    return { ...(result as Record<string, unknown>), meta };
  }

  if (args.search) {
    const result = await search({ query: args.search });
    return { ...(result as Record<string, unknown>), meta };
  }

  const result = await browse({});
  return { ...(result as Record<string, unknown>), meta };
}
