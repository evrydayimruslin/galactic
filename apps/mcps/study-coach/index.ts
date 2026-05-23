// Private Tutor — Ultralight MCP App
// Your personal AI tutor with quizzes, custom lessons, and progress tracking.
// Storage: Ultralight D1 | Permissions: ai:call

const ultralight = (globalThis as typeof globalThis & { ultralight: any }).ultralight;
const AI_MODEL = 'meta-llama/llama-4-scout';

type SqlValue = string | number | null;
type JsonObject = Record<string, unknown>;
type QuizQuestionType = 'mc' | 'open';

interface SubjectRow {
  id: string;
  name: string;
  description: string;
  source_material?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ConceptRow {
  id: string;
  name: string;
  parent_id: string | null;
  description: string;
  subject_id: string | null;
  created_at?: string;
  updated_at?: string;
}

interface RatingRow {
  concept_id: string;
  understanding: number;
  date: string;
  notes?: string | null;
}

interface StudentProfileRow {
  id: string;
  subject_id: string | null;
  strengths: string | null;
  weaknesses: string | null;
  avg_score: number;
  quiz_count: number;
  learning_notes?: string | null;
  updated_at?: string;
}

interface QuizSessionRow {
  id: string;
  subject_id: string | null;
  status: string;
  total_questions: number;
  score_pct: number | null;
  correct_count: number | null;
  assessment_json?: string | null;
  started_at?: string;
  completed_at?: string | null;
  generated_at?: string | null;
}

interface QuizSessionWithSubjectRow extends QuizSessionRow {
  subject_name: string | null;
}

interface QuizAnswerRow {
  id: string;
  session_id: string;
  concept_id: string | null;
  question: string;
  options: string | null;
  correct_answer: string;
  explanation: string;
  question_type: QuizQuestionType | null;
  rubric: string | null;
  sort_order: number;
  user_answer?: string | null;
  is_correct?: number | null;
  score?: number | null;
  feedback?: string | null;
  misconceptions?: string | null;
  answered_at?: string | null;
  time_seconds?: number | null;
  target_words?: number | null;
}

interface QuizAnswerWithConceptRow extends QuizAnswerRow {
  concept_name: string | null;
  subject_id: string | null;
}

interface ConventionRow {
  id?: string;
  key: string;
  value: string;
  category: string | null;
}

interface LessonRow {
  id: string;
  subject_id: string | null;
  quiz_session_id?: string | null;
  title: string;
  content?: string;
  weak_concepts: string | null;
  status: string | null;
  created_at: string;
  subject_name?: string | null;
}

interface CountRow {
  count: number;
}

interface CntRow {
  cnt: number;
}

interface ConceptStudyItem {
  concept_id: string;
  name: string;
  description: string;
  subject_id: string | null;
  last_rating: number | null;
  days_since_review: number | null;
  priority: number;
}

interface ConceptTreeNode extends ConceptRow {
  children: ConceptTreeNode[];
}

interface QuickStartConcept {
  name: string;
  description?: string;
}

interface QuickStartExtraction {
  subject: string;
  concepts: QuickStartConcept[];
  summary?: string;
}

type QuickStartUserMessage =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'file'; data: string; filename?: string }>;

interface GeneratedQuizQuestion {
  type?: QuizQuestionType;
  question: string;
  options?: string[];
  correct?: string;
  explanation?: string;
  rubric?: string;
  concept?: string;
  target_words?: number;
}

interface FluencyAssessment {
  level: string;
  notes?: string;
  sophistication: number;
  above_quiz_level?: boolean;
}

interface OpenAnswerGrade {
  q: number;
  score: number;
  is_correct: boolean;
  feedback?: string;
  misconceptions?: string[];
}

interface BatchGradingResponse {
  grades?: OpenAnswerGrade[];
  fluency?: FluencyAssessment;
}

interface PerConceptAssessment {
  correct: number;
  total: number;
  mastery: number;
  avg_score: number;
  time_avg_s: number | null;
  prev_mastery?: number;
  delta?: number;
}

interface QuizAssessment {
  per_concept: Record<string, PerConceptAssessment>;
  timing: {
    total_s: number;
    avg_per_question_s: number | null;
  };
  improvement: {
    prev_score: number;
    delta: number;
    improved: string[];
    regressed: string[];
  } | null;
  misconceptions: string[];
  overall_mastery: number;
  fluency: FluencyAssessment | null;
}

interface WidgetProgressData extends Record<string, unknown> {
  pending_quizzes: QuizSessionWithSubjectRow[];
  unread_lessons: LessonRow[];
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function extractJsonText(raw: string): string {
  return raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

function parseJsonObject(value: string | null | undefined): JsonObject | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function uid(): string { return ultralight.user.id; }
function now(): string { return new Date().toISOString(); }
function today(): string { return new Date().toISOString().split('T')[0]; }

// ════════════════════════════════════════════════════════════════════════════
//  CORE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

export async function add_concept(args: {
  name: string; parent_id?: string; description?: string; subject?: string;
}): Promise<unknown> {
  const { name, parent_id, description, subject } = args;
  const id = crypto.randomUUID();
  const ts = now();

  let subjectId = null;
  if (subject) {
    const existing: Pick<SubjectRow, 'id'> | null = await ultralight.db.first(
      'SELECT id FROM subjects WHERE user_id = ? AND LOWER(name) = ?',
      [uid(), subject.toLowerCase()]
    );
    if (existing) {
      subjectId = existing.id;
    } else {
      subjectId = crypto.randomUUID();
      await ultralight.db.run(
        'INSERT INTO subjects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [subjectId, uid(), subject, '', ts, ts]
      );
    }
  }

  await ultralight.db.run(
    'INSERT INTO concepts (id, user_id, name, parent_id, description, subject_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, uid(), name, parent_id || null, description || '', subjectId, ts, ts]
  );

  return { success: true, concept_id: id, name, subject_id: subjectId, parent_id: parent_id || null };
}

export async function rate(args: {
  concept_id: string; understanding: number; notes?: string;
}): Promise<unknown> {
  const { concept_id, understanding, notes } = args;
  const concept: ConceptRow | null = await ultralight.db.first(
    'SELECT * FROM concepts WHERE id = ? AND user_id = ?', [concept_id, uid()]
  );
  if (!concept) return { success: false, error: 'Concept not found: ' + concept_id };

  const rating = Math.min(5, Math.max(1, Math.round(understanding)));
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO ratings (id, user_id, concept_id, understanding, date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), uid(), concept_id, rating, today(), notes || '', ts, ts]
  );

  return { success: true, concept: concept.name, understanding: rating, date: today() };
}

export async function study(args: { subject_id?: string; limit?: number }): Promise<unknown> {
  const { subject_id, limit } = args;
  const todayDate = new Date();

  let sql = 'SELECT * FROM concepts WHERE user_id = ?';
  const params: SqlValue[] = [uid()];
  if (subject_id) { sql += ' AND subject_id = ?'; params.push(subject_id); }
  const concepts: ConceptRow[] = await ultralight.db.all(sql, params);

  const items: ConceptStudyItem[] = [];
  for (const concept of concepts) {
    const last: RatingRow | null = await ultralight.db.first(
      'SELECT understanding, date FROM ratings WHERE user_id = ? AND concept_id = ? ORDER BY date DESC LIMIT 1',
      [uid(), concept.id]
    );
    let priority = 100;
    let lastRating: number | null = null;
    let daysSince: number | null = null;
    if (last) {
      lastRating = last.understanding;
      daysSince = Math.floor((todayDate.getTime() - new Date(last.date).getTime()) / 86400000);
      const ideal = Math.pow(2, lastRating! - 1);
      priority = Math.max(0, (daysSince / ideal) * (6 - lastRating!) * 10);
    }
    items.push({ concept_id: concept.id, name: concept.name, description: concept.description, subject_id: concept.subject_id, last_rating: lastRating, days_since_review: daysSince, priority: Math.round(priority) });
  }

  items.sort((a, b) => b.priority - a.priority);
  return { to_study: items.slice(0, limit || 10), total_concepts: concepts.length, concepts_needing_review: items.filter(s => s.priority > 20).length };
}

export async function tree(args: { subject_id?: string }): Promise<unknown> {
  let sql = 'SELECT * FROM concepts WHERE user_id = ?';
  const params: SqlValue[] = [uid()];
  if (args.subject_id) { sql += ' AND subject_id = ?'; params.push(args.subject_id); }
  const concepts: ConceptRow[] = await ultralight.db.all(sql, params);

  const byId: Record<string, ConceptTreeNode> = {};
  for (const concept of concepts) byId[concept.id] = { ...concept, children: [] };
  const roots: ConceptTreeNode[] = [];
  for (const concept of concepts) {
    if (concept.parent_id && byId[concept.parent_id]) byId[concept.parent_id].children.push(byId[concept.id]);
    else roots.push(byId[concept.id]);
  }
  return { tree: roots, total_concepts: concepts.length, root_concepts: roots.length };
}

// ── QUICK START (zero-to-studying) ──

export async function quick_start(args: {
  topic?: string; file_content?: string; file_name?: string; count?: number; mode?: string;
}): Promise<unknown> {
  const { topic, file_content, file_name, count, mode } = args;
  if (!topic && !file_content) return { success: false, error: 'Provide a topic or file content.' };

  // Build extraction prompt — supports multimodal (images) and text files
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
  const fileExt = file_name ? (file_name.split('.').pop() || '').toLowerCase() : '';
  const isImage = IMAGE_EXTS.includes(fileExt) || (file_content?.startsWith('data:image/') ?? false);

  let textInput = '';
  if (topic) textInput += `Topic: ${topic}\n`;

  // For text files, decode and inline
  if (file_content && file_name && !isImage) {
    const textContent = decodeFileContent(file_content, file_name);
    if (textContent) textInput += `\nFile "${file_name}" content:\n${textContent.slice(0, 8000)}\n`;
  }

  const extractInstruction = `Analyze this study material and extract a subject name and 3-8 key concepts with descriptions.\n\n${textInput}\nRespond with ONLY valid JSON, no markdown fences:\n{"subject":"subject name","concepts":[{"name":"concept name","description":"1-2 sentence description"}],"summary":"2-3 paragraph summary of the material for future reference"}`;

  // Build user message — multimodal for images, plain text otherwise
  let userMessage: QuickStartUserMessage;
  if (isImage && file_content) {
    // Multimodal: text instruction + image content
    const imageUrl = file_content.startsWith('data:') ? file_content : `data:image/${fileExt || 'png'};base64,${file_content}`;
    userMessage = [
      { type: 'text', text: extractInstruction },
      { type: 'file', data: imageUrl, filename: file_name },
    ];
  } else {
    userMessage = extractInstruction;
  }

  let extracted: QuickStartExtraction;
  try {
    const response = await ultralight.ai({
      model: AI_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: 'You are an expert educator. Extract the core subject and key concepts from study material. Be specific and pedagogically useful. If an image is provided, carefully read all text, diagrams, and visual information in it. Respond with valid JSON only. Do NOT use extended thinking — respond directly.' },
        { role: 'user', content: userMessage },
      ],
    });
    const text = extractJsonText(response.content || '');
    extracted = JSON.parse(text) as QuickStartExtraction;
    if (!extracted.subject || !Array.isArray(extracted.concepts)) throw new Error('Bad format');
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[quick_start] AI extraction failed:', errMsg);
    return { success: false, error: 'Could not extract concepts: ' + errMsg };
  }

  const ts = now();

  // Create or find subject
  const existingSubject: Pick<SubjectRow, 'id'> | null = await ultralight.db.first(
    'SELECT id FROM subjects WHERE user_id = ? AND LOWER(name) = ?',
    [uid(), extracted.subject.toLowerCase()]
  );
  const subjectId = existingSubject?.id || crypto.randomUUID();
  if (!existingSubject) {
    await ultralight.db.run(
      'INSERT INTO subjects (id, user_id, name, description, source_material, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [subjectId, uid(), extracted.subject, '', extracted.summary || null, ts, ts]
    );
  } else if (extracted.summary) {
    await ultralight.db.run('UPDATE subjects SET source_material = ?, updated_at = ? WHERE id = ?', [extracted.summary, ts, subjectId]);
  }

  // Create concepts
  const conceptList: Array<{ id: string; name: string; description?: string }> = [];
  for (const concept of extracted.concepts) {
    const cId = crypto.randomUUID();
    await ultralight.db.run(
      'INSERT INTO concepts (id, user_id, name, parent_id, description, subject_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cId, uid(), concept.name, null, concept.description || '', subjectId, ts, ts]
    );
    conceptList.push({ id: cId, name: concept.name, description: concept.description });
  }

  return {
    success: true,
    subject_id: subjectId,
    subject_name: extracted.subject,
    concepts: conceptList,
    concept_count: conceptList.length,
    summary: extracted.summary || null,
  };
}

function decodeFileContent(content: string, filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const textExts = ['txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml'];
  try {
    if (content.startsWith('data:')) {
      const base64Part = content.split(',')[1];
      if (!base64Part) return null;
      if (textExts.includes(ext) || content.includes('text/')) {
        return atob(base64Part);
      }
      // For non-text files (PDF, images), return null — multimodal support needed (Stage 1)
      return `[Binary file: ${filename} — text extraction not yet available. Topic-based study will be used instead.]`;
    }
    return content; // Raw text passthrough
  } catch {
    return null;
  }
}

export async function status(args: { subject_id?: string }): Promise<unknown> {
  const subjects: SubjectRow[] = await ultralight.db.all('SELECT * FROM subjects WHERE user_id = ?', [uid()]);
  const conceptCount: CountRow | null = await ultralight.db.first('SELECT COUNT(*) as count FROM concepts WHERE user_id = ?', [uid()]);

  // Per-subject mastery from student_profiles
  const profiles: StudentProfileRow[] = await ultralight.db.all('SELECT * FROM student_profiles WHERE user_id = ? ORDER BY updated_at DESC', [uid()]);

  // Recent quizzes
  const recentQuizzes: QuizSessionWithSubjectRow[] = await ultralight.db.all(
    'SELECT qs.*, s.name as subject_name FROM quiz_sessions qs LEFT JOIN subjects s ON qs.subject_id = s.id WHERE qs.user_id = ? AND qs.status = ? ORDER BY qs.started_at DESC LIMIT 5',
    [uid(), 'completed']
  );

  // Overall average — most recent rating per concept
  const lastRatings: Array<Pick<RatingRow, 'concept_id' | 'understanding'>> = await ultralight.db.all(
    'SELECT concept_id, understanding FROM ratings WHERE user_id = ? GROUP BY concept_id ORDER BY MAX(date) DESC',
    [uid()]
  );
  const ratedCount = lastRatings.length;
  const avgUnderstanding = ratedCount > 0 ? Math.round((lastRatings.reduce((sum, rating) => sum + rating.understanding, 0) / ratedCount) * 10) / 10 : null;

  return {
    total_subjects: subjects.length,
    subjects: subjects.map((subject) => {
      const profile = profiles.find((item) => item.subject_id === subject.id);
      return { id: subject.id, name: subject.name, mastery: profile?.avg_score || null, quiz_count: profile?.quiz_count || 0, strengths: profile ? parseStringArray(profile.strengths) : [], weaknesses: profile ? parseStringArray(profile.weaknesses) : [] };
    }),
    total_concepts: conceptCount?.count || 0,
    concepts_rated: ratedCount,
    average_understanding: avgUnderstanding,
    recent_quizzes: recentQuizzes.map((quiz) => ({ id: quiz.id, subject: quiz.subject_name, score: quiz.score_pct, questions: quiz.total_questions, correct: quiz.correct_count, date: quiz.started_at })),
    profiles,
  };
}

// ── LEGACY QUIZ (non-session, returns all questions at once) ──

