import type { Goal } from "../types";
import { invokeAnki, invokeAnkiMulti, requestAnkiPermission, type AnkiMultiAction } from "./ankiConnect";

export type AnkiAnalysisMode = "overview" | "goal" | "deck";

const SCHEMA_VERSION = "1.5.0";
const CHUNK_SIZE = 500;

const FSRS_BUCKETS = [
  { metric: "stability", label: "under7", query: "prop:s<7", minimum: null, maximumExclusive: 7, unit: "days" },
  { metric: "stability", label: "from7ToUnder21", query: "prop:s>=7 prop:s<21", minimum: 7, maximumExclusive: 21, unit: "days" },
  { metric: "stability", label: "from21ToUnder90", query: "prop:s>=21 prop:s<90", minimum: 21, maximumExclusive: 90, unit: "days" },
  { metric: "stability", label: "atLeast90", query: "prop:s>=90", minimum: 90, maximumExclusive: null, unit: "days" },
  { metric: "difficulty", label: "under0_3", query: "prop:d<0.3", minimum: null, maximumExclusive: 0.3, unit: "normalized_0_to_1" },
  { metric: "difficulty", label: "from0_3ToUnder0_7", query: "prop:d>=0.3 prop:d<0.7", minimum: 0.3, maximumExclusive: 0.7, unit: "normalized_0_to_1" },
  { metric: "difficulty", label: "atLeast0_7", query: "prop:d>=0.7", minimum: 0.7, maximumExclusive: null, unit: "normalized_0_to_1" },
  { metric: "retrievability", label: "under0_7", query: "prop:r<0.7", minimum: null, maximumExclusive: 0.7, unit: "probability" },
  { metric: "retrievability", label: "from0_7ToUnder0_9", query: "prop:r>=0.7 prop:r<0.9", minimum: 0.7, maximumExclusive: 0.9, unit: "probability" },
  { metric: "retrievability", label: "atLeast0_9", query: "prop:r>=0.9", minimum: 0.9, maximumExclusive: null, unit: "probability" },
] as const;

type Raw = Record<string, unknown>;

export interface AnkiAnalysisProgress {
  phase: string;
  message: string;
  completed: number;
  total: number;
  percent: number;
}

type ProgressReporter = (progress: AnkiAnalysisProgress) => void;