export async function quiz(args: {
  subject_id?: string; concept_ids?: string[]; count?: number;
}): Promise<unknown> {
  const { subject_id, concept_ids, count } = args;
  let concepts: ConceptRow[] = [];
  if (concept_ids?.length) {
    const ph = concept_ids.map(() => '?').join(',');
    concepts = await ultralight.db.all(`SELECT * FROM concepts WHERE user_id = ? AND id IN (${ph})`, [uid(), ...concept_ids]);
  } else {
    let sql = 'SELECT * FROM concepts WHERE user_id = ?';
    const params: SqlValue[] = [uid()];
    if (subject_id) { sql += ' AND subject_id = ?'; params.push(subject_id); }
    concepts = await ultralight.db.all(sql, params);
  }
  if (concepts.length === 0) return { success: false, error: 'No concepts found to quiz on.' };

  const conceptNames = concepts.slice(0, 10).map((concept) => concept.name + (concept.description ? ' — ' + concept.description : ''));
  const prompt = 'Generate ' + (count || 5) + ' quiz questions about these concepts:\n' + conceptNames.join('\n') +
    '\n\nFor each question provide: the question, 4 multiple-choice options, the correct answer, and a brief explanation. Respond with ONLY valid JSON, no markdown. Format: [{"question": "...", "options": ["A", "B", "C", "D"], "correct": "A", "explanation": "..."}]';

  try {
    const response = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are an educational quiz generator. Create clear, accurate quiz questions. Respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    });
    const text = extractJsonText(response.content || '');
    const questions = JSON.parse(text) as GeneratedQuizQuestion[];
    return { questions, count: questions.length, concepts_tested: concepts.slice(0, 10).map((concept) => concept.name) };
  } catch (e) {
    return { success: false, error: 'Could not generate quiz. Try again.' };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  QUIZ SESSION FLOW
// ════════════════════════════════════════════════════════════════════════════

async function getStudentContext(subjectId?: string): Promise<string> {
  const profile: StudentProfileRow | null = subjectId
    ? await ultralight.db.first('SELECT * FROM student_profiles WHERE user_id = ? AND subject_id = ?', [uid(), subjectId])
    : await ultralight.db.first('SELECT * FROM student_profiles WHERE user_id = ? AND subject_id IS NULL', [uid()]);

  if (!profile) return '';
  const strengths = parseStringArray(profile.strengths);
  const weaknesses = parseStringArray(profile.weaknesses);
  let ctx = '';
  if (weaknesses.length) ctx += `Student struggles with: ${weaknesses.join(', ')}. Focus questions on these areas.\n`;
  if (strengths.length) ctx += `Student is strong in: ${strengths.join(', ')}. Include some challenging questions on these.\n`;
  if (profile.avg_score) ctx += `Average quiz score: ${Math.round(profile.avg_score)}%. `;
  if (profile.learning_notes) ctx += `Notes: ${profile.learning_notes}\n`;
  return ctx;
}

// ════════════════════════════════════════════════════════════════════════════
//  COURSE CONTEXT ENGINE
// ════════════════════════════════════════════════════════════════════════════

interface CourseContext {
  subject: { id: string; name: string; concept_count: number };
  student: { strengths: string[]; weaknesses: string[]; avg_score: number; quiz_count: number };
  timeline: Array<{ type: string; date: string; score_pct?: number | null; title?: string; concepts?: string[] }>;
  concept_mastery: Record<string, { current_rating: number; times_tested: number; correct_pct: number; avg_time_s: number | null; misconceptions: string[] }>;
  prompt_text: string;
}

async function buildCourseContext(subjectId: string): Promise<CourseContext> {
  // Subject info
  const subject: Pick<SubjectRow, 'id' | 'name' | 'description'> | null = await ultralight.db.first('SELECT id, name, description FROM subjects WHERE id = ? AND user_id = ?', [subjectId, uid()]);
  const concepts: Array<Pick<ConceptRow, 'id' | 'name' | 'description'>> = await ultralight.db.all('SELECT id, name, description FROM concepts WHERE user_id = ? AND subject_id = ?', [uid(), subjectId]);

  // All completed quizzes chronologically
  const quizzes: QuizSessionRow[] = await ultralight.db.all(
    'SELECT id, score_pct, correct_count, total_questions, started_at, completed_at, assessment_json FROM quiz_sessions WHERE user_id = ? AND subject_id = ? AND status = ? ORDER BY completed_at ASC',
    [uid(), subjectId, 'completed']
  );

  // All lessons for subject
  const lessons: Array<Pick<LessonRow, 'id' | 'title' | 'weak_concepts' | 'created_at' | 'status'>> = await ultralight.db.all(
    'SELECT id, title, weak_concepts, created_at, status FROM lessons WHERE user_id = ? AND subject_id = ? ORDER BY created_at ASC',
    [uid(), subjectId]
  );

  // Student profile
  const profile: StudentProfileRow | null = await ultralight.db.first('SELECT * FROM student_profiles WHERE user_id = ? AND subject_id = ?', [uid(), subjectId]);
  const strengths = profile ? parseStringArray(profile.strengths) : [];
  const weaknesses = profile ? parseStringArray(profile.weaknesses) : [];

  // Per-concept data: mastery, test frequency, misconceptions, timing
  const conceptMastery: CourseContext['concept_mastery'] = {};
  for (const c of concepts) {
    const rating: Pick<RatingRow, 'understanding'> | null = await ultralight.db.first('SELECT understanding FROM ratings WHERE user_id = ? AND concept_id = ? ORDER BY date DESC LIMIT 1', [uid(), c.id]);
    const answerStats: { total: number; correct: number; avg_time: number | null } | null = await ultralight.db.first(
      'SELECT COUNT(*) as total, SUM(CASE WHEN qa.is_correct = 1 THEN 1 ELSE 0 END) as correct, AVG(qa.time_seconds) as avg_time FROM quiz_answers qa JOIN quiz_sessions qs ON qa.session_id = qs.id WHERE qa.user_id = ? AND qa.concept_id = ? AND qs.subject_id = ?',
      [uid(), c.id, subjectId]
    );
    // Collect misconceptions for this concept
    const misconceptionRows: Array<Pick<QuizAnswerRow, 'misconceptions'>> = await ultralight.db.all(
      'SELECT qa.misconceptions FROM quiz_answers qa JOIN quiz_sessions qs ON qa.session_id = qs.id WHERE qa.user_id = ? AND qa.concept_id = ? AND qa.misconceptions IS NOT NULL AND qs.subject_id = ? ORDER BY qa.answered_at DESC LIMIT 5',
      [uid(), c.id, subjectId]
    );
    const conceptMisconceptions: string[] = [];
    for (const row of misconceptionRows) conceptMisconceptions.push(...parseStringArray(row.misconceptions));
    const answerTotal = answerStats?.total || 0;
    const answerCorrect = answerStats?.correct || 0;

    conceptMastery[c.name] = {
      current_rating: rating?.understanding || 0,
      times_tested: answerTotal,
      correct_pct: answerTotal > 0 ? Math.round((answerCorrect / answerTotal) * 100) : 0,
      avg_time_s: answerStats?.avg_time ? Math.round(answerStats.avg_time) : null,
      misconceptions: [...new Set(conceptMisconceptions)].slice(0, 5),
    };
  }

  // Build timeline
  const timeline: CourseContext['timeline'] = [];
  for (const q of quizzes) {
    timeline.push({ type: 'quiz', date: q.completed_at || q.started_at || q.generated_at || '', score_pct: q.score_pct });
  }
  for (const l of lessons) {
    const lc = parseStringArray(l.weak_concepts);
    timeline.push({ type: 'lesson', date: l.created_at, title: l.title, concepts: lc });
  }
  timeline.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Build prompt text (concise summary for AI, ~1500 tokens max)
  const scoreTrajectory = quizzes.map((quiz) => `${quiz.score_pct}%`).join(' → ');
  // Extract latest fluency assessment from most recent quiz
  let latestFluency: FluencyAssessment | null = null;
  for (let qi = quizzes.length - 1; qi >= 0; qi--) {
    const parsed = parseJsonObject(quizzes[qi].assessment_json);
    const fluency = parsed?.fluency as FluencyAssessment | undefined;
    if (fluency) { latestFluency = fluency; break; }
  }

  let prompt = `## Course: ${subject?.name || 'Unknown'}\n`;
  prompt += `${quizzes.length} quizzes taken, ${lessons.length} lessons completed, ${concepts.length} concepts\n`;
  if (latestFluency) {
    prompt += `\n## Student Fluency Profile (DO NOT share with student)\n`;
    prompt += `Demonstrated level: ${latestFluency.level}\n`;
    if (latestFluency.notes) prompt += `Assessment: ${latestFluency.notes}\n`;
    prompt += `Sophistication: ${latestFluency.sophistication}/10\n`;
    if (latestFluency.above_quiz_level) prompt += `NOTE: Student scored very high on last quiz — they are likely ABOVE the assessed level. Increase difficulty significantly.\n`;
    prompt += `IMPORTANT: Calibrate ALL content to this demonstrated level. Do NOT use generic difficulty labels. Match the vocabulary, complexity, and depth of questions/lessons to what this specific student has shown they can handle. Draw your assessment from the quality of their answers, their topic choice, their response times, and their MC accuracy patterns.\n\n`;
  }
  if (scoreTrajectory) prompt += `Score trajectory: ${scoreTrajectory}\n`;
  if (profile?.avg_score) prompt += `Average score: ${Math.round(profile.avg_score)}%\n`;

  // Concept mastery breakdown
  prompt += `\n## Concept Mastery\n`;
  const sorted = Object.entries(conceptMastery).sort((a, b) => a[1].current_rating - b[1].current_rating);
  for (const [name, cm] of sorted) {
    const ratingStr = cm.current_rating > 0 ? `${cm.current_rating}/5` : 'untested';
    const timeStr = cm.avg_time_s ? `, avg ${cm.avg_time_s}s` : '';
    const miscStr = cm.misconceptions.length ? ` — misconceptions: ${cm.misconceptions.join('; ')}` : '';
    prompt += `- ${name}: ${ratingStr} (${cm.correct_pct}% correct, tested ${cm.times_tested}x${timeStr})${miscStr}\n`;
  }

  if (weaknesses.length) prompt += `\nWeak areas: ${weaknesses.join(', ')}\n`;
  if (strengths.length) prompt += `Strong areas: ${strengths.join(', ')}\n`;

  // Previous lessons summary
  if (lessons.length > 0) {
    prompt += `\n## Previous Lessons\n`;
    for (const l of lessons.slice(-5)) {
      const lc = parseStringArray(l.weak_concepts);
      prompt += `- ${l.title} (${l.created_at?.split('T')[0] || ''}): covered ${lc.join(', ')}\n`;
    }
  }

  const ctx: CourseContext = {
    subject: { id: subjectId, name: subject?.name || '', concept_count: concepts.length },
    student: { strengths, weaknesses, avg_score: profile?.avg_score || 0, quiz_count: quizzes.length },
    timeline,
    concept_mastery: conceptMastery,
    prompt_text: prompt,
  };

  // Store for fast retrieval
  await setConvention(`course_context:${subjectId}`, JSON.stringify(ctx), 'course');
  return ctx;
}

export async function start_quiz(args: {
  subject_id?: string; concept_ids?: string[]; count?: number;
}): Promise<unknown> {
  const { subject_id, concept_ids, count } = args;
  let qCount = Math.min(count || 5, 15);

  // Gather concepts (prefer weak ones via spaced repetition priority)
  let concepts: ConceptRow[] = [];
  if (concept_ids?.length) {
    const ph = concept_ids.map(() => '?').join(',');
    concepts = await ultralight.db.all(`SELECT * FROM concepts WHERE user_id = ? AND id IN (${ph})`, [uid(), ...concept_ids]);
  } else {
    const studyResult = await study({ subject_id, limit: qCount * 2 }) as { to_study?: ConceptStudyItem[] };
    const ids = (studyResult.to_study || []).map((item) => item.concept_id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      concepts = await ultralight.db.all(`SELECT * FROM concepts WHERE user_id = ? AND id IN (${ph})`, [uid(), ...ids]);
    }
  }

  if (concepts.length === 0) return { success: false, error: 'No concepts found. Add some concepts first.' };

  // Build adaptive prompt with full course context
  let courseCtx = '';
  if (subject_id) {
    try {
      const cached: Pick<ConventionRow, 'value'> | null = await ultralight.db.first('SELECT value FROM conventions WHERE user_id = ? AND key = ?', [uid(), `course_context:${subject_id}`]);
      if (cached?.value) {
        const ctx = parseJsonObject(cached.value);
        courseCtx = typeof ctx?.prompt_text === 'string' ? ctx.prompt_text : '';
      }
    } catch {}
  }
  if (!courseCtx) courseCtx = await getStudentContext(subject_id || undefined);

  // Adaptive difficulty based on mastery level
  let mastery = 0;
  let parsedCtx: JsonObject | null = null;
  if (subject_id) {
    try {
      const cached: Pick<ConventionRow, 'value'> | null = await ultralight.db.first('SELECT value FROM conventions WHERE user_id = ? AND key = ?', [uid(), `course_context:${subject_id}`]);
      if (cached?.value) parsedCtx = parseJsonObject(cached.value);
    } catch {}
  }
  const parsedStudent = parsedCtx?.student as { avg_score?: number } | undefined;
  if (parsedStudent?.avg_score) mastery = parsedStudent.avg_score;
  else {
    const profile: Pick<StudentProfileRow, 'avg_score'> | null = await ultralight.db.first('SELECT avg_score FROM student_profiles WHERE user_id = ? AND subject_id = ?', [uid(), subject_id]);
    if (profile?.avg_score) mastery = profile.avg_score;
  }

  // Determine difficulty and question count from mastery
  let difficulty: string;
  let targetWordCount: number;
  if (mastery >= 80) {
    difficulty = 'advanced'; qCount = Math.max(qCount, 5); targetWordCount = 100;
  } else if (mastery >= 50) {
    difficulty = 'intermediate'; qCount = Math.max(qCount, 5); targetWordCount = 75;
  } else if (mastery > 0) {
    difficulty = 'beginner'; qCount = Math.min(qCount, 4); targetWordCount = 50;
  } else {
    difficulty = 'introductory'; qCount = Math.min(qCount, 3); targetWordCount = 40;
  }

  const conceptList = concepts.slice(0, 10).map((concept) => {
    const desc = concept.description ? ` — ${concept.description}` : '';
    return `- ${concept.name}${desc}`;
  }).join('\n');

  const mcCount = Math.max(2, Math.ceil(qCount * 0.5));
  const openCount = qCount - mcCount;
  const prompt = `${courseCtx}\n\nStudent mastery on this subject: ${Math.round(mastery)}%\n\nGenerate exactly ${qCount} quiz questions about these concepts:\n${conceptList}\n\nGenerate ${mcCount} multiple-choice and ${openCount} open-ended questions. Mix them together.\n\nCalibrate difficulty to this student's demonstrated level (see fluency profile above if available). Do NOT use a universal difficulty scale — a 30% score from a graduate student means very different questions than a 90% score from a middle schooler. Match the vocabulary, abstraction level, and reasoning demands to what THIS student has demonstrated they can handle.\n\nFor open-ended questions, include "target_words":${targetWordCount} in the JSON.\n\nAvoid repeating questions from previous quizzes.\n\nMultiple-choice format: {"type":"mc","question":"...","options":["A)...","B)...","C)...","D)..."],"correct":"A","explanation":"...","concept":"concept name"}\nOpen-ended format: {"type":"open","question":"...","rubric":"what a good answer includes","target_words":${targetWordCount},"concept":"concept name"}\n\nRespond with ONLY valid JSON array, no markdown fences.`;

  let questions: GeneratedQuizQuestion[];
  try {
    const response = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are an expert adaptive quiz generator. Create questions calibrated to the individual student\'s demonstrated fluency level — study their previous answers to gauge vocabulary, reasoning depth, and conceptual sophistication. A low score from a graduate student requires harder questions than a high score from a beginner. Test understanding, not memorization. For open-ended questions, write rubrics matching the student\'s level. Respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    });
    const text = extractJsonText(response.content || '');
    questions = JSON.parse(text) as GeneratedQuizQuestion[];
    if (!Array.isArray(questions)) throw new Error('Not an array');
    console.log('[start_quiz] Generated', questions.length, 'questions');
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[start_quiz] Quiz generation failed:', errMsg);
    return { success: false, error: 'Quiz generation failed: ' + errMsg };
  }

  // Create session
  const sessionId = crypto.randomUUID();
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO quiz_sessions (id, user_id, subject_id, status, total_questions, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, uid(), subject_id || null, 'in_progress', questions.length, ts]
  );

  // Insert all questions
  const conceptMap: Record<string, string> = {};
  for (const concept of concepts) conceptMap[concept.name.toLowerCase()] = concept.id;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qType = q.type === 'open' ? 'open' : 'mc';
    const conceptId = q.concept ? conceptMap[q.concept.toLowerCase()] || null : null;
    await ultralight.db.run(
      'INSERT INTO quiz_answers (id, session_id, user_id, concept_id, question, options, correct_answer, explanation, question_type, rubric, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), sessionId, uid(), conceptId, q.question, JSON.stringify(q.options || []), q.correct || '', q.explanation || '', qType, q.rubric || null, i]
    );
  }

  // Return first question
  const first: QuizAnswerRow | null = await ultralight.db.first(
    'SELECT * FROM quiz_answers WHERE session_id = ? AND user_id = ? ORDER BY sort_order ASC LIMIT 1',
    [sessionId, uid()]
  );
  if (!first) return { success: false, error: 'Quiz generated without questions.' };

  return {
    session_id: sessionId,
    total_questions: questions.length,
    current_question: 1,
    question: {
      id: first.id,
      text: first.question,
      type: first.question_type || 'mc',
      options: JSON.parse(first.options || '[]'),
      rubric: first.rubric || null,
    },
  };
}

// Pre-generate a quiz and save for later (no LLM call needed on start)
async function pre_generate_quiz(subjectId: string, courseContext?: CourseContext): Promise<{ session_id: string; total_questions: number }> {
  const ctx = courseContext || await buildCourseContext(subjectId);
  const concepts: ConceptRow[] = await ultralight.db.all('SELECT * FROM concepts WHERE user_id = ? AND subject_id = ?', [uid(), subjectId]);
  if (concepts.length === 0) throw new Error('No concepts to quiz on');

  const qCount = Math.min(5, concepts.length);
  const mcCount = Math.max(2, Math.ceil(qCount * 0.5));
  const openCount = qCount - mcCount;
  const conceptList = concepts.slice(0, 10).map((concept) => `- ${concept.name}: ${concept.description || 'No description'}`).join('\n');

  const prompt = `${ctx.prompt_text}\n\nGenerate exactly ${qCount} quiz questions about these concepts:\n${conceptList}\n\nGenerate ${mcCount} multiple-choice and ${openCount} open-ended questions. Mix them together.\nAvoid repeating questions from previous quizzes.\nIncrease difficulty for concepts with mastery >= 4/5.\nFocus on misconceptions that keep recurring.\n\nMultiple-choice format: {"type":"mc","question":"...","options":["A)...","B)...","C)...","D)..."],"correct":"A","explanation":"...","concept":"concept name"}\nOpen-ended format: {"type":"open","question":"...","rubric":"what a good answer includes","concept":"concept name"}\n\nRespond with ONLY valid JSON array.`;

  const response = await ultralight.ai({
    model: AI_MODEL,
    temperature: 0.7,
    messages: [
      { role: 'system', content: 'You are an expert quiz generator creating adaptive quizzes based on student history. Generate questions that target weak areas while building on strengths. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
  });

  const text = extractJsonText(response.content || '');
  const questions = JSON.parse(text) as GeneratedQuizQuestion[];
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('Invalid quiz format');

  const sessionId = crypto.randomUUID();
  const ts = now();
  await ultralight.db.run(
    'INSERT INTO quiz_sessions (id, user_id, subject_id, status, total_questions, started_at, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sessionId, uid(), subjectId, 'pending', questions.length, ts, ts]
  );

  const conceptMap: Record<string, string> = {};
  for (const concept of concepts) conceptMap[concept.name.toLowerCase()] = concept.id;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qType = q.type === 'open' ? 'open' : 'mc';
    const conceptId = q.concept ? conceptMap[q.concept.toLowerCase()] || null : null;
    await ultralight.db.run(
      'INSERT INTO quiz_answers (id, session_id, user_id, concept_id, question, options, correct_answer, explanation, question_type, rubric, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), sessionId, uid(), conceptId, q.question, JSON.stringify(q.options || []), q.correct || '', q.explanation || '', qType, q.rubric || null, i]
    );
  }

  return { session_id: sessionId, total_questions: questions.length };
}

// Start a pre-generated pending quiz (instant, no LLM call)
async function start_pending_quiz(sessionId: string): Promise<unknown> {
  const session: QuizSessionRow | null = await ultralight.db.first(
    'SELECT * FROM quiz_sessions WHERE id = ? AND user_id = ? AND status = ?',
    [sessionId, uid(), 'pending']
  );
  if (!session) return { success: false, error: 'Pending quiz not found' };

  await ultralight.db.run(
    'UPDATE quiz_sessions SET status = ?, started_at = ? WHERE id = ?',
    ['in_progress', now(), sessionId]
  );

  const first: QuizAnswerRow | null = await ultralight.db.first(
    'SELECT * FROM quiz_answers WHERE session_id = ? AND user_id = ? ORDER BY sort_order ASC LIMIT 1',
    [sessionId, uid()]
  );
  if (!first) return { success: false, error: 'No questions found' };

  return {
    session_id: sessionId,
    total_questions: session.total_questions,
    current_question: 1,
    question: {
      id: first.id,
      text: first.question,
      type: first.question_type || 'mc',
      options: JSON.parse(first.options || '[]'),
      rubric: first.rubric || null,
    },
  };
}

export async function submit_answer(args: {
  session_id: string; answer_id: string; user_answer: string; time_seconds?: number;
}): Promise<unknown> {
  const { session_id, answer_id, user_answer, time_seconds } = args;

  const answer: QuizAnswerRow | null = await ultralight.db.first(
    'SELECT * FROM quiz_answers WHERE id = ? AND session_id = ? AND user_id = ?',
    [answer_id, session_id, uid()]
  );
  if (!answer) return { success: false, error: 'Answer not found' };

  // Idempotency: prevent double-answering
  if (answer.user_answer !== null) {
    return { success: false, error: 'Already answered', is_correct: !!answer.is_correct, correct_answer: answer.correct_answer, explanation: answer.explanation };
  }

  // Grade MC immediately; defer open-ended to batch grading in complete_quiz (no LLM per question)
  let isCorrect: number | null = null;
  let feedbackText: string | null = null;
  let scoreVal: number | null = null;
  let misconceptionsJson: string | null = null;

  if (answer.question_type === 'open') {
    // Open-ended: just record the answer, grading happens in complete_quiz batch
    isCorrect = null; // will be set during batch grading
    scoreVal = null;
    feedbackText = null;
  } else {
    // MC grading — instant, no LLM needed
    const correctLetter = (answer.correct_answer.match(/[A-D]/i) || [''])[0].toUpperCase();
    const userLetter = (user_answer.match(/[A-D]/i) || [''])[0].toUpperCase();
    isCorrect = correctLetter && userLetter === correctLetter ? 1 : 0;
    scoreVal = isCorrect ? 5 : 1;
  }

  await ultralight.db.run(
    'UPDATE quiz_answers SET user_answer = ?, is_correct = ?, score = ?, feedback = ?, misconceptions = ?, answered_at = ?, time_seconds = ? WHERE id = ?',
    [user_answer, isCorrect, scoreVal, feedbackText, misconceptionsJson, now(), time_seconds || null, answer_id]
  );

  // Auto-update concept rating if linked
  if (answer.concept_id) {
    const lastRating: Pick<RatingRow, 'understanding'> | null = await ultralight.db.first(
      'SELECT understanding FROM ratings WHERE user_id = ? AND concept_id = ? ORDER BY date DESC LIMIT 1',
      [uid(), answer.concept_id]
    );
    const current = lastRating?.understanding || 3;
    const newRating = isCorrect ? Math.min(5, current + 1) : Math.max(1, current - 1);
    await ultralight.db.run(
      'INSERT INTO ratings (id, user_id, concept_id, understanding, date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), uid(), answer.concept_id, newRating, today(), isCorrect ? 'Correct on quiz' : 'Incorrect on quiz', now(), now()]
    );
  }

  // Get next unanswered question
  const next: QuizAnswerRow | null = await ultralight.db.first(
    'SELECT * FROM quiz_answers WHERE session_id = ? AND user_id = ? AND user_answer IS NULL ORDER BY sort_order ASC LIMIT 1',
    [session_id, uid()]
  );

  const answered: { cnt: number } | null = await ultralight.db.first(
    'SELECT COUNT(*) as cnt FROM quiz_answers WHERE session_id = ? AND user_id = ? AND user_answer IS NOT NULL', [session_id, uid()]
  );
  const total: Pick<QuizSessionRow, 'total_questions'> | null = await ultralight.db.first(
    'SELECT total_questions FROM quiz_sessions WHERE id = ? AND user_id = ?', [session_id, uid()]
  );

  return {
    is_correct: !!isCorrect,
    correct_answer: answer.correct_answer || null,
    explanation: answer.explanation || null,
    question_type: answer.question_type || 'mc',
    score: scoreVal,
    feedback: feedbackText,
    misconceptions: misconceptionsJson ? JSON.parse(misconceptionsJson) : null,
    answered: answered?.cnt || 0,
    total: total?.total_questions || 0,
    next_question: next ? { id: next.id, text: next.question, type: next.question_type || 'mc', options: JSON.parse(next.options || '[]'), rubric: next.rubric || null, target_words: next.target_words || null } : null,
    quiz_complete: !next,
  };
}

export async function complete_quiz(args: { session_id: string }): Promise<unknown> {
  const { session_id } = args;

  // Idempotency: prevent double-completion
  const session: Pick<QuizSessionRow, 'status'> | null = await ultralight.db.first(
    'SELECT status FROM quiz_sessions WHERE id = ? AND user_id = ?', [session_id, uid()]
  );
  if (!session) return { success: false, error: 'Session not found' };
  if (session.status === 'completed') return { success: false, error: 'Quiz already completed' };

  const answers: QuizAnswerWithConceptRow[] & { _fluency?: FluencyAssessment | null } = await ultralight.db.all(
    'SELECT qa.*, c.name as concept_name, c.subject_id FROM quiz_answers qa LEFT JOIN concepts c ON qa.concept_id = c.id WHERE qa.session_id = ? AND qa.user_id = ? ORDER BY qa.sort_order',
    [session_id, uid()]
  );

  // ── Batch grade all open-ended answers + fluency assessment in ONE LLM call ──
  const openAnswers = answers.filter((answer) => answer.question_type === 'open' && answer.user_answer && answer.is_correct === null);

  // Gather context for fluency assessment
  const quizSubjectId = answers.find((answer) => answer.subject_id)?.subject_id;
  const quizSubject: Pick<SubjectRow, 'name'> | null = quizSubjectId ? await ultralight.db.first('SELECT name FROM subjects WHERE id = ?', [quizSubjectId]) : null;
  const mcAnswered = answers.filter((answer) => answer.question_type !== 'open');
  const mcCorrect = mcAnswered.filter((answer) => answer.is_correct === 1).length;
  const mcTotal = mcAnswered.length;
  const mcPct = mcTotal > 0 ? Math.round((mcCorrect / mcTotal) * 100) : 0;

  // Fetch previous fluency for comparison
  let prevFluency = '';
  if (quizSubjectId) {
    try {
      const prevQuiz = await ultralight.db.first(
        'SELECT assessment_json FROM quiz_sessions WHERE user_id = ? AND subject_id = ? AND status = ? AND id != ? ORDER BY completed_at DESC LIMIT 1',
        [uid(), quizSubjectId, 'completed', session_id]
      ) as Pick<QuizSessionRow, 'assessment_json'> | null;
      const previousAssessment = parseJsonObject(prevQuiz?.assessment_json);
      const previousFluency = previousAssessment?.fluency as FluencyAssessment | undefined;
      if (previousFluency) {
        prevFluency = `Previous fluency assessment: ${previousFluency.level} (sophistication: ${previousFluency.sophistication}/10). ${previousFluency.notes || ''}`;
      }
    } catch {}
  }

  // Always do the fluency assessment (even if no open-ended answers)
  const shouldGrade = openAnswers.length > 0;
  {
    try {
      const gradingItems = openAnswers.map((answer, i: number) =>
        `Q${i + 1}: ${answer.question}\nRubric: ${answer.rubric || 'complete, accurate response'}\nStudent answer: ${answer.user_answer}`
      ).join('\n\n---\n\n');

      // Full answer context including MC for fluency signal
      const allAnswerContext = answers.map((answer, i: number) => {
        const timeNote = answer.time_seconds ? ` [${answer.time_seconds}s]` : '';
        if (answer.question_type === 'open') return `Q${i + 1} (open)${timeNote}: ${answer.question}\nAnswer: ${answer.user_answer}`;
        return `Q${i + 1} (MC)${timeNote}: ${answer.question}\nChose: ${answer.user_answer} ${answer.is_correct ? '(correct)' : '(wrong, correct: ' + answer.correct_answer + ')'}`;
      }).join('\n\n');

      const fluencyInstructions = `\n\nFLUENCY ASSESSMENT INSTRUCTIONS:
Assess the student's education/fluency level by analyzing:
1. The CALIBER of their open-ended answers — vocabulary, technical terminology, reasoning depth, conceptual connections
2. Their MC performance — ${mcPct}% correct (${mcCorrect}/${mcTotal}). Consider the DIFFICULTY of the questions they got right/wrong.
3. Response timing — fast correct answers suggest fluency; slow answers may indicate uncertainty even if correct
4. The TOPIC they're studying: "${quizSubject?.name || 'General'}" — choosing this topic itself signals something about their level
5. If they scored very high (≥90%), they are likely ABOVE the difficulty level of these questions — assess accordingly
6. If they scored very low (≤30%), the questions may have been too advanced — assess their actual level, not just "bad"
${prevFluency ? '\n' + prevFluency + '\nCompare their current performance to the previous assessment — have they improved, regressed, or been consistent?' : ''}`;

      const gradeResponse = await ultralight.ai({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'You are a tutor grading answers and assessing student fluency. Grade open-ended answers 1-5. Assess demonstrated education level from ALL evidence — topic choice, answer sophistication, MC patterns, timing. A perfect score means the student is ABOVE the quiz level. Respond with valid JSON only.' },
          { role: 'user', content: `${shouldGrade ? 'Grade the open-ended answers and assess' : 'Assess'} overall fluency.\n\nSubject: ${quizSubject?.name || 'General'}\nMC Score: ${mcPct}% (${mcCorrect}/${mcTotal})\n\nAll answers:\n${allAnswerContext}${shouldGrade ? '\n\nOpen-ended answers to grade:\n' + gradingItems : ''}${fluencyInstructions}\n\nRespond with ONLY valid JSON:\n{"grades":[${shouldGrade ? '{"q":1,"score":1-5,"is_correct":true/false,"feedback":"...","misconceptions":["..."]}' : ''}],"fluency":{"level":"elementary / middle school / high school / high school AP / undergraduate / graduate / professional","notes":"reasoning about vocabulary, depth, reasoning quality, and whether quiz difficulty matched their level","sophistication":1-10,"above_quiz_level":${mcPct >= 90 ? 'true' : 'false'}}}` },
        ],
      });

      if (gradeResponse?.content) {
        const gradeText = extractJsonText(gradeResponse.content);
        const parsed = JSON.parse(gradeText) as BatchGradingResponse | OpenAnswerGrade[];
        const grades = Array.isArray(parsed) ? parsed : parsed.grades || [];
        // Store fluency assessment for buildCourseContext
        if (!Array.isArray(parsed) && parsed.fluency) {
          answers._fluency = parsed.fluency;
        }
        const gradeArray = grades;
        for (let i = 0; i < openAnswers.length && i < gradeArray.length; i++) {
          const g = gradeArray[i];
          const a = openAnswers[i];
          const score = Math.min(5, Math.max(1, Math.round(g.score || 3)));
          const ic = score >= 3 ? 1 : 0;
          const mc = g.misconceptions?.length ? JSON.stringify(g.misconceptions) : null;
          await ultralight.db.run(
            'UPDATE quiz_answers SET is_correct = ?, score = ?, feedback = ?, misconceptions = ? WHERE id = ?',
            [ic, score, g.feedback || null, mc, a.id]
          );
          // Update in-memory answer for scoring below
          a.is_correct = ic; a.score = score; a.feedback = g.feedback; a.misconceptions = mc;
        }
      }
    } catch (e) {
      console.error('[complete_quiz] Batch grading failed:', e instanceof Error ? e.message : e);
      // Fallback: mark ungraded open answers as partial credit
      for (const a of openAnswers) {
        await ultralight.db.run('UPDATE quiz_answers SET is_correct = 0, score = 3, feedback = ? WHERE id = ?', ['Answer recorded — could not auto-grade.', a.id]);
        a.is_correct = 0; a.score = 3;
      }
    }
  }

  const total = answers.length;
  const correct = answers.filter((answer) => answer.is_correct === 1).length;
  const scorePct = total > 0 ? Math.round((correct / total) * 100) : 0;

  // Update session
  await ultralight.db.run(
    'UPDATE quiz_sessions SET status = ?, score_pct = ?, correct_count = ?, completed_at = ? WHERE id = ? AND user_id = ?',
    ['completed', scorePct, correct, now(), session_id, uid()]
  );

  // Identify weak/strong concepts and collect misconceptions
  const conceptResults: Record<string, { correct: number; total: number; name: string; avg_score: number; scores: number[] }> = {};
  let subjectId: string | null = null;
  const allMisconceptions: string[] = [];
  for (const answer of answers) {
    if (answer.concept_name) {
      if (!conceptResults[answer.concept_name]) conceptResults[answer.concept_name] = { correct: 0, total: 0, name: answer.concept_name, avg_score: 0, scores: [] };
      conceptResults[answer.concept_name].total++;
      if (answer.is_correct) conceptResults[answer.concept_name].correct++;
      if (answer.score) conceptResults[answer.concept_name].scores.push(answer.score);
    }
    if (answer.subject_id) subjectId = answer.subject_id;
    if (answer.misconceptions) allMisconceptions.push(...parseStringArray(answer.misconceptions));
  }
  for (const cr of Object.values(conceptResults)) {
    cr.avg_score = cr.scores.length ? Math.round((cr.scores.reduce((s, v) => s + v, 0) / cr.scores.length) * 10) / 10 : 0;
  }

  const weakConcepts = Object.values(conceptResults).filter(c => c.correct / c.total < 0.5).map(c => c.name);
  const strongConcepts = Object.values(conceptResults).filter(c => c.correct / c.total >= 0.8).map(c => c.name);

  // Store misconceptions as convention for Flash context
  if (allMisconceptions.length > 0) {
    const unique = [...new Set(allMisconceptions)].slice(0, 10);
    await setConvention('recent_misconceptions', JSON.stringify(unique), 'learning');
  }

  // Update student profile
  await updateStudentProfile(subjectId, scorePct, strongConcepts, weakConcepts);

  // Update conventions for Flash context injection
  const subjectName = subjectId
    ? (await ultralight.db.first('SELECT name FROM subjects WHERE id = ?', [subjectId]) as Pick<SubjectRow, 'name'> | null)?.name || 'General'
    : 'General';

  const convValue = `Score: ${scorePct}%.${weakConcepts.length ? ' Weak: ' + weakConcepts.join(', ') + '.' : ''}${strongConcepts.length ? ' Strong: ' + strongConcepts.join(', ') + '.' : ''}`;
  await setConvention(`${subjectName.toLowerCase()}_mastery`, convValue, 'progress');

  // ── Comprehensive Assessment ──
  // Per-concept mastery rating (1-5 scale)
  const perConceptAssessment: Record<string, PerConceptAssessment> = {};
  for (const [name, cr] of Object.entries(conceptResults)) {
    const mastery = cr.total > 0 ? Math.round((cr.correct / cr.total) * 5 * 10) / 10 : 0;
    const conceptAnswers = answers.filter((answer) => answer.concept_name === name);
    const timings = conceptAnswers.map((answer) => answer.time_seconds).filter((value): value is number => Boolean(value));
    perConceptAssessment[name] = {
      correct: cr.correct, total: cr.total, mastery,
      avg_score: cr.avg_score,
      time_avg_s: timings.length ? Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length) : null,
    };
  }

  // Timing summary
  const allTimings = answers.map((answer) => answer.time_seconds).filter((value): value is number => Boolean(value));
  const timingSummary = {
    total_s: allTimings.reduce((sum, value) => sum + value, 0),
    avg_per_question_s: allTimings.length ? Math.round(allTimings.reduce((sum, value) => sum + value, 0) / allTimings.length) : null,
  };

  // Compare with previous quiz on same subject
  let improvement: QuizAssessment['improvement'] = null;
  if (subjectId) {
    const prevQuiz: Pick<QuizSessionRow, 'assessment_json' | 'score_pct'> | null = await ultralight.db.first(
      'SELECT assessment_json, score_pct FROM quiz_sessions WHERE user_id = ? AND subject_id = ? AND status = ? AND id != ? ORDER BY completed_at DESC LIMIT 1',
      [uid(), subjectId, 'completed', session_id]
    );
    if (prevQuiz?.assessment_json) {
      try {
        const prev = parseJsonObject(prevQuiz.assessment_json);
        const prevPerConcept = (prev?.per_concept as Record<string, { mastery: number }> | undefined) || {};
        const improved: string[] = [];
        const regressed: string[] = [];
        for (const [name, cur] of Object.entries(perConceptAssessment)) {
          const prevConcept = prevPerConcept[name];
          if (prevConcept) {
            perConceptAssessment[name].prev_mastery = prevConcept.mastery;
            perConceptAssessment[name].delta = Math.round((cur.mastery - prevConcept.mastery) * 10) / 10;
            if (cur.mastery > prevConcept.mastery) improved.push(name);
            else if (cur.mastery < prevConcept.mastery) regressed.push(name);
          }
        }
        improvement = { prev_score: prevQuiz.score_pct || 0, delta: scorePct - (prevQuiz.score_pct || 0), improved, regressed };
      } catch {}
    }
  }

  const overallMastery = Math.round((scorePct / 20) * 10) / 10; // 0-100% → 0-5 scale
  // Fluency from batch grading (if open-ended questions were graded)
  const fluency = answers._fluency || null;

  const assessment: QuizAssessment = {
    per_concept: perConceptAssessment,
    timing: timingSummary,
    improvement,
    misconceptions: [...new Set(allMisconceptions)].slice(0, 10),
    overall_mastery: overallMastery,
    fluency,  // { level, notes, sophistication } — assessed by AI, not shown to user
  };

  // Store assessment in session
  await ultralight.db.run(
    'UPDATE quiz_sessions SET assessment_json = ? WHERE id = ? AND user_id = ?',
    [JSON.stringify(assessment), session_id, uid()]
  );

  // ── Build fresh course context (stores to convention for next calls) ──
  let courseContext: CourseContext | null = null;
  if (subjectId) {
    try { courseContext = await buildCourseContext(subjectId); } catch (e) {
      console.error('[complete_quiz] buildCourseContext failed:', e instanceof Error ? e.message : e);
    }
  }

  // ── Always generate lesson with full course context ──
  let lesson = null;
  try {
    const lessonResult = await generate_lesson({ quiz_session_id: session_id, assessment });
    if ((lessonResult as { success?: boolean }).success !== false) lesson = lessonResult;
  } catch (e) {
    console.error('[complete_quiz] Lesson generation failed:', e instanceof Error ? e.message : e);
  }

  // ── Pre-generate next quiz for instant start later ──
  let pendingQuiz = null;
  if (subjectId && courseContext) {
    try {
      pendingQuiz = await pre_generate_quiz(subjectId, courseContext);
    } catch (e) {
      console.error('[complete_quiz] Pre-generate quiz failed:', e instanceof Error ? e.message : e);
    }
  }

  // Save last subject for widget persistence
  if (subjectId) {
    await setConvention('last_quiz_subject', subjectId, 'ui');
  }

  return {
    session_id,
    score_pct: scorePct,
    correct,
    total,
    per_concept: conceptResults,
    weak_concepts: weakConcepts,
    strong_concepts: strongConcepts,
    assessment,
    lesson,
    pending_quiz: pendingQuiz,
  };
}