function reportProgress(
  reporter: ProgressReporter | undefined,
  phase: string,
  message: string,
  percent: number,
  completed = 0,
  total = 0,
) {
  reporter?.({ phase, message, completed, total, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

function chunks<T>(items: T[], size = CHUNK_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function runMultiBatches<T>(
  actions: AnkiMultiAction[],
  batchSize = 10,
  onBatch?: (completed: number, total: number) => void,
) {
  const results: T[] = [];
  const batches = chunks(actions, batchSize);
  for (const [index, batch] of batches.entries()) {
    results.push(...await invokeAnkiMulti<T>(batch));
    onBatch?.(index + 1, batches.length);
  }
  return results;
}

function quoteDeck(deckName: string) {
  return `deck:"${deckName.replaceAll('"', '\\"')}"`;
}

function quoteExactDeck(deckName: string) {
  const escaped = deckName.replaceAll('"', '\\"');
  return `deck:"${escaped}" -deck:"${escaped}::*"`;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reviewTimestamp(review: Raw) {
  const id = numberValue(review.id);
  return id > 0 ? id : 0;
}

function recentReviews(reviews: Raw[], days: number, now = Date.now()) {
  const cutoff = now - days * 86_400_000;
  return reviews.filter((review) => reviewTimestamp(review) >= cutoff);
}

function rate(reviews: Raw[], ease: number) {
  if (!reviews.length) return 0;
  return reviews.filter((review) => numberValue(review.ease) === ease).length / reviews.length;
}

function reviewMetrics(reviews: Raw[]) {
  return {
    reviewCount: reviews.length,
    againCount: reviews.filter((review) => numberValue(review.ease) === 1).length,
    hardCount: reviews.filter((review) => numberValue(review.ease) === 2).length,
    goodCount: reviews.filter((review) => numberValue(review.ease) === 3).length,
    easyCount: reviews.filter((review) => numberValue(review.ease) === 4).length,
    againRate: rate(reviews, 1),
    hardRate: rate(reviews, 2),
  };
}

function recordedTime(reviews: Raw[]) {
  const rawSeconds = reviews.reduce((sum, review) => sum + numberValue(review.time) / 1000, 0);
  const planningSeconds = reviews.reduce(
    (sum, review) => sum + Math.min(numberValue(review.time) / 1000, 60),
    0,
  );
  return {
    reviewCount: reviews.length,
    recordedSeconds: Math.round(rawSeconds),
    planningCappedSeconds: Math.round(planningSeconds),
    planningCapSecondsPerReview: 60,
    averageRecordedSecondsPerReview: reviews.length ? rawSeconds / reviews.length : 0,
  };
}

function dailyActivity(reviews: Raw[], days: number, includeEmpty: boolean) {
  const now = new Date();
  const firstDate = new Date(now);
  firstDate.setDate(firstDate.getDate() - (days - 1));
  firstDate.setHours(0, 0, 0, 0);
  const result = new Map<string, Raw[]>();
  if (includeEmpty) {
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - offset);
      result.set(date.toLocaleDateString("en-CA"), []);
    }
  }
  for (const review of reviews.filter((item) => reviewTimestamp(item) >= firstDate.getTime())) {
    const date = new Date(reviewTimestamp(review)).toLocaleDateString("en-CA");
    result.set(date, [...(result.get(date) ?? []), review]);
  }
  return Array.from(result.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayReviews]) => ({ date, ...reviewMetrics(dayReviews), ...recordedTime(dayReviews) }));
}

function isoOrNull(timestamp: number) {
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

async function getCardsInfo(cardIds: number[], onBatch?: (completed: number, total: number) => void) {
  const results = await runMultiBatches<Raw[]>(
    chunks(cardIds).map((cards) => ({ action: "cardsInfo", params: { cards } })),
    10,
    onBatch,
  );
  return results.flat();
}

async function getReviews(cardIds: number[], onBatch?: (completed: number, total: number) => void) {
  const results = await runMultiBatches<Record<string, Raw[]>>(
    chunks(cardIds).map((cards) => ({ action: "getReviewsOfCards", params: { cards } })),
    10,
    onBatch,
  );
  return Object.assign({}, ...results) as Record<string, Raw[]>;
}

function deckHierarchy(name: string) {
  const parts = name.split("::");
  return { name, parent: parts.length > 1 ? parts.slice(0, -1).join("::") : null, path: parts };
}

function deckOptions(config: Raw | false | undefined) {
  if (!config) return { available: false };
  const newOptions = (config.new ?? {}) as Raw;
  const reviewOptions = (config.rev ?? {}) as Raw;
  const lapseOptions = (config.lapse ?? {}) as Raw;
  return {
    available: true,
    preset: { id: numberValue(config.id), name: String(config.name ?? "") },
    limits: {
      newCardsPerDay: numberValue(newOptions.perDay),
      reviewsPerDay: numberValue(reviewOptions.perDay),
      source: "deck preset",
    },
    newCards: {
      learningStepsMinutes: Array.isArray(newOptions.delays) ? newOptions.delays.map(numberValue) : [],
      initialEaseFactor: numberValue(newOptions.initialFactor),
      order: numberValue(newOptions.order),
      burySiblings: Boolean(newOptions.bury),
    },
    reviews: {
      maximumIntervalDays: numberValue(reviewOptions.maxIvl),
      intervalModifier: numberValue(reviewOptions.ivlFct),
      hardInterval: numberValue(reviewOptions.hardFactor),
      easyBonus: numberValue(reviewOptions.ease4),
      burySiblings: Boolean(reviewOptions.bury),
    },
    lapses: {
      relearningStepsMinutes: Array.isArray(lapseOptions.delays) ? lapseOptions.delays.map(numberValue) : [],
      minimumIntervalDays: numberValue(lapseOptions.minInt),
      leechThreshold: numberValue(lapseOptions.leechFails),
    },
    fsrs: {
      desiredRetention: numberValue(config.desiredRetention),
      ignoreReviewsBefore: String(config.ignoreRevlogsBeforeDate ?? ""),
      search: String(config.weightSearch ?? ""),
    },
    maximumAnswerSeconds: numberValue(config.maxTaken),
  };
}

function deckDailyLimits(config: Raw | false | undefined, schedulerStats: Raw | undefined) {
  const newOptions = config ? (config.new ?? {}) as Raw : {};
  const reviewOptions = config ? (config.rev ?? {}) as Raw : {};
  const unavailableFromAnkiConnect = {
    provider: "AnkiConnect",
    available: false,
    reason: "AnkiConnect v6 does not expose this deck override value.",
  };
  return {
    preset: {
      available: Boolean(config),
      newCardsPerDay: config ? numberValue(newOptions.perDay) : null,
      reviewsPerDay: config ? numberValue(reviewOptions.perDay) : null,
      preset: config ? { id: numberValue(config.id), name: String(config.name ?? "") } : null,
      source: {
        provider: "AnkiConnect",
        action: "getDeckConfig",
        fields: ["new.perDay", "rev.perDay"],
        note: "Preset values shared by decks using this preset.",
      },
    },
    deckSpecific: {
      available: false,
      newCardsPerDay: null,
      reviewsPerDay: null,
      source: unavailableFromAnkiConnect,
    },
    todayOnly: {
      available: false,
      newCardsPerDay: null,
      reviewsPerDay: null,
      source: unavailableFromAnkiConnect,
    },
    effectiveAfterParentLimits: {
      limitsAvailable: false,
      newCardsPerDay: null,
      reviewsPerDay: null,
      availableCardsTodayAfterLimits: schedulerStats ? {
        new: numberValue(schedulerStats.new_count),
        learning: numberValue(schedulerStats.learn_count),
        review: numberValue(schedulerStats.review_count),
      } : null,
      source: {
        provider: "AnkiConnect",
        action: "getDeckStats",
        fields: ["new_count", "learn_count", "review_count"],
        note: "Counts currently available after scheduler limits; these are not the configured limit values.",
      },
    },
  };
}

async function getDeckLimitDetails(deckNames: string[]) {
  if (!deckNames.length) return [];
  const [deckNamesAndIds, configs, deckStats] = await Promise.all([
    invokeAnki<Record<string, number>>("deckNamesAndIds"),
    runMultiBatches<Raw | false>(
      deckNames.map((deck) => ({ action: "getDeckConfig", params: { deck } })),
      20,
    ),
    invokeAnki<Record<string, Raw>>("getDeckStats", { decks: deckNames }),
  ]);
  return deckNames.map((deckName, index) => ({
    deckName,
    dailyLimits: deckDailyLimits(
      configs[index],
      deckStats[String(deckNamesAndIds[deckName])] as Raw | undefined,
    ),
  }));
}

function fsrsDeckScope(deckNames: string[]) {
  const queries = deckNames.map(quoteDeck);
  return queries.length === 1 ? queries[0] : `(${queries.join(" OR ")})`;
}

async function getFsrsCardRanges(deckNames: string[]) {
  const scope = fsrsDeckScope(deckNames);
  try {
    const results = await runMultiBatches<number[]>([
      { action: "findCards", params: { query: `${scope} prop:s>=0` } },
      ...FSRS_BUCKETS.map((bucket) => ({
        action: "findCards",
        params: { query: `${scope} ${bucket.query}` },
      })),
    ], 20);
    const cardsWithMemoryState = new Set(results[0] ?? []);
    const idsByBucket = FSRS_BUCKETS.map((_, index) => new Set(results[index + 1] ?? []));
    return { cardsWithMemoryState, idsByBucket, available: true as const };
  } catch {
    return { cardsWithMemoryState: new Set<number>(), idsByBucket: [], available: false as const };
  }
}

async function getBurialCardStates(deckNames: string[]) {
  const scope = fsrsDeckScope(deckNames);
  try {
    const [buried, manually, byScheduler] = await runMultiBatches<number[]>([
      { action: "findCards", params: { query: `${scope} is:buried` } },
      { action: "findCards", params: { query: `${scope} is:buried-manually` } },
      { action: "findCards", params: { query: `${scope} is:buried-sibling` } },
    ], 20);
    return {
      available: true as const,
      buried: new Set(buried ?? []),
      manually: new Set(manually ?? []),
      byScheduler: new Set(byScheduler ?? []),
    };
  } catch {
    return {
      available: false as const,
      buried: new Set<number>(),
      manually: new Set<number>(),
      byScheduler: new Set<number>(),
    };
  }
}

function fsrsMetricRange(
  cardId: number,
  metric: (typeof FSRS_BUCKETS)[number]["metric"],
  idsByBucket: Set<number>[],
) {
  const index = FSRS_BUCKETS.findIndex((bucket, bucketIndex) => (
    bucket.metric === metric && idsByBucket[bucketIndex]?.has(cardId)
  ));
  if (index < 0) return null;
  const bucket = FSRS_BUCKETS[index];
  return {
    range: bucket.label,
    minimum: bucket.minimum,
    maximumExclusive: bucket.maximumExclusive,
    unit: bucket.unit,
  };
}

export async function buildAnkiOverview(onProgress?: ProgressReporter) {
  reportProgress(onProgress, "connect", "AnkiConnectへ接続しています", 1);
  await requestAnkiPermission();
  const generatedAt = new Date().toISOString();
  const deckNamesAndIds = await invokeAnki<Record<string, number>>("deckNamesAndIds");
  const deckNames = Object.keys(deckNamesAndIds);
  reportProgress(onProgress, "deck_queries", `デッキを検索しています（${deckNames.length}件）`, 5, 0, deckNames.length);
  const suffixes = [
    "",
    "is:new",
    "is:learn",
    "is:review",
    "is:suspended",
    "is:buried",
    "is:buried-manually",
    "is:buried-sibling",
    "is:due",
    "prop:due<=7 -is:new",
    "rated:90",
  ];
  const fsrsSuffixes = ["prop:s>=0", ...FSRS_BUCKETS.map((bucket) => bucket.query)];
  const actions: AnkiMultiAction[] = deckNames.flatMap((deckName) =>
    suffixes.map((suffix) => ({ action: "findCards", params: { query: `${quoteExactDeck(deckName)} ${suffix}`.trim() } })),
  );
  const queryResults = await runMultiBatches<number[]>(actions, 40, (completed, total) => {
    reportProgress(onProgress, "deck_queries", `デッキ別カード状態を取得しています（${completed}/${total}バッチ）`, 5 + (completed / total) * 20, completed, total);
  });
  let fsrsResults: number[][] | null = null;
  try {
    fsrsResults = await runMultiBatches<number[]>(
      deckNames.flatMap((deckName) =>
        fsrsSuffixes.map((suffix) => ({ action: "findCards", params: { query: `${quoteExactDeck(deckName)} ${suffix}` } })),
      ),
      40,
      (completed, total) => {
        reportProgress(onProgress, "fsrs", `FSRS分布を取得しています（${completed}/${total}バッチ）`, 25 + (completed / total) * 20, completed, total);
      },
    );
  } catch {
    fsrsResults = null;
  }
  reportProgress(onProgress, "deck_options", "デッキオプションを取得しています", 46);
  const [deckConfigs, deckStats] = await Promise.all([
    runMultiBatches<Raw | false>(
      deckNames.map((deck) => ({ action: "getDeckConfig", params: { deck } })),
      20,
      (completed, total) => reportProgress(onProgress, "deck_options", `デッキ設定を取得しています（${completed}/${total}バッチ）`, 46 + (completed / total) * 6, completed, total),
    ),
    invokeAnki<Record<string, Raw>>("getDeckStats", { decks: deckNames }),
  ]);
  const statsByName = new Map(
    deckNames.map((deckName) => [deckName, deckStats[String(deckNamesAndIds[deckName])] as Raw | undefined]),
  );
  const allCardIds = Array.from(new Set(deckNames.flatMap((_, index) => queryResults[index * suffixes.length] ?? [])));
  const reviewed90Ids = Array.from(new Set(deckNames.flatMap((_, index) => queryResults[index * suffixes.length + 10] ?? [])));
  const cards = await getCardsInfo(allCardIds, (completed, total) => {
    reportProgress(onProgress, "card_info", `カード情報を取得しています（${completed}/${total}バッチ）`, 52 + (completed / total) * 15, completed, total);
  });
  const reviewsByCard = await getReviews(reviewed90Ids, (completed, total) => {
    reportProgress(onProgress, "review_history", `レビュー履歴を取得しています（${completed}/${total}バッチ）`, 67 + (completed / total) * 23, completed, total);
  });
  const cardsByDeck = new Map<string, Raw[]>();
  for (const card of cards) {
    const deckName = String(card.deckName ?? "");
    cardsByDeck.set(deckName, [...(cardsByDeck.get(deckName) ?? []), card]);
  }

  const decks = deckNames.map((deckName, index) => {
    const offset = index * suffixes.length;
    const ids = queryResults[offset] ?? [];
    const reviews = ids.flatMap((id) => reviewsByCard[String(id)] ?? []);
    const reviews30 = recentReviews(reviews, 30);
    const reviews7 = recentReviews(reviews, 7);
    const reviews90 = recentReviews(reviews, 90);
    const deckCards = cardsByDeck.get(deckName) ?? [];
    const timestamps = reviews.map(reviewTimestamp).filter(Boolean);
    const fsrsOffset = index * fsrsSuffixes.length;
    const fsrsCount = (position: number) => fsrsResults?.[fsrsOffset + position]?.length ?? 0;
    const todayStats = statsByName.get(deckName);
    return {
      ...deckHierarchy(deckName),
      total: ids.length,
      new: (queryResults[offset + 1] ?? []).length,
      learning: (queryResults[offset + 2] ?? []).length,
      review: (queryResults[offset + 3] ?? []).length,
      suspended: (queryResults[offset + 4] ?? []).length,
      buried: {
        total: (queryResults[offset + 5] ?? []).length,
        manually: (queryResults[offset + 6] ?? []).length,
        byScheduler: (queryResults[offset + 7] ?? []).length,
      },
      due: { today: (queryResults[offset + 8] ?? []).length, next7Days: (queryResults[offset + 9] ?? []).length },
      reviews: {
        last7Days: reviews7.length,
        last30Days: reviews30.length,
        last90Days: reviews90.length,
      },
      activeDays30d: new Set(reviews30.map((review) => new Date(reviewTimestamp(review)).toLocaleDateString("en-CA"))).size,
      lastStudiedAt: isoOrNull(Math.max(0, ...timestamps)),
      againRate30d: rate(reviews30, 1),
      hardRate30d: rate(reviews30, 2),
      medianIntervalDays: median(deckCards.map((card) => numberValue(card.interval)).filter((value) => value >= 0)),
      matureCards: deckCards.filter((card) => numberValue(card.interval) >= 21).length,
      recordedReviewTime: {
        last7Days: recordedTime(reviews7),
        last30Days: recordedTime(reviews30),
        last90Days: recordedTime(reviews90),
      },
      dailyActivity90d: dailyActivity(reviews, 90, false),
      fsrs: {
        available: fsrsResults !== null,
        source: fsrsResults ? "Anki search properties" : null,
        cardsWithMemoryState: fsrsCount(0),
        stabilityDays: { under7: fsrsCount(1), from7ToUnder21: fsrsCount(2), from21ToUnder90: fsrsCount(3), atLeast90: fsrsCount(4) },
        difficulty: { under0_3: fsrsCount(5), from0_3ToUnder0_7: fsrsCount(6), atLeast0_7: fsrsCount(7) },
        retrievability: { under0_7: fsrsCount(8), from0_7ToUnder0_9: fsrsCount(9), atLeast0_9: fsrsCount(10) },
      },
      options: deckOptions(deckConfigs[index]),
      dailyLimits: deckDailyLimits(deckConfigs[index], todayStats),
      todayAfterLimits: todayStats
        ? {
            new: numberValue(todayStats.new_count),
            learning: numberValue(todayStats.learn_count),
            review: numberValue(todayStats.review_count),
            note: "Anki scheduler count after limits; temporary daily overrides are not exposed separately by getDeckConfig.",
          }
        : null,
    };
  });

  const total = (key: "total" | "new" | "learning" | "review" | "suspended" | "matureCards") => decks.reduce((sum, deck) => sum + deck[key], 0);
  const allReviews = Object.values(reviewsByCard).flat();
  reportProgress(onProgress, "assemble", "JSONを組み立てています", 95);
  const output = {
    schemaVersion: SCHEMA_VERSION,
    analysisMode: "overview" as const,
    generatedAt,
    summary: {
      totalDecks: decks.length,
      totalCards: total("total"),
      new: total("new"),
      learning: total("learning"),
      review: total("review"),
      suspended: total("suspended"),
      buried: {
        total: decks.reduce((sum, deck) => sum + deck.buried.total, 0),
        manually: decks.reduce((sum, deck) => sum + deck.buried.manually, 0),
        byScheduler: decks.reduce((sum, deck) => sum + deck.buried.byScheduler, 0),
      },
      matureCards: total("matureCards"),
      dueToday: decks.reduce((sum, deck) => sum + deck.due.today, 0),
      dueNext7Days: decks.reduce((sum, deck) => sum + deck.due.next7Days, 0),
      recordedReviewTime: {
        last7Days: recordedTime(recentReviews(allReviews, 7)),
        last30Days: recordedTime(recentReviews(allReviews, 30)),
        last90Days: recordedTime(recentReviews(allReviews, 90)),
      },
      fsrsAvailable: fsrsResults !== null,
    },
    dailyActivity90d: dailyActivity(allReviews, 90, true),
    decks,
  };
  reportProgress(onProgress, "complete", "JSONの準備が完了しました", 100, 1, 1);
  return output;
}

function noteFields(note: Raw | undefined) {
  const fields = (note?.fields ?? {}) as Record<string, { value?: unknown; order?: unknown }>;
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { value: String(field.value ?? ""), order: numberValue(field.order) }]));
}

export function classifyAnkiCardState(queueValue: unknown) {
  const queue = numberValue(queueValue);
  if (queue === -1) return "suspended";
  if (queue === -2 || queue === -3) return "buried";
  if (queue === 0) return "new";
  if (queue === 1 || queue === 3) return "learning";
  if (queue === 2 || queue === 4) return "review";
  return "other";
}

function cardState(card: Raw) {
  return classifyAnkiCardState(card.queue);
}

function burialInfo(
  cardId: number,
  queueValue: unknown,
  states: Awaited<ReturnType<typeof getBurialCardStates>>,
) {
  const queue = numberValue(queueValue);
  const isBuried = queue === -2 || queue === -3 || states.buried.has(cardId);
  const type = !isBuried
    ? null
    : states.manually.has(cardId)
      ? "manual" as const
      : states.byScheduler.has(cardId)
        ? "scheduler" as const
        : null;
  return {
    isBuried,
    type,
    source: {
      provider: "AnkiConnect",
      action: "findCards",
      queries: ["is:buried", "is:buried-manually", "is:buried-sibling"],
    },
    warning: isBuried && type === null
      ? "The card is buried, but this Anki version did not expose whether it was manual or scheduler burying."
      : null,
  };
}

interface TemplateFormats {
  Front?: string;
  Back?: string;
}