async function updateStudentProfile(subjectId: string | null, score: number, strengths: string[], weaknesses: string[]) {
  const existing: StudentProfileRow | null = subjectId
    ? await ultralight.db.first('SELECT * FROM student_profiles WHERE user_id = ? AND subject_id = ?', [uid(), subjectId])
    : await ultralight.db.first('SELECT * FROM student_profiles WHERE user_id = ? AND subject_id IS NULL', [uid()]);

  if (existing) {
    const oldStrengths = parseStringArray(existing.strengths);
    const oldWeaknesses = parseStringArray(existing.weaknesses);
    // Merge: add new strengths, remove from weaknesses if now strong
    const mergedStrengths = [...new Set([...oldStrengths, ...strengths])].filter(s => !weaknesses.includes(s));
    const mergedWeaknesses = [...new Set([...oldWeaknesses, ...weaknesses])].filter(w => !strengths.includes(w));
    const newAvg = existing.quiz_count > 0
      ? (existing.avg_score * existing.quiz_count + score) / (existing.quiz_count + 1)
      : score;

    await ultralight.db.run(
      'UPDATE student_profiles SET strengths = ?, weaknesses = ?, avg_score = ?, quiz_count = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(mergedStrengths), JSON.stringify(mergedWeaknesses), Math.round(newAvg * 10) / 10, existing.quiz_count + 1, now(), existing.id]
    );
  } else {
    await ultralight.db.run(
      'INSERT INTO student_profiles (id, user_id, subject_id, strengths, weaknesses, avg_score, quiz_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), uid(), subjectId, JSON.stringify(strengths), JSON.stringify(weaknesses), score, 1, now()]
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LESSON GENERATION
// ════════════════════════════════════════════════════════════════════════════

export async function generate_lesson(args: {
  subject_id?: string; concept_ids?: string[]; quiz_session_id?: string; assessment?: QuizAssessment;
}): Promise<unknown> {
  const { subject_id, concept_ids, quiz_session_id, assessment } = args;

  let targetConcepts: string[] = [];
  let answerContext = '';
  let resolvedSubjectId = subject_id || null;
  let scorePct: number | null = null;

  // If from a quiz, fetch ALL answers (not just wrong ones) for rich context
  if (quiz_session_id) {
    const allAnswers: Array<Pick<QuizAnswerWithConceptRow, 'question' | 'correct_answer' | 'user_answer' | 'explanation' | 'is_correct' | 'score' | 'feedback' | 'time_seconds' | 'question_type' | 'concept_name'>> = await ultralight.db.all(
      'SELECT qa.question, qa.correct_answer, qa.user_answer, qa.explanation, qa.is_correct, qa.score, qa.feedback, qa.time_seconds, qa.question_type, c.name as concept_name FROM quiz_answers qa LEFT JOIN concepts c ON qa.concept_id = c.id WHERE qa.session_id = ? AND qa.user_id = ? ORDER BY qa.sort_order',
      [quiz_session_id, uid()]
    );
    for (const answer of allAnswers) {
      if (answer.concept_name) targetConcepts.push(answer.concept_name);
      const status = answer.is_correct ? '✓ CORRECT' : '✗ WRONG';
      const timing = answer.time_seconds ? ` [${answer.time_seconds}s]` : '';
      answerContext += `${status}${timing} — Q: ${answer.question}\n  Student: ${answer.user_answer}${answer.is_correct ? '' : ' | Correct: ' + answer.correct_answer}\n${answer.feedback ? '  Feedback: ' + answer.feedback + '\n' : ''}`;
    }
    const session: Pick<QuizSessionRow, 'subject_id' | 'score_pct'> | null = await ultralight.db.first('SELECT subject_id, score_pct FROM quiz_sessions WHERE id = ?', [quiz_session_id]);
    if (session?.subject_id) resolvedSubjectId = session.subject_id;
    scorePct = session?.score_pct ?? null;
  }

  // Or from explicit concept list
  if (concept_ids?.length) {
    const ph = concept_ids.map(() => '?').join(',');
    const concepts: Array<Pick<ConceptRow, 'name' | 'description'>> = await ultralight.db.all(`SELECT name, description FROM concepts WHERE user_id = ? AND id IN (${ph})`, [uid(), ...concept_ids]);
    targetConcepts = concepts.map((concept) => concept.name);
  }

  // Fallback: get subject name as target if no concepts
  if (targetConcepts.length === 0 && resolvedSubjectId) {
    const subj: Pick<SubjectRow, 'name'> | null = await ultralight.db.first('SELECT name FROM subjects WHERE id = ?', [resolvedSubjectId]);
    if (subj?.name) targetConcepts.push(subj.name);
  }
  if (targetConcepts.length === 0) return { success: false, error: 'No concepts to generate a lesson for.' };

  // Pull full course context if available, fallback to basic student context
  let courseCtx = '';
  if (resolvedSubjectId) {
    try {
      const cached: Pick<ConventionRow, 'value'> | null = await ultralight.db.first('SELECT value FROM conventions WHERE user_id = ? AND key = ?', [uid(), `course_context:${resolvedSubjectId}`]);
      if (cached?.value) {
        const ctx = parseJsonObject(cached.value);
        courseCtx = typeof ctx?.prompt_text === 'string' ? ctx.prompt_text : '';
      }
    } catch {}
  }
  if (!courseCtx) courseCtx = await getStudentContext(resolvedSubjectId || undefined);

  const uniqueConcepts = [...new Set(targetConcepts)];

  // Score-aware prompt strategy
  let strategy: string;
  if (scorePct !== null && scorePct >= 80) {
    strategy = 'The student scored well. Create a lesson that deepens understanding, explores edge cases, real-world applications, and connects concepts to broader topics. Briefly reinforce what they got right, then go significantly deeper with advanced material.';
  } else if (scorePct !== null && scorePct >= 50) {
    strategy = 'The student has partial understanding. Create a balanced lesson: reinforce what they got right, then thoroughly address the gaps and misconceptions. Use analogies and examples to clarify confusing areas.';
  } else {
    strategy = 'The student is struggling. Build understanding from the ground up using simple analogies, step-by-step explanations, and concrete examples. Be encouraging and patient.';
  }

  // Improvement context from assessment
  let improvementCtx = '';
  if (assessment?.improvement) {
    const imp = assessment.improvement;
    if (imp.delta > 0) improvementCtx += `Student improved ${imp.delta} points since last quiz (${imp.prev_score}% → ${scorePct}%).`;
    else if (imp.delta < 0) improvementCtx += `Student regressed ${Math.abs(imp.delta)} points since last quiz (${imp.prev_score}% → ${scorePct}%).`;
    if (imp.improved?.length) improvementCtx += ` Improved in: ${imp.improved.join(', ')}.`;
    if (imp.regressed?.length) improvementCtx += ` Regressed in: ${imp.regressed.join(', ')} — needs extra attention.`;
  }

  const prompt = `${strategy}\n\n${courseCtx ? '## Full Course History\n' + courseCtx + '\n' : ''}Concepts covered in this lesson: ${uniqueConcepts.join(', ')}\n\n${answerContext ? '## Latest Quiz Performance\n' + answerContext + '\n' : ''}${improvementCtx ? '## Progress Tracking\n' + improvementCtx + '\n' : ''}Write a clear, engaging lesson in markdown format that:\n1. Builds on all previous lessons — don't repeat material already covered\n2. Addresses specific misconceptions from the quiz answers\n3. Uses concrete examples and analogies\n4. Includes 2-3 "check your understanding" reflection prompts\n5. Ends with key takeaways and suggested next steps\n\n500-800 words. Clear headers and formatting.`;

  try {
    const response = await ultralight.ai({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'You are an expert tutor creating personalized lessons based on quiz performance. Tailor your teaching to the student\'s demonstrated level. Reference their specific answers when addressing misconceptions.' },
        { role: 'user', content: prompt },
      ],
    });

    const title = `Lesson: ${uniqueConcepts.slice(0, 3).join(', ')}`;
    const lessonId = crypto.randomUUID();
    await ultralight.db.run(
      'INSERT INTO lessons (id, user_id, subject_id, quiz_session_id, title, content, weak_concepts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [lessonId, uid(), resolvedSubjectId, quiz_session_id || null, title, response.content, JSON.stringify(uniqueConcepts), 'unread', now()]
    );

    return { success: true, lesson_id: lessonId, title, content: response.content, concepts_covered: uniqueConcepts };
  } catch (e) {
    console.error('[generate_lesson] Failed:', e instanceof Error ? e.message : e);
    return { success: false, error: 'Lesson generation failed. Try again.' };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CONVENTIONS (Flash context injection)
// ════════════════════════════════════════════════════════════════════════════

async function setConvention(key: string, value: string, category: string) {
  const ts = now();
  const existing: Pick<ConventionRow, 'id'> | null = await ultralight.db.first('SELECT id FROM conventions WHERE user_id = ? AND key = ?', [uid(), key]);
  if (existing) {
    await ultralight.db.run('UPDATE conventions SET value = ?, category = ?, updated_at = ? WHERE id = ?', [value, category, ts, existing.id]);
  } else {
    await ultralight.db.run(
      'INSERT INTO conventions (id, user_id, key, value, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), uid(), key, value, category, ts, ts]
    );
  }
}

export async function conventions_get(args: { key?: string; category?: string }): Promise<unknown> {
  if (args.key) {
    const row: ConventionRow | null = await ultralight.db.first('SELECT * FROM conventions WHERE user_id = ? AND key = ?', [uid(), args.key]);
    return row || { message: 'Convention not found' };
  }
  let sql = 'SELECT * FROM conventions WHERE user_id = ?';
  const params: SqlValue[] = [uid()];
  if (args.category) { sql += ' AND category = ?'; params.push(args.category); }
  return { conventions: await ultralight.db.all(sql + ' ORDER BY category, key', params) as ConventionRow[] };
}

export async function conventions_set(args: { key: string; value: string; category?: string }): Promise<unknown> {
  await setConvention(args.key, args.value, args.category || 'general');
  return { success: true, key: args.key };
}

// ════════════════════════════════════════════════════════════════════════════
//  WIDGET: QUIZ (card-swipe)
// ════════════════════════════════════════════════════════════════════════════

export async function widget_quiz_ui(args: {}): Promise<unknown> {
  let badge = 0;
  try {
    const needsReview: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM concepts WHERE user_id = ?', [uid()]
    );
    badge = needsReview?.cnt || 0;
  } catch { /* tables may not exist yet */ }
  return { meta: { title: 'Quiz', icon: '🎯', badge_count: badge }, app_html: QUIZ_WIDGET_HTML, version: '4.0' };
}

export async function widget_quiz_data(args: { action?: string; session_id?: string; answer_id?: string; user_answer?: string; subject_id?: string; count?: number; topic?: string; file_content?: string; file_name?: string; time_seconds?: number }): Promise<unknown> {
  const { action } = args;
  let badge = 0;
  try {
    const needsReview: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM concepts WHERE user_id = ?', [uid()]
    );
    badge = needsReview?.cnt || 0;
  } catch { /* tables may not exist yet */ }
  const meta = { title: 'Quiz', icon: '🎯', badge_count: badge };

  if (!action) {
    return { meta };
  }

  if (action === 'subjects') {
    const subjects: Array<SubjectRow & { concept_count: number }> = await ultralight.db.all('SELECT sub.*, (SELECT COUNT(*) FROM concepts WHERE subject_id = sub.id AND user_id = ?) as concept_count FROM subjects sub WHERE user_id = ?', [uid(), uid()]);
    // Pending quizzes and unread lessons for "continue where you left off"
    const pendingQuizzes: QuizSessionWithSubjectRow[] = await ultralight.db.all(
      'SELECT qs.id, qs.subject_id, qs.total_questions, qs.generated_at, s.name as subject_name FROM quiz_sessions qs LEFT JOIN subjects s ON qs.subject_id = s.id WHERE qs.user_id = ? AND qs.status = ? ORDER BY qs.generated_at DESC',
      [uid(), 'pending']
    );
    const unreadLessons: LessonRow[] = await ultralight.db.all(
      'SELECT l.id, l.subject_id, l.title, l.created_at, s.name as subject_name FROM lessons l LEFT JOIN subjects s ON l.subject_id = s.id WHERE l.user_id = ? AND (l.status = ? OR l.status IS NULL) ORDER BY l.created_at DESC LIMIT 5',
      [uid(), 'unread']
    );
    const lastSubject: Pick<ConventionRow, 'value'> | null = await ultralight.db.first('SELECT value FROM conventions WHERE user_id = ? AND key = ?', [uid(), 'last_quiz_subject']);
    return { meta, subjects, pending_quizzes: pendingQuizzes, unread_lessons: unreadLessons, last_subject_id: lastSubject?.value || null, _code_version: '7.0.0', _model: AI_MODEL };
  }

  if (action === 'quick_start') {
    return quick_start({ topic: args.topic, file_content: args.file_content, file_name: args.file_name });
  }

  if (action === 'start') {
    return start_quiz({ subject_id: args.subject_id, count: args.count || 5 });
  }

  if (action === 'answer') {
    return submit_answer({ session_id: args.session_id!, answer_id: args.answer_id!, user_answer: args.user_answer!, time_seconds: args.time_seconds });
  }

  if (action === 'complete') {
    return complete_quiz({ session_id: args.session_id! });
  }

  if (action === 'start_pending') {
    return start_pending_quiz(args.session_id!);
  }

  if (action === 'pending') {
    const pending = await ultralight.db.all(
      'SELECT qs.*, s.name as subject_name FROM quiz_sessions qs LEFT JOIN subjects s ON qs.subject_id = s.id WHERE qs.user_id = ? AND qs.status = ? ORDER BY qs.generated_at DESC',
      [uid(), 'pending']
    );
    return { meta, pending };
  }

  return { error: 'Unknown action' };
}

const QUIZ_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: #1a1a1a; background: #fff; padding: 20px; }
.setup { padding: 24px 0; }
.setup h2 { font-size: 18px; font-weight: 600; margin-bottom: 4px; text-align: center; }
.setup .sub { color: #666; font-size: 13px; text-align: center; margin-bottom: 16px; }
.input-row { display: flex; gap: 8px; margin-bottom: 12px; }
.topic-input { flex: 1; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; outline: none; }
.topic-input:focus { border-color: #0a0a0a; }
.file-btn { padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; cursor: pointer; font-size: 16px; }
.file-btn:hover { background: #fafafa; }
.file-label { font-size: 12px; color: #666; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.file-label .remove { color: #ef4444; cursor: pointer; font-size: 14px; }
.suggest-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.suggest-chip { padding: 5px 12px; border: 1px solid #e5e7eb; border-radius: 16px; font-size: 12px; cursor: pointer; background: #fff; color: #666; }
.suggest-chip:hover { border-color: #0a0a0a; color: #0a0a0a; }
.divider { display: flex; align-items: center; gap: 12px; margin: 16px 0; color: #ccc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #e5e7eb; }
.subject-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.chip { padding: 6px 14px; border: 1px solid #e5e7eb; border-radius: 20px; font-size: 13px; cursor: pointer; background: #fff; transition: all 0.15s; }
.chip:hover { border-color: #0a0a0a; }
.chip.selected { background: #0a0a0a; color: #fff; border-color: #0a0a0a; }
.chip .cnt { font-size: 11px; opacity: 0.6; margin-left: 4px; }
.start-btn { width: 100%; margin-top: 12px; padding: 10px 28px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
.start-btn:hover { background: #333; }
.start-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.card { max-width: 600px; margin: 0 auto; }
.progress-bar { display: flex; gap: 4px; margin-bottom: 20px; }
.progress-dot { flex: 1; height: 4px; border-radius: 2px; background: #e5e7eb; }
.progress-dot.correct { background: #22c55e; }
.progress-dot.wrong { background: #ef4444; }
.progress-dot.current { background: #0a0a0a; }
.question-num { font-size: 12px; color: #999; margin-bottom: 8px; }
.question-text { font-size: 17px; font-weight: 500; line-height: 1.5; margin-bottom: 20px; }
.options { display: flex; flex-direction: column; gap: 8px; }
.option { padding: 12px 16px; border: 1px solid #e5e7eb; border-radius: 10px; font-size: 14px; cursor: pointer; text-align: left; background: #fff; transition: all 0.15s; }
.option:hover:not(.answered) { border-color: #0a0a0a; background: #fafafa; }
.option.correct-answer { border-color: #22c55e; background: #f0fdf4; }
.option.wrong-answer { border-color: #ef4444; background: #fef2f2; }
.option.answered { cursor: default; }
.open-answer { width: 100%; min-height: 80px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; font-size: 14px; font-family: inherit; resize: vertical; outline: none; }
.open-answer:focus { border-color: #0a0a0a; }
.submit-open { margin-top: 8px; padding: 8px 20px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; float: right; }
.submit-open:disabled { opacity: 0.4; cursor: not-allowed; }

.feedback { margin-top: 16px; padding: 14px 16px; border-radius: 10px; font-size: 13px; line-height: 1.5; clear: both; }
.feedback.correct { background: #f0fdf4; color: #166534; }
.feedback.wrong { background: #fef2f2; color: #991b1b; }
.feedback.partial { background: #fffbeb; color: #92400e; }
.feedback .label { font-weight: 600; margin-bottom: 4px; }
.score-dots { display: flex; gap: 4px; margin: 6px 0; }
.score-dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e7eb; }
.score-dot.filled { background: #0a0a0a; }
.misconceptions { margin-top: 8px; font-size: 12px; color: #666; }
.misconceptions span { display: inline-block; background: #fef2f2; color: #991b1b; padding: 1px 6px; border-radius: 3px; margin: 2px 2px 2px 0; font-size: 11px; }
.next-btn { margin-top: 16px; padding: 8px 20px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; float: right; }
.next-btn:hover { background: #333; }

.results { text-align: center; padding: 20px 0; }
.score-big { font-size: 48px; font-weight: 700; }
.score-label { font-size: 14px; color: #666; margin-top: 4px; }
.concept-list { text-align: left; margin: 20px 0; }
.concept-item { padding: 8px 0; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; font-size: 13px; }
.concept-item .tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
.tag-weak { background: #fef2f2; color: #991b1b; }
.tag-strong { background: #f0fdf4; color: #166534; }
.retry-btn { margin-top: 12px; padding: 8px 20px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; display: inline-block; }
.lesson-btn { margin-top: 12px; margin-right: 8px; padding: 8px 20px; background: #1d4ed8; color: #fff; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; display: inline-block; }
.lesson-btn:hover { background: #1e40af; }
.loading { text-align: center; padding: 40px; color: #999; }
.spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #e5e7eb; border-top-color: #0a0a0a; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
input[type="file"] { display: none; }
</style>
</head>
<body>
<div id="app"></div>
<input type="file" id="filePicker" accept=".pdf,.png,.jpg,.jpeg,.txt,.md">
<script>
var state = { view: 'setup', subjects: [], selectedSubject: null, session: null, currentQ: null, answers: [], results: null, loading: false, loadingMsg: '', file: null, error: null, questionShownAt: 0 };
var SUGGESTIONS = ['Biology', 'History', 'Math', 'Physics', 'Code', 'Language', 'Chemistry', 'Literature'];
var agentActionsRegistered = false;

function currentSubject() {
  for (var i = 0; i < state.subjects.length; i++) {
    if (state.subjects[i].id === state.selectedSubject) return state.subjects[i];
  }
  return null;
}

function buildQuizWidgetAgentSnapshot() {
  var subject = currentSubject();
  var enabled = ['show_quiz_setup', 'focus_quiz_topic'];
  if (state.selectedSubject) enabled.push('start_selected_subject_quiz');
  if (state.results && state.results.lesson && state.results.lesson.lesson_id) enabled.push('open_related_lesson');
  var components = [
    {
      id: 'quiz_setup',
      type: 'form',
      label: 'Quiz setup',
      purpose: 'Choose a topic, upload notes, or select a subject',
      actions: ['show_quiz_setup', 'focus_quiz_topic', 'start_selected_subject_quiz'],
      state: { visible: state.view === 'setup', selected_subject_id: state.selectedSubject }
    }
  ];
  if (state.view === 'quiz' && state.currentQ) {
    components.push({
      id: 'quiz_card',
      type: 'question',
      label: 'Current quiz question',
      purpose: 'Answer the active quiz question',
      data_refs: [{ type: 'quiz_question', id: state.currentQ.id, label: state.currentQ.text }],
      state: {
        question_index: state.currentIdx + 1,
        total_questions: state.session ? state.session.total : 0,
        answered: !!state.answered,
        question_type: state.currentQ.type || 'mc'
      }
    });
  }
  if (state.view === 'results' && state.results) {
    components.push({
      id: 'quiz_results',
      type: 'summary',
      label: 'Quiz results',
      purpose: 'Review score, weak concepts, and generated lesson',
      actions: ['open_related_lesson', 'show_quiz_setup'],
      state: { score_pct: state.results.score_pct, has_lesson: !!(state.results.lesson && state.results.lesson.lesson_id) }
    });
  }
  return {
    widget_id: 'quiz',
    title: 'Quiz',
    summary: state.view === 'quiz' && state.currentQ
      ? 'Question ' + (state.currentIdx + 1) + ' of ' + (state.session ? state.session.total : 0) + ': ' + state.currentQ.text
      : state.view === 'results' && state.results
      ? 'Quiz complete with score ' + state.results.score_pct + '%'
      : subject
      ? 'Quiz setup with selected subject ' + subject.name
      : 'Quiz setup with no selected subject',
    current_view: state.view,
    selected_entities: [
      subject ? { type: 'subject', id: subject.id, label: subject.name, table: 'subjects' } : null,
      state.session ? { type: 'quiz_session', id: state.session.id, label: 'Current quiz session', table: 'quiz_sessions' } : null,
      state.currentQ ? { type: 'quiz_question', id: state.currentQ.id, label: state.currentQ.text, table: 'quiz_answers' } : null
    ].filter(Boolean),
    visible_components: components,
    pending_edits: state.view === 'quiz' && state.currentQ && !state.answered && (state.currentQ.type || 'mc') === 'open'
      ? [{ field: 'user_answer', label: 'Open quiz answer', dirty: true }]
      : [],
    enabled_actions: enabled,
    updated_at: new Date().toISOString()
  };
}

function syncQuizWidgetAgentContext() {
  if (!window.ulWidget || typeof window.ulWidget.reportState !== 'function') return;
  window.ulWidget.reportState(buildQuizWidgetAgentSnapshot);
}

function registerQuizWidgetAction(action, handler) {
  if (!window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  if (typeof window.ulWidget.registerViewAction === 'function' && action.mode === 'ui') {
    window.ulWidget.registerViewAction(action, handler);
    return;
  }
  window.ulWidget.registerAction(action, handler);
}

function registerQuizAgentActions() {
  if (agentActionsRegistered || !window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  agentActionsRegistered = true;
  registerQuizWidgetAction({
    id: 'show_quiz_setup',
    label: 'Show quiz setup',
    description: 'Return to the quiz setup view with topic input and subject picker.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'navigate', component_id: 'quiz_setup' }
  }, function() {
    state.view = 'setup';
    state.answered = false;
    state.results = null;
    render();
    return { view: state.view };
  });
  registerQuizWidgetAction({
    id: 'focus_quiz_topic',
    label: 'Focus quiz topic',
    description: 'Focus the topic input and optionally prefill a requested topic.',
    mode: 'ui',
    confirmation: 'none',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    ui: { command: 'prefill', component_id: 'topic_input' }
  }, function(args) {
    state.view = 'setup';
    render();
    var input = document.getElementById('topicInput');
    var text = args && (args.text || args.topic || args.value);
    if (input && text) input.value = String(text);
    if (input && typeof input.focus === 'function') input.focus();
    syncQuizWidgetAgentContext();
    return { focused: !!input, prefilled: !!text };
  });
  registerQuizWidgetAction({
    id: 'start_selected_subject_quiz',
    label: 'Start selected subject quiz',
    description: 'Start a quiz for the currently selected subject.',
    mode: 'write',
    confirmation: 'user',
    mcp: { function: 'widget_quiz_data', args_template: { action: 'start' } }
  }, async function() {
    if (!state.selectedSubject) throw new Error('No subject selected');
    await startQuiz();
    return { view: state.view, session_id: state.session && state.session.id };
  });
  registerQuizWidgetAction({
    id: 'open_related_lesson',
    label: 'Open related lesson',
    description: 'Open the lesson generated from the current quiz result.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open_widget', component_id: 'lesson_result' }
  }, function() {
    var lessonId = state.results && state.results.lesson && state.results.lesson.lesson_id;
    if (!lessonId) throw new Error('No related lesson is available');
    openLesson(lessonId);
    return { lesson_id: lessonId };
  });
  syncQuizWidgetAgentContext();
}

function log(tag, msg, data) { console.log('[Quiz/' + tag + '] ' + msg, data !== undefined ? data : ''); }
function showError(msg) { state.error = msg; state.loading = false; render(); setTimeout(function() { state.error = null; render(); }, 8000); }

document.getElementById('filePicker').addEventListener('change', function(e) {
  var f = e.target.files[0];
  if (!f || f.size > 5 * 1024 * 1024) { alert('File must be under 5MB'); return; }
  var reader = new FileReader();
  reader.onload = function(ev) { state.file = { name: f.name, content: ev.target.result }; render(); };
  reader.readAsDataURL(f);
});

async function load() {
  log('load', 'Loading subjects...');
  state.loading = true; state.loadingMsg = 'Loading...'; render();
  try {
    var data = await ulAction('widget_quiz_data', { action: 'subjects' });
    log('load', 'Subjects loaded:', data);
    state.subjects = data.subjects || [];
    state.pendingQuizzes = data.pending_quizzes || [];
    state.unreadLessons = data.unread_lessons || [];
    // Auto-select last studied subject
    if (data.last_subject_id && !state.selectedSubject) {
      state.selectedSubject = data.last_subject_id;
    }
  } catch(e) { log('load', 'ERROR loading subjects:', e.message || e); }
  state.loading = false; render();
}

async function quickStart(topic) {
  if (!topic && !state.file) return;
  log('quickStart', 'Starting with topic:', topic);
  state.loading = true; state.loadingMsg = 'Extracting concepts...'; state.error = null; render();
  try {
    var args = { action: 'quick_start' };
    if (topic) args.topic = topic;
    if (state.file) { args.file_content = state.file.content; args.file_name = state.file.name; log('quickStart', 'File attached:', state.file.name); }
    log('quickStart', 'Calling quick_start...', args.topic);
    var res = await ulAction('widget_quiz_data', args);
    log('quickStart', 'quick_start response:', res);
    // Handle async job promotion — poll until complete
    if (res._async && res.job_id) {
      log('quickStart', 'Async job promoted, polling...', res.job_id);
      state.loadingMsg = 'AI is analyzing (this may take a moment)...'; render();
      for (var attempt = 0; attempt < 30; attempt++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        try {
          var job = await ulAction('ul.job', { job_id: res.job_id });
          log('quickStart', 'Job poll ' + attempt + ':', job?.status);
          if (job && job.status === 'completed' && job.result) { res = job.result; break; }
          if (job && job.status === 'failed') { showError(job.error || 'AI extraction failed'); return; }
        } catch(pe) { log('quickStart', 'Poll error:', pe.message); }
      }
      if (res._async) { showError('Timed out waiting for AI. Try again.'); return; }
    }
    if (res.success === false) { showError(res.error || 'Could not extract concepts. Try again.'); return; }
    state.selectedSubject = res.subject_id;
    state.file = null;
    log('quickStart', 'Subject created:', res.subject_name + ' (' + res.subject_id + '), ' + (res.concepts || []).length + ' concepts');
    // Reload subjects then start quiz
    var data = await ulAction('widget_quiz_data', { action: 'subjects' });
    state.subjects = data.subjects || [];
    state.loading = false;
    log('quickStart', 'Starting quiz for subject:', state.selectedSubject);
    startQuiz();
  } catch(e) {
    log('quickStart', 'ERROR:', e.message || e);
    showError('Failed: ' + (e.message || 'Unknown error'));
  }
}

function submitTopic() {
  var input = document.getElementById('topicInput');
  if (input && input.value.trim()) quickStart(input.value.trim());
}

async function startQuiz() {
  log('startQuiz', 'Starting quiz, subject:', state.selectedSubject);
  state.loading = true; state.loadingMsg = 'Generating quiz...'; state.view = 'quiz'; state.error = null; render();
  try {
    var data = await ulAction('widget_quiz_data', { action: 'start', subject_id: state.selectedSubject, count: 5 });
    log('startQuiz', 'start_quiz response:', data);
    if (data.success === false) {
      log('startQuiz', 'Quiz start failed:', data.error);
      state.view = 'setup';
      showError(data.error || 'Could not generate quiz. Add concepts first.');
      return;
    }
    state.session = { id: data.session_id, total: data.total_questions };
    state.currentQ = data.question;
    state.answers = new Array(data.total_questions).fill(null);
    state.currentIdx = 0;
    state.questionShownAt = Date.now();
    log('startQuiz', 'Quiz ready:', data.total_questions + ' questions, first Q type: ' + (data.question?.type || 'mc'));
  } catch(e) {
    log('startQuiz', 'ERROR:', e.message || e);
    state.view = 'setup';
    showError('Quiz generation failed: ' + (e.message || 'Unknown error'));
  }
  state.loading = false; render();
}

async function answerQuestion(userAnswer) {
  if (state.answering) return;
  state.answering = true;
  log('answer', 'Submitting answer:', userAnswer);
  state.loadingMsg = '';
  try {
    var elapsed = state.questionShownAt ? Math.round((Date.now() - state.questionShownAt) / 1000) : null;
    var res = await ulAction('widget_quiz_data', { action: 'answer', session_id: state.session.id, answer_id: state.currentQ.id, user_answer: userAnswer, time_seconds: elapsed });
    log('answer', 'Answer result:', { is_correct: res.is_correct, score: res.score, type: res.question_type, has_next: !!res.next_question });
    state.answers[state.currentIdx] = res.is_correct ? 'correct' : 'wrong';
    state.lastResult = res;
    state.answered = true;
  } catch(e) { log('answer', 'ERROR:', e.message || e); showError('Failed to submit answer: ' + (e.message || 'Unknown error')); }
  state.answering = false; state.loading = false; render();
}

function submitOpen() {
  var ta = document.getElementById('openAnswer');
  if (ta && ta.value.trim()) answerQuestion(ta.value.trim());
}

async function nextQuestion() {
  state.answered = false;
  if (state.lastResult.next_question) {
    state.currentQ = state.lastResult.next_question;
    state.currentIdx++;
    state.questionShownAt = Date.now();
    log('next', 'Next question:', { idx: state.currentIdx, type: state.currentQ.type });
    render();
  } else {
    log('next', 'Completing quiz...');
    state.loading = true; state.loadingMsg = 'Calculating results...'; state.view = 'results'; render();
    try {
      state.results = await ulAction('widget_quiz_data', { action: 'complete', session_id: state.session.id });
      log('next', 'Quiz completed:', { score: state.results?.score_pct, correct: state.results?.correct, total: state.results?.total });
    } catch(e) { log('next', 'ERROR completing:', e.message || e); showError('Failed to complete quiz'); }
    state.loading = false; render();
  }
}

function render() {
  var el = document.getElementById('app');
  setTimeout(syncQuizWidgetAgentContext, 0);
  var errorBanner = state.error ? '<div style="background:#fef2f2;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:12px;margin-bottom:12px">' + state.error + '</div>' : '';
  if (state.loading) { el.innerHTML = errorBanner + '<div class="loading"><div class="spinner"></div><p style="margin-top:12px">' + (state.loadingMsg || 'Loading...') + '</p></div>'; return; }

  if (state.view === 'setup') {
    var hasSubjects = state.subjects.length > 0;
    var html = errorBanner + '<div class="setup">';
    html += '<h2>What do you want to be quizzed on?</h2>';
    html += '<p class="sub">Enter a topic, upload notes, or pick a subject</p>';
    html += '<div class="input-row"><input class="topic-input" id="topicInput" placeholder="e.g. photosynthesis, World War 2, calculus..." onkeydown="if(event.key===\\'Enter\\')submitTopic()"><button class="file-btn" onclick="document.getElementById(\\'filePicker\\').click()" title="Upload file">&#128206;</button></div>';
    if (state.file) html += '<div class="file-label">&#128196; ' + state.file.name + ' <span class="remove" onclick="state.file=null;render()">&#10005;</span></div>';
    html += '<div class="suggest-chips">' + SUGGESTIONS.map(function(s) { return '<button class="suggest-chip" onclick="quickStart(\\'' + s + '\\')">' + s + '</button>'; }).join('') + '</div>';
    html += '<button class="start-btn" onclick="submitTopic()" style="margin-bottom:4px">Quiz Me</button>';

    // Show pending quizzes (pre-generated, instant start)
    if (state.pendingQuizzes && state.pendingQuizzes.length > 0) {
      html += '<div class="divider">ready to go</div>';
      state.pendingQuizzes.forEach(function(pq) {
        html += '<button class="start-btn" style="background:#1d4ed8;margin-bottom:8px" onclick="startPendingQuiz(\\'' + pq.id + '\\')">' +
          '▶ Resume: ' + (pq.subject_name || 'Quiz') + ' (' + pq.total_questions + ' questions)</button>';
      });
    }

    // Show unread lessons
    if (state.unreadLessons && state.unreadLessons.length > 0) {
      html += '<div class="divider">unread lessons</div>';
      state.unreadLessons.forEach(function(ul) {
        html += '<div style="padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px" onclick="openLesson(\\'' + ul.id + '\\')">' +
          '<span style="color:#1d4ed8">📖</span> ' + ul.title + '<span style="color:#999;font-size:11px;margin-left:8px">' + (ul.subject_name || '') + '</span></div>';
      });
    }

    if (hasSubjects) {
      html += '<div class="divider">or pick a subject</div>';
      html += '<div class="subject-chips">' + state.subjects.map(function(s) {
        var sel = state.selectedSubject === s.id ? ' selected' : '';
        return '<button class="chip' + sel + '" onclick="toggleSubject(\\'' + s.id + '\\')">' + s.name + '<span class="cnt">' + s.concept_count + '</span></button>';
      }).join('') + '</div>';
      html += '<button class="start-btn" onclick="startQuiz()"' + (state.selectedSubject ? '' : ' disabled') + '>Start Quiz on Subject</button>';
    }
    html += '</div>';
    el.innerHTML = html;
    return;
  }

  if (state.view === 'quiz' && state.currentQ) {
    var dots = state.answers.map(function(a, i) {
      var cls = a === 'correct' ? 'correct' : a === 'wrong' ? 'wrong' : i === state.currentIdx ? 'current' : '';
      return '<div class="progress-dot ' + cls + '"></div>';
    }).join('');

    var qType = state.currentQ.type || 'mc';
    var body = '';
    if (qType === 'mc') {
      body = '<div class="options">' + (state.currentQ.options || []).map(function(o, i) {
        var letter = String.fromCharCode(65 + i);
        var cls = 'option';
        if (state.answered) {
          cls += ' answered';
          var ca = (state.lastResult.correct_answer || '').charAt(0).toUpperCase();
          if (letter === ca) cls += ' correct-answer';
          else if (letter === (state.lastResult.user_answer || '').charAt(0).toUpperCase()) cls += ' wrong-answer';
        }
        return '<button class="' + cls + '" onclick="answerQuestion(\\'' + letter + '\\')">' + o + '</button>';
      }).join('') + '</div>';
    } else {
      if (!state.answered) {
        var tw = state.currentQ.target_words || 50;
        body = '<textarea class="open-answer" id="openAnswer" placeholder="Type your answer..." oninput="updateWordCount()"></textarea>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span id="wordCount" style="font-size:11px;color:#999">0 / ~' + tw + ' words</span>' +
          '<button class="submit-open" onclick="submitOpen()">Submit</button></div>';
      }
    }

    var feedback = '';
    if (state.answered) {
      var res = state.lastResult;
      if (qType === 'open') {
        var scoreClass = res.score >= 4 ? 'correct' : res.score >= 3 ? 'partial' : 'wrong';
        var scoreDots = '';
        for (var i = 1; i <= 5; i++) scoreDots += '<div class="score-dot' + (i <= res.score ? ' filled' : '') + '"></div>';
        feedback = '<div class="feedback ' + scoreClass + '"><div class="label">' + (res.score >= 4 ? 'Great answer!' : res.score >= 3 ? 'Partial credit' : 'Needs work') + '</div>' +
          '<div class="score-dots">' + scoreDots + '</div>' +
          (res.feedback || '') +
          (res.misconceptions && res.misconceptions.length ? '<div class="misconceptions">Misconceptions: ' + res.misconceptions.map(function(m) { return '<span>' + m + '</span>'; }).join('') + '</div>' : '') +
          '</div>';
      } else {
        var fc = res.is_correct ? 'correct' : 'wrong';
        feedback = '<div class="feedback ' + fc + '"><div class="label">' + (res.is_correct ? 'Correct!' : 'Not quite') + '</div>' + (res.explanation || '') + '</div>';
      }
      feedback += '<button class="next-btn" onclick="nextQuestion()">' + (res.next_question ? 'Next' : 'See Results') + '</button>';
    }

    el.innerHTML = '<div class="card"><div class="progress-bar">' + dots + '</div>' +
      '<div class="question-num">Question ' + (state.currentIdx + 1) + ' of ' + state.session.total + (qType === 'open' ? ' (open-ended)' : '') + '</div>' +
      '<div class="question-text">' + state.currentQ.text + '</div>' + body + feedback + '</div>';
    return;
  }

  if (state.view === 'results' && state.results) {
    var r = state.results;
    var concepts = Object.entries(r.per_concept || {}).map(function(e) {
      var name = e[0], c = e[1];
      if (!c || !c.total) return '';
      var pct = Math.round((c.correct / c.total) * 100);
      var scoreInfo = c.avg_score ? ' (avg ' + c.avg_score + '/5)' : '';
      var tag = pct >= 80 ? '<span class="tag tag-strong">Strong</span>' : '<span class="tag tag-weak">Needs work</span>';
      return '<div class="concept-item"><span>' + name + scoreInfo + '</span>' + tag + '</div>';
    }).filter(Boolean).join('');

    var lessonBtn = (r.lesson && r.lesson.lesson_id) ?
      '<button class="lesson-btn" onclick="openLesson(\\'' + r.lesson.lesson_id + '\\')">View Lesson</button>' : '';
    var imp = r.assessment && r.assessment.improvement;
    var assessmentNote = imp ?
      '<div style="font-size:12px;color:#666;margin:8px 0">' +
      (imp.delta > 0 ? '↑ Improved ' + imp.delta + ' pts from last quiz' :
       imp.delta < 0 ? '↓ Dropped ' + Math.abs(imp.delta) + ' pts from last quiz' : 'Same score as last quiz') +
      '</div>' : '';

    el.innerHTML = '<div class="results"><div class="score-big">' + r.score_pct + '%</div><div class="score-label">' + r.correct + ' of ' + r.total + ' correct</div>' +
      assessmentNote +
      (concepts ? '<div class="concept-list">' + concepts + '</div>' : '') +
      '<div style="text-align:center;margin-top:16px">' + lessonBtn + '<button class="retry-btn" onclick="resetQuiz()">Take Another Quiz</button></div></div>';
    return;
  }
}

function updateWordCount() {
  var ta = document.getElementById('openAnswer');
  var wc = document.getElementById('wordCount');
  if (ta && wc) {
    var words = ta.value.trim().split(/\\s+/).filter(Boolean).length;
    var tw = state.currentQ.target_words || 50;
    var color = words >= tw * 0.8 ? '#22c55e' : words >= tw * 0.4 ? '#f59e0b' : '#999';
    wc.innerHTML = '<span style="color:' + color + '">' + words + '</span> / ~' + tw + ' words';
  }
}

function openLesson(lessonId) {
  if (window.ulOpenWidget) ulOpenWidget('lessons', { lesson_id: lessonId });
  else log('openLesson', 'ulOpenWidget not available');
}

async function startPendingQuiz(sessionId) {
  log('startPending', 'Starting pending quiz:', sessionId);
  state.loading = true; state.loadingMsg = 'Loading quiz...'; render();
  try {
    var data = await ulAction('widget_quiz_data', { action: 'start_pending', session_id: sessionId });
    if (data.success === false) { showError(data.error || 'Could not start quiz'); return; }
    state.session = { id: data.session_id, total: data.total_questions };
    state.currentQ = data.question;
    state.answers = new Array(data.total_questions).fill(null);
    state.currentIdx = 0;
    state.questionShownAt = Date.now();
    state.view = 'quiz';
    log('startPending', 'Quiz ready (instant):', data.total_questions + ' questions');
  } catch(e) { log('startPending', 'ERROR:', e.message || e); showError('Failed to start quiz'); }
  state.loading = false; render();
}

function toggleSubject(id) { state.selectedSubject = state.selectedSubject === id ? null : id; render(); }
function resetQuiz() { state = { view: 'setup', subjects: state.subjects, selectedSubject: null, session: null, currentQ: null, answers: [], results: null, loading: false, loadingMsg: '', file: null, questionShownAt: 0 }; load(); }
if (!window.ulAction) window.ulAction = function() { return Promise.reject('No bridge'); };
registerQuizAgentActions();

// Context-aware loading: auto-start quiz if opened from Lessons widget
if (window.ulWidgetContext && window.ulWidgetContext.pending_session_id) {
  // Opened from dashboard with a pre-generated quiz — instant start
  load().then(function() { startPendingQuiz(window.ulWidgetContext.pending_session_id); });
} else if (window.ulWidgetContext && window.ulWidgetContext.subject_id) {
  state.selectedSubject = window.ulWidgetContext.subject_id;
  load().then(function() { startQuiz(); });
} else {
  load();
}
</script>
</body>
</html>`;

// ════════════════════════════════════════════════════════════════════════════
//  WIDGET: PROGRESS OVERVIEW
// ════════════════════════════════════════════════════════════════════════════

export async function widget_progress_ui(args: {}): Promise<unknown> {
  let badge = 0;
  try {
    const quizCount: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM quiz_sessions WHERE user_id = ? AND status = ?', [uid(), 'completed']
    );
    badge = quizCount?.cnt || 0;
  } catch { /* tables may not exist yet */ }
  return { meta: { title: 'Study Progress', icon: '📊', badge_count: badge }, app_html: PROGRESS_WIDGET_HTML, version: '4.0' };
}

export async function widget_progress_data(args: { action?: string; topic?: string; file_content?: string; file_name?: string }): Promise<unknown> {
  if (args.action === 'quick_start') {
    return quick_start({ topic: args.topic, file_content: args.file_content, file_name: args.file_name });
  }
  const statusData = await status({});

  // Add course dashboard data
  const pendingQuizzes: QuizSessionWithSubjectRow[] = await ultralight.db.all(
    'SELECT qs.id, qs.subject_id, qs.total_questions, qs.generated_at, s.name as subject_name FROM quiz_sessions qs LEFT JOIN subjects s ON qs.subject_id = s.id WHERE qs.user_id = ? AND qs.status = ? ORDER BY qs.generated_at DESC',
    [uid(), 'pending']
  );
  const unreadLessons: LessonRow[] = await ultralight.db.all(
    'SELECT l.id, l.subject_id, l.title, l.created_at, s.name as subject_name FROM lessons l LEFT JOIN subjects s ON l.subject_id = s.id WHERE l.user_id = ? AND (l.status = ? OR l.status IS NULL) ORDER BY l.created_at DESC LIMIT 5',
    [uid(), 'unread']
  );
  let badge = 0;
  try {
    const quizCount: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM quiz_sessions WHERE user_id = ? AND status = ?', [uid(), 'completed']
    );
    badge = quizCount?.cnt || 0;
  } catch { /* tables may not exist yet */ }

  return {
    ...(statusData as Record<string, unknown>),
    meta: { title: 'Study Progress', icon: '📊', badge_count: badge },
    pending_quizzes: pendingQuizzes,
    unread_lessons: unreadLessons,
  } as WidgetProgressData;
}

const PROGRESS_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: #1a1a1a; background: #fff; padding: 20px; }
.onboard { text-align: center; padding: 24px 0; }
.onboard h2 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
.onboard .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
.input-row { display: flex; gap: 8px; margin-bottom: 12px; }
.topic-input { flex: 1; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; outline: none; }
.topic-input:focus { border-color: #0a0a0a; }
.file-btn { padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; cursor: pointer; font-size: 16px; }
.file-btn:hover { background: #fafafa; }
.file-label { font-size: 12px; color: #666; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; justify-content: center; }
.file-label .remove { color: #ef4444; cursor: pointer; }
.suggest-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 12px; }
.suggest-chip { padding: 5px 12px; border: 1px solid #e5e7eb; border-radius: 16px; font-size: 12px; cursor: pointer; background: #fff; color: #666; }
.suggest-chip:hover { border-color: #0a0a0a; color: #0a0a0a; }
.go-btn { padding: 10px 28px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; width: 100%; }
.go-btn:hover { background: #333; }
.stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; }
.stat { text-align: center; padding: 16px; background: #f9fafb; border-radius: 10px; }
.stat-value { font-size: 24px; font-weight: 700; }
.stat-label { font-size: 11px; color: #999; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
h3 { font-size: 14px; font-weight: 600; margin: 16px 0 10px; }
.add-subject-btn { float: right; font-size: 12px; color: #666; background: none; border: 1px solid #e5e7eb; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.add-subject-btn:hover { border-color: #0a0a0a; color: #0a0a0a; }
.subject-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.subject-name { font-size: 13px; font-weight: 500; flex: 1; }
.mastery-bar { width: 120px; height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
.mastery-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.mastery-pct { font-size: 12px; color: #666; width: 36px; text-align: right; }
.quiz-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
.quiz-score { font-weight: 600; }
.quiz-date { color: #999; font-size: 12px; }
.tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
.tag-s { background: #f0fdf4; color: #166534; }
.tag-w { background: #fef2f2; color: #991b1b; }
.empty { text-align: center; color: #999; padding: 32px; font-size: 13px; }
.loading { text-align: center; padding: 40px; color: #999; }
.spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #e5e7eb; border-top-color: #0a0a0a; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
input[type="file"] { display: none; }
.add-input { display: none; margin: 12px 0; }
.add-input.show { display: block; }
</style>
</head>
<body>
<div id="app"><div class="loading"><div class="spinner"></div></div></div>
<input type="file" id="filePicker" accept=".pdf,.png,.jpg,.jpeg,.txt,.md">
<script>
var pState = { data: null, loading: false, file: null, showAdd: false };
var SUGGESTIONS = ['Biology', 'History', 'Math', 'Physics', 'Code', 'Language'];
var progressAgentActionsRegistered = false;

function buildProgressWidgetAgentSnapshot() {
  var d = pState.data || {};
  var enabled = ['focus_new_study_topic'];
  if (d.pending_quizzes && d.pending_quizzes.length) enabled.push('open_next_pending_quiz');
  if (d.unread_lessons && d.unread_lessons.length) enabled.push('open_latest_unread_lesson');
  var components = [
    {
      id: 'progress_summary',
      type: 'dashboard',
      label: 'Study progress summary',
      purpose: 'Show concept count, quiz count, and average rating',
      state: {
        total_concepts: d.total_concepts || 0,
        quiz_count: d.recent_quizzes ? d.recent_quizzes.length : 0,
        average_understanding: d.average_understanding || null
      }
    },
    {
      id: 'topic_input',
      type: 'input',
      label: 'New study topic',
      purpose: 'Create a new study subject from a topic or uploaded notes',
      actions: ['focus_new_study_topic'],
      state: { visible: !d.subjects || !d.subjects.length || pState.showAdd }
    }
  ];
  if (d.pending_quizzes && d.pending_quizzes.length) {
    components.push({
      id: 'pending_quiz',
      type: 'list',
      label: 'Pending quizzes',
      purpose: 'Resume pre-generated quizzes',
      actions: ['open_next_pending_quiz'],
      state: { count: d.pending_quizzes.length }
    });
  }
  if (d.unread_lessons && d.unread_lessons.length) {
    components.push({
      id: 'unread_lesson',
      type: 'list',
      label: 'Unread lessons',
      purpose: 'Open unread generated lessons',
      actions: ['open_latest_unread_lesson'],
      state: { count: d.unread_lessons.length }
    });
  }
  return {
    widget_id: 'progress',
    title: 'Study Progress',
    summary: (d.subjects && d.subjects.length)
      ? 'Progress dashboard with ' + d.subjects.length + ' subject(s), ' + (d.total_concepts || 0) + ' concept(s), and ' + ((d.recent_quizzes && d.recent_quizzes.length) || 0) + ' recent quiz(es)'
      : 'Progress onboarding view with no study data yet',
    current_view: (d.subjects && d.subjects.length) ? 'progress' : 'onboarding',
    selected_entities: (d.subjects || []).slice(0, 6).map(function(s) {
      return { type: 'subject', id: s.id || s.name, label: s.name, table: 'subjects', value: { mastery: s.mastery, quiz_count: s.quiz_count } };
    }),
    visible_components: components,
    enabled_actions: enabled,
    updated_at: new Date().toISOString()
  };
}

function syncProgressWidgetAgentContext() {
  if (!window.ulWidget || typeof window.ulWidget.reportState !== 'function') return;
  window.ulWidget.reportState(buildProgressWidgetAgentSnapshot);
}

function registerProgressWidgetAction(action, handler) {
  if (!window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  if (typeof window.ulWidget.registerViewAction === 'function' && action.mode === 'ui') {
    window.ulWidget.registerViewAction(action, handler);
    return;
  }
  window.ulWidget.registerAction(action, handler);
}

function registerProgressAgentActions() {
  if (progressAgentActionsRegistered || !window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  progressAgentActionsRegistered = true;
  registerProgressWidgetAction({
    id: 'focus_new_study_topic',
    label: 'Focus new study topic',
    description: 'Open the new topic input and optionally prefill a topic.',
    mode: 'ui',
    confirmation: 'none',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    ui: { command: 'prefill', component_id: 'topic_input' }
  }, function(args) {
    pState.showAdd = true;
    render();
    var input = document.getElementById('topicInput');
    var text = args && (args.text || args.topic || args.value);
    if (input && text) input.value = String(text);
    if (input && typeof input.focus === 'function') input.focus();
    syncProgressWidgetAgentContext();
    return { focused: !!input, prefilled: !!text };
  });
  registerProgressWidgetAction({
    id: 'open_next_pending_quiz',
    label: 'Open next pending quiz',
    description: 'Open the first pending quiz from the progress dashboard.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open_widget', component_id: 'pending_quiz' }
  }, function() {
    var pending = pState.data && pState.data.pending_quizzes && pState.data.pending_quizzes[0];
    if (!pending) throw new Error('No pending quiz is available');
    openPendingQuiz(pending.id, pending.subject_id);
    return { pending_session_id: pending.id, subject_id: pending.subject_id };
  });
  registerProgressWidgetAction({
    id: 'open_latest_unread_lesson',
    label: 'Open latest unread lesson',
    description: 'Open the first unread lesson from the progress dashboard.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open_widget', component_id: 'unread_lesson' }
  }, function() {
    var lesson = pState.data && pState.data.unread_lessons && pState.data.unread_lessons[0];
    if (!lesson) throw new Error('No unread lesson is available');
    openLessonWidget(lesson.id);
    return { lesson_id: lesson.id };
  });
  syncProgressWidgetAgentContext();
}

document.getElementById('filePicker').addEventListener('change', function(e) {
  var f = e.target.files[0];
  if (!f || f.size > 5*1024*1024) { alert('File must be under 5MB'); return; }
  var reader = new FileReader();
  reader.onload = function(ev) { pState.file = { name: f.name, content: ev.target.result }; render(); };
  reader.readAsDataURL(f);
});

async function load() {
  pState.loading = true; render();
  try { pState.data = await ulAction('widget_progress_data', {}); } catch(e) {}
  pState.loading = false; render();
}

async function quickStart(topic) {
  if (!topic && !pState.file) return;
  pState.loading = true; render();
  try {
    var args = { action: 'quick_start' };
    if (topic) args.topic = topic;
    if (pState.file) { args.file_content = pState.file.content; args.file_name = pState.file.name; }
    await ulAction('widget_progress_data', args);
    pState.file = null; pState.showAdd = false;
  } catch(e) {}
  pState.loading = false; load();
}

function submitTopic() {
  var input = document.getElementById('topicInput');
  if (input && input.value.trim()) quickStart(input.value.trim());
}

function render() {
  var el = document.getElementById('app');
  setTimeout(syncProgressWidgetAgentContext, 0);
  if (pState.loading) { el.innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:12px">Loading...</p></div>'; return; }

  var d = pState.data;
  if (!d || (!d.subjects?.length && !d.recent_quizzes?.length)) {
    // Empty state — onboarding
    var html = '<div class="onboard"><h2>Start learning something new</h2><p class="sub">Enter a topic or upload your notes to begin tracking progress</p>';
    html += '<div class="input-row"><input class="topic-input" id="topicInput" placeholder="e.g. photosynthesis, calculus..." onkeydown="if(event.key===\\'Enter\\')submitTopic()"><button class="file-btn" onclick="document.getElementById(\\'filePicker\\').click()">&#128206;</button></div>';
    if (pState.file) html += '<div class="file-label">&#128196; ' + pState.file.name + ' <span class="remove" onclick="pState.file=null;render()">&#10005;</span></div>';
    html += '<div class="suggest-chips">' + SUGGESTIONS.map(function(s) { return '<button class="suggest-chip" onclick="quickStart(\\'' + s + '\\')">' + s + '</button>'; }).join('') + '</div>';
    html += '<button class="go-btn" onclick="submitTopic()">Start Learning</button></div>';
    el.innerHTML = html; return;
  }

  // Has data — show progress
  var html = '';

  // ── Continue Learning section (pending items) ──
  var hasPending = (d.pending_quizzes && d.pending_quizzes.length > 0) || (d.unread_lessons && d.unread_lessons.length > 0);
  if (hasPending) {
    html += '<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px;margin-bottom:16px">';
    html += '<h3 style="font-size:13px;color:#0369a1;margin-bottom:8px">📚 Continue Learning</h3>';
    if (d.pending_quizzes) d.pending_quizzes.forEach(function(pq) {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #e0f2fe;font-size:13px">' +
        '<span>🎯 Quiz: ' + (pq.subject_name || 'Ready') + ' (' + pq.total_questions + 'q)</span>' +
        '<button style="padding:4px 12px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer" onclick="openPendingQuiz(\\'' + pq.id + '\\',\\'' + pq.subject_id + '\\')">Start</button></div>';
    });
    if (d.unread_lessons) d.unread_lessons.forEach(function(ul) {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:13px">' +
        '<span>📖 ' + ul.title + '</span>' +
        '<button style="padding:4px 12px;background:#059669;color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer" onclick="openLessonWidget(\\'' + ul.id + '\\')">Read</button></div>';
    });
    html += '</div>';
  }

  html += '<div class="stats"><div class="stat"><div class="stat-value">' + (d.total_concepts || 0) + '</div><div class="stat-label">Concepts</div></div>' +
    '<div class="stat"><div class="stat-value">' + (d.recent_quizzes?.length || 0) + '</div><div class="stat-label">Quizzes</div></div>' +
    '<div class="stat"><div class="stat-value">' + (d.average_understanding ? d.average_understanding + '/5' : '--') + '</div><div class="stat-label">Avg Rating</div></div></div>';

  if (d.subjects && d.subjects.length > 0) {
    html += '<h3>Subjects <button class="add-subject-btn" onclick="pState.showAdd=!pState.showAdd;render()">+ New Subject</button></h3>';
    html += '<div class="add-input' + (pState.showAdd ? ' show' : '') + '"><div class="input-row"><input class="topic-input" id="topicInput" placeholder="New topic..." onkeydown="if(event.key===\\'Enter\\')submitTopic()"><button class="file-btn" onclick="document.getElementById(\\'filePicker\\').click()">&#128206;</button></div></div>';
    d.subjects.forEach(function(s) {
      var pct = s.mastery || 0;
      var color = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
      html += '<div class="subject-row"><span class="subject-name">' + s.name + ' <span style="color:#999;font-size:11px">(' + s.quiz_count + ' quizzes)</span></span>' +
        '<div class="mastery-bar"><div class="mastery-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<span class="mastery-pct">' + Math.round(pct) + '%</span></div>';
      if (s.weaknesses.length || s.strengths.length) {
        html += '<div class="tags">';
        s.strengths.forEach(function(t) { html += '<span class="tag tag-s">' + t + '</span>'; });
        s.weaknesses.forEach(function(t) { html += '<span class="tag tag-w">' + t + '</span>'; });
        html += '</div>';
      }
    });
  }

  if (d.recent_quizzes && d.recent_quizzes.length > 0) {
    html += '<h3>Recent Quizzes</h3>';
    d.recent_quizzes.forEach(function(q) {
      var date = q.date ? new Date(q.date).toLocaleDateString() : '';
      html += '<div class="quiz-row"><span>' + (q.subject || 'Mixed') + ' <span class="quiz-date">' + date + '</span></span><span class="quiz-score">' + q.score + '% (' + q.correct + '/' + q.questions + ')</span></div>';
    });
  }

  el.innerHTML = html;
}
function openPendingQuiz(sessionId, subjectId) {
  if (window.ulOpenWidget) ulOpenWidget('quiz', { pending_session_id: sessionId, subject_id: subjectId });
}
function openLessonWidget(lessonId) {
  if (window.ulOpenWidget) ulOpenWidget('lessons', { lesson_id: lessonId });
}
if (!window.ulAction) window.ulAction = function() { return Promise.reject('No bridge'); };
registerProgressAgentActions();
load();
</script>
</body>
</html>`;

// ════════════════════════════════════════════════════════════════════════════
//  WIDGET: LESSONS
// ════════════════════════════════════════════════════════════════════════════

export async function widget_lessons_ui(args: {}): Promise<unknown> {
  let badge = 0;
  try {
    const lessonCount: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM lessons WHERE user_id = ?', [uid()]
    );
    badge = lessonCount?.cnt || 0;
  } catch { /* tables may not exist yet */ }
  return { meta: { title: 'Lessons', icon: '📖', badge_count: badge }, app_html: LESSONS_WIDGET_HTML, version: '4.0' };
}

export async function widget_lessons_data(args: { action?: string; lesson_id?: string; limit?: number; topic?: string; file_content?: string; file_name?: string; subject_id?: string; concept_ids?: string[] }): Promise<unknown> {
  if (args.action === 'quick_start') {
    return quick_start({ topic: args.topic, file_content: args.file_content, file_name: args.file_name });
  }
  if (args.action === 'generate_lesson') {
    return generate_lesson({ subject_id: args.subject_id, concept_ids: args.concept_ids });
  }

  if (args.action === 'mark_read') {
    if (!args.lesson_id) return { error: 'lesson_id required' };
    await ultralight.db.run(
      'UPDATE lessons SET status = ?, read_at = ? WHERE id = ? AND user_id = ?',
      ['reading', now(), args.lesson_id, uid()]
    );
    return { success: true };
  }
  if (args.lesson_id) {
    const lesson = await ultralight.db.first(
      'SELECT l.*, s.name as subject_name FROM lessons l LEFT JOIN subjects s ON l.subject_id = s.id WHERE l.id = ? AND l.user_id = ?',
      [args.lesson_id, uid()]
    );
    return lesson || { error: 'Lesson not found' };
  }
  const lessons = await ultralight.db.all(
    'SELECT l.id, l.title, l.subject_id, l.quiz_session_id, l.weak_concepts, l.created_at, s.name as subject_name FROM lessons l LEFT JOIN subjects s ON l.subject_id = s.id WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT ?',
    [uid(), args.limit || 10]
  );
  let badge = 0;
  try {
    const lessonCount: CntRow | null = await ultralight.db.first(
      'SELECT COUNT(*) as cnt FROM lessons WHERE user_id = ?', [uid()]
    );
    badge = lessonCount?.cnt || 0;
  } catch { /* tables may not exist yet */ }
  return { meta: { title: 'Lessons', icon: '📖', badge_count: badge }, lessons };
}

const LESSONS_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: #1a1a1a; background: #fff; padding: 20px; }
.onboard { text-align: center; padding: 24px 0; }
.onboard h2 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
.onboard .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
.input-row { display: flex; gap: 8px; margin-bottom: 12px; }
.topic-input { flex: 1; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; outline: none; }
.topic-input:focus { border-color: #0a0a0a; }
.file-btn { padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; cursor: pointer; font-size: 16px; }
.file-btn:hover { background: #fafafa; }
.file-label { font-size: 12px; color: #666; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; justify-content: center; }
.file-label .remove { color: #ef4444; cursor: pointer; }
.suggest-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 12px; }
.suggest-chip { padding: 5px 12px; border: 1px solid #e5e7eb; border-radius: 16px; font-size: 12px; cursor: pointer; background: #fff; color: #666; }
.suggest-chip:hover { border-color: #0a0a0a; color: #0a0a0a; }
.go-btn { padding: 10px 28px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; width: 100%; }
.go-btn:hover { background: #333; }
.new-lesson-row { margin-bottom: 16px; }
.new-lesson-row .input-row { margin-bottom: 0; }
.lesson-list {}
.lesson-card { padding: 14px 0; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
.lesson-card:hover { background: #fafafa; margin: 0 -20px; padding: 14px 20px; }
.lesson-title { font-size: 14px; font-weight: 500; }
.lesson-meta { font-size: 12px; color: #999; margin-top: 3px; }
.lesson-tags { display: flex; gap: 4px; margin-top: 6px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: #f3f4f6; color: #666; }
.lesson-content { padding: 16px; background: #f9fafb; border-radius: 10px; font-size: 13px; line-height: 1.7; }
.lesson-content h1, .lesson-content h2 { font-size: 16px; font-weight: 600; margin: 16px 0 8px; color: #0a0a0a; }
.lesson-content h3 { font-size: 14px; font-weight: 600; margin: 12px 0 6px; }
.lesson-content p { margin: 8px 0; }
.lesson-content ul, .lesson-content ol { margin: 8px 0 8px 20px; }
.lesson-content li { margin: 4px 0; }
.lesson-content code { background: #e5e7eb; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.lesson-content strong, .lesson-content b { font-weight: 600; }
.lesson-content em, .lesson-content i { font-style: italic; }
.lesson-content blockquote { border-left: 3px solid #d1d5db; padding-left: 12px; margin: 8px 0; color: #666; }
.back-btn { display: inline-block; margin-bottom: 12px; font-size: 13px; color: #666; cursor: pointer; border: none; background: none; padding: 0; }
.back-btn:hover { color: #0a0a0a; }
.quiz-me-btn { margin-top: 12px; padding: 8px 20px; background: #0a0a0a; color: #fff; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; }
.page-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
.page-nav button { padding: 8px 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; }
.page-nav button:hover { background: #f3f4f6; border-color: #0a0a0a; }
.page-nav button:disabled { opacity: 0.3; cursor: not-allowed; }
.page-nav button.primary { background: #0a0a0a; color: #fff; border-color: #0a0a0a; }
.page-nav button.primary:hover { background: #333; }
.page-dots { display: flex; gap: 6px; }
.page-dot { width: 8px; height: 8px; border-radius: 50%; background: #e5e7eb; }
.page-dot.active { background: #0a0a0a; }
.page-dot.done { background: #22c55e; }
.quiz-me-btn:hover { background: #333; }
.empty { text-align: center; color: #999; padding: 32px; font-size: 13px; }
.loading { text-align: center; padding: 40px; color: #999; }
.spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #e5e7eb; border-top-color: #0a0a0a; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
input[type="file"] { display: none; }
</style>
</head>
<body>
<div id="app"><div class="loading"><div class="spinner"></div></div></div>
<input type="file" id="filePicker" accept=".pdf,.png,.jpg,.jpeg,.txt,.md">
<script>
var lState = { view: 'list', lessons: [], currentLesson: null, loading: false, loadingMsg: '', file: null };
var SUGGESTIONS = ['Biology', 'History', 'Math', 'Physics', 'Code', 'Language'];
var lessonsAgentActionsRegistered = false;

function buildLessonsWidgetAgentSnapshot() {
  var enabled = ['show_lesson_list', 'focus_lesson_topic'];
  if (lState.currentLesson || (lState.lessons && lState.lessons.length)) enabled.push('open_selected_lesson');
  if (lState.currentLesson && lState.currentPage < (lState.pages || []).length - 1) enabled.push('next_lesson_page');
  if (lState.currentLesson && lState.currentLesson.subject_id) enabled.push('start_lesson_quiz');
  var components = [
    {
      id: 'lesson_list',
      type: 'list',
      label: 'Lesson list',
      purpose: 'Browse generated lessons',
      actions: ['show_lesson_list', 'open_selected_lesson'],
      state: { visible: lState.view === 'list', count: lState.lessons ? lState.lessons.length : 0 }
    },
    {
      id: 'topic_input',
      type: 'input',
      label: 'New lesson topic',
      purpose: 'Generate a new personalized lesson',
      actions: ['focus_lesson_topic'],
      state: { visible: lState.view === 'list' }
    }
  ];
  if (lState.currentLesson) {
    components.push({
      id: 'lesson_detail',
      type: 'document',
      label: lState.currentLesson.title || 'Lesson',
      purpose: 'Read the selected lesson',
      data_refs: [{ type: 'lesson', id: lState.currentLesson.id, label: lState.currentLesson.title, table: 'lessons' }],
      actions: ['next_lesson_page', 'start_lesson_quiz', 'show_lesson_list'],
      state: {
        page: (lState.currentPage || 0) + 1,
        total_pages: (lState.pages || []).length || 1,
        subject_id: lState.currentLesson.subject_id || null
      }
    });
  }
  return {
    widget_id: 'lessons',
    title: 'Lessons',
    summary: lState.currentLesson
      ? 'Reading lesson "' + lState.currentLesson.title + '" page ' + ((lState.currentPage || 0) + 1) + ' of ' + ((lState.pages || []).length || 1)
      : 'Lesson list with ' + ((lState.lessons && lState.lessons.length) || 0) + ' lesson(s)',
    current_view: lState.view,
    selected_entities: lState.currentLesson
      ? [{ type: 'lesson', id: lState.currentLesson.id, label: lState.currentLesson.title, table: 'lessons' }]
      : (lState.lessons || []).slice(0, 6).map(function(lesson) {
        return { type: 'lesson', id: lesson.id, label: lesson.title, table: 'lessons' };
      }),
    visible_components: components,
    enabled_actions: enabled,
    updated_at: new Date().toISOString()
  };
}

function syncLessonsWidgetAgentContext() {
  if (!window.ulWidget || typeof window.ulWidget.reportState !== 'function') return;
  window.ulWidget.reportState(buildLessonsWidgetAgentSnapshot);
}

function registerLessonsWidgetAction(action, handler) {
  if (!window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  if (typeof window.ulWidget.registerViewAction === 'function' && action.mode === 'ui') {
    window.ulWidget.registerViewAction(action, handler);
    return;
  }
  window.ulWidget.registerAction(action, handler);
}

function registerLessonsAgentActions() {
  if (lessonsAgentActionsRegistered || !window.ulWidget || typeof window.ulWidget.registerAction !== 'function') return;
  lessonsAgentActionsRegistered = true;
  registerLessonsWidgetAction({
    id: 'show_lesson_list',
    label: 'Show lesson list',
    description: 'Return to the lesson list.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'navigate', component_id: 'lesson_list' }
  }, async function() {
    await loadList();
    return { view: lState.view, lesson_count: lState.lessons.length };
  });
  registerLessonsWidgetAction({
    id: 'open_selected_lesson',
    label: 'Open selected lesson',
    description: 'Open the current or first available lesson.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open', component_id: 'lesson_detail' }
  }, async function() {
    if (lState.currentLesson) return { lesson_id: lState.currentLesson.id };
    var lesson = lState.lessons && lState.lessons[0];
    if (!lesson) throw new Error('No lesson is available');
    await viewLesson(lesson.id);
    return { lesson_id: lesson.id };
  });
  registerLessonsWidgetAction({
    id: 'next_lesson_page',
    label: 'Next lesson page',
    description: 'Advance to the next page in the current lesson.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'navigate', component_id: 'lesson_page' }
  }, function() {
    if (!lState.currentLesson) throw new Error('No lesson is open');
    nextPage();
    return { page: (lState.currentPage || 0) + 1, total_pages: (lState.pages || []).length || 1 };
  });
  registerLessonsWidgetAction({
    id: 'start_lesson_quiz',
    label: 'Start lesson quiz',
    description: 'Open the Quiz widget for the current lesson subject.',
    mode: 'ui',
    confirmation: 'none',
    ui: { command: 'open_widget', component_id: 'lesson_quiz' }
  }, function() {
    if (!lState.currentLesson || !lState.currentLesson.subject_id) throw new Error('Current lesson has no subject');
    openQuizForSubject(lState.currentLesson.subject_id);
    return { subject_id: lState.currentLesson.subject_id };
  });
  registerLessonsWidgetAction({
    id: 'focus_lesson_topic',
    label: 'Focus lesson topic',
    description: 'Focus the new lesson topic input and optionally prefill a requested topic.',
    mode: 'ui',
    confirmation: 'none',
    args_schema: { type: 'object', properties: { text: { type: 'string' } } },
    ui: { command: 'prefill', component_id: 'topic_input' }
  }, function(args) {
    lState.view = 'list';
    render();
    var input = document.getElementById('topicInput');
    var text = args && (args.text || args.topic || args.value);
    if (input && text) input.value = String(text);
    if (input && typeof input.focus === 'function') input.focus();
    syncLessonsWidgetAgentContext();
    return { focused: !!input, prefilled: !!text };
  });
  syncLessonsWidgetAgentContext();
}

document.getElementById('filePicker').addEventListener('change', function(e) {
  var f = e.target.files[0];
  if (!f || f.size > 5*1024*1024) { alert('File must be under 5MB'); return; }
  var reader = new FileReader();
  reader.onload = function(ev) { lState.file = { name: f.name, content: ev.target.result }; render(); };
  reader.readAsDataURL(f);
});

async function loadList() {
  lState.view = 'list'; lState.loading = true; lState.loadingMsg = 'Loading...'; render();
  try {
    var data = await ulAction('widget_lessons_data', { limit: 20 });
    lState.lessons = data.lessons || [];
  } catch(e) {}
  lState.loading = false; render();
}

async function quickStartLesson(topic) {
  if (!topic && !lState.file) return;
  lState.loading = true; lState.loadingMsg = 'Creating lesson...'; render();
  try {
    var args = { action: 'quick_start' };
    if (topic) args.topic = topic;
    if (lState.file) { args.file_content = lState.file.content; args.file_name = lState.file.name; }
    var qs = await ulAction('widget_lessons_data', args);
    lState.file = null;
    if (qs.success !== false && qs.subject_id) {
      lState.loadingMsg = 'Generating lesson...';
      render();
      var lesson = await ulAction('widget_lessons_data', { action: 'generate_lesson', subject_id: qs.subject_id });
      if (lesson.success !== false && lesson.lesson_id) {
        lState.currentLesson = { id: lesson.lesson_id, title: lesson.title, content: lesson.content, subject_name: qs.subject_name, weak_concepts: JSON.stringify(lesson.concepts_covered || []) };
        lState.view = 'detail'; lState.loading = false; render(); return;
      }
    }
  } catch(e) {}
  lState.loading = false; loadList();
}

function submitTopic() {
  var input = document.getElementById('topicInput');
  if (input && input.value.trim()) quickStartLesson(input.value.trim());
}

// Simple markdown to HTML renderer
function mdToHtml(md) {
  if (!md) return '';
  var lines = md.split('\\n');
  var html = '';
  var inList = false;
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    // Headers
    if (line.match(/^### /)) { if (inList) { html += '</ul>'; inList = false; } html += '<h3>' + line.slice(4) + '</h3>'; continue; }
    if (line.match(/^## /)) { if (inList) { html += '</ul>'; inList = false; } html += '<h2>' + line.slice(3) + '</h2>'; continue; }
    if (line.match(/^# /)) { if (inList) { html += '</ul>'; inList = false; } html += '<h1>' + line.slice(2) + '</h1>'; continue; }
    // Horizontal rules
    if (line.match(/^[=-]{3,}$/)) continue;
    // List items
    if (line.match(/^- /)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inlineMd(line.slice(2)) + '</li>'; continue; }
    if (line.match(/^\\d+\\. /)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inlineMd(line.replace(/^\\d+\\.\\s*/, '')) + '</li>'; continue; }
    // Blockquote
    if (line.match(/^> /)) { if (inList) { html += '</ul>'; inList = false; } html += '<blockquote>' + inlineMd(line.slice(2)) + '</blockquote>'; continue; }
    // Empty line
    if (line.trim() === '') { if (inList) { html += '</ul>'; inList = false; } continue; }
    // Paragraph
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inlineMd(line) + '</p>';
  }
  if (inList) html += '</ul>';
  return html;
}
function inlineMd(text) {
  return text
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>');
}

// Split lesson content into pages by ## headers
function splitIntoPages(content) {
  if (!content) return ['No content available'];
  var sections = content.split(/(?=^## )/m).filter(function(s) { return s.trim(); });
  if (sections.length <= 1) {
    // No ## headers — split by paragraphs into ~300 word chunks
    var words = content.split(/\s+/);
    var pages = [];
    for (var i = 0; i < words.length; i += 250) {
      pages.push(words.slice(i, i + 250).join(' '));
    }
    return pages.length > 0 ? pages : [content];
  }
  return sections;
}

async function viewLesson(id) {
  lState.loading = true; lState.loadingMsg = 'Loading lesson...'; lState.view = 'detail'; render();
  try {
    lState.currentLesson = await ulAction('widget_lessons_data', { lesson_id: id });
    lState.pages = splitIntoPages(lState.currentLesson.content);
    lState.currentPage = 0;
    // Mark as reading
    try { await ulAction('widget_lessons_data', { action: 'mark_read', lesson_id: id }); } catch(e) {}
  } catch(e) { lState.view = 'list'; }
  lState.loading = false; render();
}

function render() {
  var el = document.getElementById('app');
  setTimeout(syncLessonsWidgetAgentContext, 0);
  if (lState.loading) { el.innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:12px">' + lState.loadingMsg + '</p></div>'; return; }

  if (lState.view === 'list') {
    if (lState.lessons.length === 0) {
      // Empty state — onboarding
      var html = '<div class="onboard"><h2>What do you want to learn?</h2><p class="sub">Enter a topic or upload notes to generate a personalized lesson</p>';
      html += '<div class="input-row"><input class="topic-input" id="topicInput" placeholder="e.g. photosynthesis, quantum mechanics..." onkeydown="if(event.key===\\'Enter\\')submitTopic()"><button class="file-btn" onclick="document.getElementById(\\'filePicker\\').click()">&#128206;</button></div>';
      if (lState.file) html += '<div class="file-label">&#128196; ' + lState.file.name + ' <span class="remove" onclick="lState.file=null;render()">&#10005;</span></div>';
      html += '<div class="suggest-chips">' + SUGGESTIONS.map(function(s) { return '<button class="suggest-chip" onclick="quickStartLesson(\\'' + s + '\\')">' + s + '</button>'; }).join('') + '</div>';
      html += '<button class="go-btn" onclick="submitTopic()">Generate Lesson</button></div>';
      el.innerHTML = html; return;
    }

    // Has lessons — list + new lesson input at top
    var html = '<div class="new-lesson-row"><div class="input-row"><input class="topic-input" id="topicInput" placeholder="New lesson topic..." onkeydown="if(event.key===\\'Enter\\')submitTopic()"><button class="file-btn" onclick="document.getElementById(\\'filePicker\\').click()">&#128206;</button><button class="go-btn" style="width:auto;padding:10px 16px" onclick="submitTopic()">Go</button></div></div>';
    html += '<div class="lesson-list">';
    lState.lessons.forEach(function(l) {
      var concepts = [];
      try { concepts = JSON.parse(l.weak_concepts || '[]'); } catch(e) {}
      var date = l.created_at ? new Date(l.created_at).toLocaleDateString() : '';
      html += '<div class="lesson-card" onclick="viewLesson(\\'' + l.id + '\\')">' +
        '<div class="lesson-title">' + l.title + '</div>' +
        '<div class="lesson-meta">' + (l.subject_name || 'General') + ' &middot; ' + date + '</div>' +
        (concepts.length ? '<div class="lesson-tags">' + concepts.map(function(c) { return '<span class="tag">' + c + '</span>'; }).join('') + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  } else if (lState.view === 'detail' && lState.currentLesson) {
    var subjectId = lState.currentLesson.subject_id || '';
    var pages = lState.pages || [lState.currentLesson.content || 'Content unavailable'];
    var pg = lState.currentPage || 0;
    var totalPages = pages.length;
    var isLastPage = pg >= totalPages - 1;
    var isFirstPage = pg === 0;

    // Page dots
    var dots = '';
    for (var pi = 0; pi < totalPages; pi++) {
      var dotCls = pi === pg ? 'active' : pi < pg ? 'done' : '';
      dots += '<div class="page-dot ' + dotCls + '"></div>';
    }

    var html = '<button class="back-btn" onclick="loadList()">&larr; Back to lessons</button>';
    html += '<h2 style="font-size:16px;margin-bottom:4px">' + lState.currentLesson.title + '</h2>';
    html += '<div class="lesson-meta" style="margin-bottom:12px">' + (lState.currentLesson.subject_name || 'General') + ' &middot; Page ' + (pg + 1) + ' of ' + totalPages + '</div>';
    html += '<div class="lesson-content">' + mdToHtml(pages[pg]) + '</div>';

    // Navigation
    html += '<div class="page-nav">';
    html += '<button onclick="prevPage()"' + (isFirstPage ? ' disabled' : '') + '>&larr; Back</button>';
    html += '<div class="page-dots">' + dots + '</div>';
    if (isLastPage) {
      html += '<button class="primary" onclick="openQuizForSubject(\\'' + subjectId + '\\')">Quiz me on this &rarr;</button>';
    } else {
      html += '<button class="primary" onclick="nextPage()">Next &rarr;</button>';
    }
    html += '</div>';

    el.innerHTML = html;
  }
}

function nextPage() {
  if (lState.currentPage < (lState.pages || []).length - 1) { lState.currentPage++; render(); window.scrollTo(0, 0); }
}
function prevPage() {
  if (lState.currentPage > 0) { lState.currentPage--; render(); window.scrollTo(0, 0); }
}
function openQuizForSubject(subjectId) {
  if (window.ulOpenWidget && subjectId) ulOpenWidget('quiz', { subject_id: subjectId });
  else if (window.ulSendChat) ulSendChat('Quiz me on this subject');
}

if (!window.ulAction) window.ulAction = function() { return Promise.reject('No bridge'); };
registerLessonsAgentActions();

// Context-aware loading: auto-navigate to specific lesson if opened from Quiz results
if (window.ulWidgetContext && window.ulWidgetContext.lesson_id) {
  viewLesson(window.ulWidgetContext.lesson_id);
} else {
  loadList();
}
</script>
</body>
</html>`;