export interface AnkiTemplateDefinition {
  name: string;
  ord: number;
  front?: string;
  back?: string;
}

export function normalizeAnkiModelTemplates(templates: Record<string, TemplateFormats>): AnkiTemplateDefinition[] {
  return Object.entries(templates).map(([name, formats], ord) => ({
    name,
    ord,
    front: formats.Front,
    back: formats.Back,
  }));
}

export function resolveAnkiCardTemplate(cardOrd: number, templates: AnkiTemplateDefinition[]) {
  const template = templates.find((candidate) => candidate.ord === cardOrd) ?? null;
  return {
    template,
    warning: template ? null : `card ord ${cardOrd} に対応するテンプレートがありません。`,
  };
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

function renderedText(html: unknown) {
  return decodeHtmlEntities(String(html ?? ""))
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function audioReferences(...values: unknown[]) {
  const references = new Set<string>();
  for (const value of values) {
    for (const match of String(value ?? "").matchAll(/\[(?:sound:[^\]]+|anki:play:[^\]]+)\]/gi)) {
      references.add(match[0]);
    }
  }
  return Array.from(references);
}

function referencedFieldValues(note: Raw | undefined, fieldNames: string[]) {
  const fields = (note?.fields ?? {}) as Record<string, { value?: unknown }>;
  return fieldNames.map((name) => fields[name]?.value ?? "");
}

export function extractAnkiTemplateFieldNames(format: string | undefined) {
  const names = new Set<string>();
  for (const match of format?.matchAll(/{{{?([^{}]+)}}}?/g) ?? []) {
    let expression = match[1]?.trim() ?? "";
    if (!expression || expression.startsWith("!") || expression.startsWith("=")) continue;
    expression = expression.replace(/^[#\/^&]\s*/, "").trim();
    const filterSeparator = expression.lastIndexOf(":");
    const name = (filterSeparator >= 0 ? expression.slice(filterSeparator + 1) : expression)
      .replace(/^[{}]+|[{}]+$/g, "")
      .trim();
    if (name && name !== "FrontSide") names.add(name);
  }
  return Array.from(names);
}

export async function buildGoalAnkiDetail(goal: Goal, onProgress?: ProgressReporter) {
  reportProgress(onProgress, "connect", "AnkiConnectへ接続しています", 1);
  await requestAnkiPermission();
  const deckNames = goal.ankiDeckNames ?? [];
  if (!deckNames.length) throw new Error("この目標にAnkiデッキが紐付けられていません。");
  const cardIdGroups = await runMultiBatches<number[]>(deckNames.map((deckName) => ({ action: "findCards", params: { query: quoteDeck(deckName) } })), 20);
  const cardIds = Array.from(new Set(cardIdGroups.flat()));
  reportProgress(onProgress, "card_info", `カード情報を取得しています（${cardIds.length.toLocaleString()}件）`, 10, 0, cardIds.length);
  const cards = await getCardsInfo(cardIds, (completed, total) => {
    reportProgress(onProgress, "card_info", `カード情報を取得しています（${completed}/${total}バッチ）`, 10 + (completed / total) * 20, completed, total);
  });
  const noteIds = Array.from(new Set(cards.map((card) => numberValue(card.note)).filter(Boolean)));
  const modelNames = Array.from(new Set(cards.map((card) => String(card.modelName ?? "")).filter(Boolean)));
  const noteChunks = await runMultiBatches<Raw[]>(
    chunks(noteIds).map((notes) => ({ action: "notesInfo", params: { notes } })),
    10,
    (completed, total) => reportProgress(onProgress, "notes", `ノート情報を取得しています（${completed}/${total}バッチ）`, 30 + (completed / total) * 15, completed, total),
  );
  const intervalChunks = await runMultiBatches<number[][]>(
    chunks(cardIds).map((cards) => ({ action: "getIntervals", params: { cards, complete: true } })),
    10,
    (completed, total) => reportProgress(onProgress, "intervals", `間隔履歴を取得しています（${completed}/${total}バッチ）`, 45 + (completed / total) * 15, completed, total),
  );
  const reviewsByCard = await getReviews(cardIds, (completed, total) => {
    reportProgress(onProgress, "review_history", `レビュー履歴を取得しています（${completed}/${total}バッチ）`, 60 + (completed / total) * 25, completed, total);
  });
  const modelTemplateResults = await runMultiBatches<Record<string, TemplateFormats>>(
    modelNames.map((modelName) => ({ action: "modelTemplates", params: { modelName } })),
    10,
    (completed, total) => reportProgress(onProgress, "templates", `テンプレート情報を取得しています（${completed}/${total}バッチ）`, 85 + (completed / total) * 8, completed, total),
  );
  reportProgress(onProgress, "deck_limits_fsrs", "デッキ上限・FSRS・buried状態を確認しています", 93);
  const [deckLimits, fsrsRanges, burialStates] = await Promise.all([
    getDeckLimitDetails(deckNames),
    getFsrsCardRanges(deckNames),
    getBurialCardStates(deckNames),
  ]);
  const notes = noteChunks.flat();
  const notesById = new Map(notes.map((note) => [numberValue(note.noteId), note]));
  const templatesByModel = new Map(
    modelNames.map((modelName, index) => [modelName, normalizeAnkiModelTemplates(modelTemplateResults[index] ?? {})]),
  );
  const intervals = intervalChunks.flat();
  const intervalsByCardId = new Map(cardIds.map((cardId, index) => [cardId, intervals[index] ?? []]));
  const details = cards.map((card) => {
    const cardId = numberValue(card.cardId);
    const noteId = numberValue(card.note);
    const note = notesById.get(noteId);
    const reviews = reviewsByCard[String(cardId)] ?? [];
    const reviews30 = recentReviews(reviews, 30);
    const reviews90 = recentReviews(reviews, 90);
    const againCount = reviews.filter((review) => numberValue(review.ease) === 1).length;
    const hardCount = reviews.filter((review) => numberValue(review.ease) === 2).length;
    const lapseCount = numberValue(card.lapses);
    const weaknessScore = Math.round(Math.min(100, lapseCount * 12 + (reviews.length ? (againCount / reviews.length) * 55 : 0) + (numberValue(card.interval) < 7 && cardState(card) !== "new" ? 15 : 0)));
    const modelName = String(card.modelName ?? "");
    const cardOrd = numberValue(card.ord);
    const { template: matchedTemplate, warning: templateWarning } = resolveAnkiCardTemplate(
      cardOrd,
      templatesByModel.get(modelName) ?? [],
    );
    const frontFieldNames = extractAnkiTemplateFieldNames(matchedTemplate?.front);
    const backFieldNames = extractAnkiTemplateFieldNames(matchedTemplate?.back);
    const questionAudioReferences = audioReferences(
      card.question,
      ...referencedFieldValues(note, frontFieldNames),
    );
    const answerAudioReferences = audioReferences(
      card.answer,
      ...referencedFieldValues(note, backFieldNames),
    );
    const answerOnlyAudioReferences = answerAudioReferences.filter(
      (reference) => !questionAudioReferences.includes(reference),
    );
    const hasFsrsMemoryState = fsrsRanges.available && fsrsRanges.cardsWithMemoryState.has(cardId);
    return {
      cardId,
      cardOrd,
      noteId,
      deckName: String(card.deckName ?? ""),
      modelName,
      template: matchedTemplate ? {
        name: matchedTemplate.name,
        nameRole: "author_defined_label",
        ord: matchedTemplate.ord,
        frontSide: { fieldNames: frontFieldNames },
        backSide: { fieldNames: backFieldNames },
      } : null,
      templateWarning,
      questionText: renderedText(card.question),
      answerText: renderedText(card.answer),
      audio: {
        question: { hasAudio: questionAudioReferences.length > 0, references: questionAudioReferences },
        answer: { hasAudio: answerAudioReferences.length > 0, references: answerAudioReferences },
      },
      directionEvidence: {
        cardTypeKey: `${modelName}::ord:${cardOrd}`,
        source: "cardOrd_and_rendered_card_sides",
        questionSide: {
          fieldNames: frontFieldNames,
          hasAudio: questionAudioReferences.length > 0,
        },
        answerSide: {
          fieldNames: backFieldNames,
          hasAudio: answerAudioReferences.length > 0,
          answerOnlyAudioReferences,
        },
        renderedTextFields: { question: "questionText", answer: "answerText" },
        warning: "Template names are author-defined labels. Determine the actual problem direction from cardOrd, questionText, answerText, fields, and audio evidence instead of the template name alone.",
      },
      fsrs: {
        available: hasFsrsMemoryState,
        exactValueAvailable: false,
        stability: hasFsrsMemoryState ? fsrsMetricRange(cardId, "stability", fsrsRanges.idsByBucket) : null,
        difficulty: hasFsrsMemoryState ? fsrsMetricRange(cardId, "difficulty", fsrsRanges.idsByBucket) : null,
        retrievability: hasFsrsMemoryState ? fsrsMetricRange(cardId, "retrievability", fsrsRanges.idsByBucket) : null,
        source: {
          provider: "AnkiConnect",
          action: "findCards",
          searchProperties: ["prop:s", "prop:d", "prop:r"],
          note: "Range classification from Anki search properties; cardsInfo does not expose exact FSRS values. Difficulty uses Anki's normalized 0-to-1 search scale.",
        },
        unavailableReason: hasFsrsMemoryState
          ? null
          : fsrsRanges.available
            ? "This card has no searchable FSRS memory state."
            : "FSRS search properties are unavailable in this Anki version or scheduler.",
      },
      tags: Array.isArray(note?.tags) ? note.tags.map(String) : [],
      fields: noteFields(note),
      state: cardState(card),
      burial: burialInfo(cardId, card.queue, burialStates),
      queue: numberValue(card.queue),
      type: numberValue(card.type),
      due: numberValue(card.due),
      intervalDays: numberValue(card.interval),
      easeFactor: numberValue(card.factor),
      repetitions: numberValue(card.reps),
      lapses: lapseCount,
      mod: numberValue(card.mod),
      intervalHistory: intervalsByCardId.get(cardId) ?? [],
      recordedReviewTime: {
        allTime: recordedTime(reviews),
        last30Days: recordedTime(reviews30),
        last90Days: recordedTime(reviews90),
      },
      weakness: {
        reviewCount: reviews.length,
        againCount,
        hardCount,
        againRate: rate(reviews, 1),
        hardRate: rate(reviews, 2),
        allTime: reviewMetrics(reviews),
        last30Days: reviewMetrics(reviews30),
        last90Days: reviewMetrics(reviews90),
        weaknessScore,
      },
    };
  });
  reportProgress(onProgress, "assemble", "詳細JSONを組み立てています", 96);
  const output = {
    schemaVersion: SCHEMA_VERSION,
    analysisMode: "goal" as const,
    generatedAt: new Date().toISOString(),
    goal: { id: goal.id, title: goal.title, examDate: goal.examDate ?? null, ankiDeckNames: deckNames },
    summary: {
      totalCards: details.length,
      notes: noteIds.length,
      weakCards: details.filter((card) => card.weakness.weaknessScore >= 50).length,
      templateWarnings: details.filter((card) => card.template === null).length,
      fsrsCardsWithMemoryState: details.filter((card) => card.fsrs.available).length,
    },
    deckLimits,
    cards: details,
  };
  reportProgress(onProgress, "complete", "JSONの準備が完了しました", 100, 1, 1);
  return output;
}

export async function buildDeckAnkiDetail(deckNamesInput: string | string[], onProgress?: ProgressReporter) {
  const deckNames = [...new Set(Array.isArray(deckNamesInput) ? deckNamesInput : [deckNamesInput])]
    .map((name) => name.trim())
    .filter(Boolean);
  if (!deckNames.length) throw new Error("分析するデッキを1件以上選択してください。");
  const detail = await buildGoalAnkiDetail({
    id: `deck:${deckNames.join("|")}`,
    title: deckNames.join(" / "),
    subtitle: "",
    status: "active",
    readiness: 0,
    targetXp: 0,
    xp: 0,
    skillIds: [],
    collectionIds: [],
    ankiDeckNames: deckNames,
  }, onProgress);
  const { goal: _goal, ...withoutGoal } = detail;
  return {
    ...withoutGoal,
    analysisMode: "deck" as const,
    deckNames,
    ...(deckNames.length === 1 ? { deck: { name: deckNames[0] } } : {}),
  };
}

export type AnkiAnalysisRequest =
  | { analysisMode: "overview" }
  | { analysisMode: "goal"; goal: Goal }
  | { analysisMode: "deck"; deckName: string }
  | { analysisMode: "deck"; deckNames: string[] };

export function buildAnkiAnalysis(request: AnkiAnalysisRequest, onProgress?: ProgressReporter) {
  if (request.analysisMode === "overview") return buildAnkiOverview(onProgress);
  if (request.analysisMode === "goal") return buildGoalAnkiDetail(request.goal, onProgress);
  return buildDeckAnkiDetail("deckNames" in request ? request.deckNames : request.deckName, onProgress);
}

export function downloadAnalysisJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
