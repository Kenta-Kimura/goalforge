import type { AnkiCardSummary, AnkiNoteSummary, AnkiReviewEntry, AnkiSyncData } from "../types";

const ANKI_CONNECT_URL = "http://127.0.0.1:8765";

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

async function invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ANKI_CONNECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect HTTP ${response.status}`);
  }

  const payload = (await response.json()) as AnkiResponse<T>;
  if (payload.error) {
    throw new Error(payload.error);
  }

  return payload.result;
}

function chooseTargetDeck(deckNames: string[]) {
  return (
    deckNames.find((name) => /中検|中国語|chuken|chinese/i.test(name)) ??
    deckNames[0]
  );
}

function toCardSummary(card: Record<string, unknown>): AnkiCardSummary {
  return {
    cardId: Number(card.cardId ?? card.cardId ?? 0),
    deckName: String(card.deckName ?? ""),
    queue: Number(card.queue ?? 0),
    type: Number(card.type ?? 0),
    interval: Number(card.interval ?? 0),
    due: Number(card.due ?? 0),
  };
}

function toNoteSummary(note: Record<string, unknown>): AnkiNoteSummary {
  const fields = note.fields as Record<string, { value?: string }> | undefined;
  const normalizedFields = Object.fromEntries(
    Object.entries(fields ?? {}).map(([key, value]) => [key, value.value ?? ""]),
  );

  return {
    noteId: Number(note.noteId ?? 0),
    tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
    fields: normalizedFields,
  };
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function getReviewHistories(cardIds: number[]) {
  const histories: Record<string, unknown[]> = {};

  for (const cardChunk of chunks(cardIds, 500)) {
    const chunkHistories = await invoke<Record<string, unknown[]>>("getReviewsOfCards", {
      cards: cardChunk,
    });
    Object.assign(histories, chunkHistories);
  }

  return histories;
}

export async function syncAnki(): Promise<AnkiSyncData> {
  const deckNames = await invoke<string[]>("deckNames");
  const targetDeckName = chooseTargetDeck(deckNames);
  const deckQuery = targetDeckName ? `deck:"${targetDeckName.replaceAll('"', '\\"')}"` : "";
  const targetCardIds = targetDeckName
    ? await invoke<number[]>("findCards", { query: deckQuery })
    : [];
  const targetReviewCardIds = targetDeckName
    ? await invoke<number[]>("findCards", { query: `${deckQuery} rated:1` })
    : [];
  const targetNewCardIds = targetDeckName
    ? await invoke<number[]>("findCards", { query: `${deckQuery} added:1` })
    : [];
  const cardSampleIds = targetCardIds.slice(0, 40);
  const cardInfo = cardSampleIds.length
    ? await invoke<Record<string, unknown>[]>("cardsInfo", { cards: cardSampleIds })
    : [];
  const noteIds = Array.from(
    new Set(
      cardInfo
        .map((card) => Number(card.note))
        .filter((noteId) => Number.isFinite(noteId) && noteId > 0),
    ),
  ).slice(0, 40);
  const notesInfo = noteIds.length
    ? await invoke<Record<string, unknown>[]>("notesInfo", { notes: noteIds })
    : [];
  const tags = await invoke<string[]>("getTags");
  let reviewHistory: AnkiReviewEntry[] = [];
  let totalReviewCount = 0;
  let totalLearnedCardCount = 0;

  try {
    const histories = await getReviewHistories(targetCardIds);
    const entries = Object.entries(histories);
    totalReviewCount = entries.reduce((sum, [, reviews]) => sum + reviews.length, 0);
    totalLearnedCardCount = entries.filter(([, reviews]) => reviews.length > 0).length;
    reviewHistory = Object.entries(histories).map(([cardId, reviews]) => ({
      cardId: Number(cardId),
      reviews,
    })).slice(0, 30);
  } catch {
    reviewHistory = [];
  }

  return {
    deckNames,
    targetDeckName,
    targetDeckCardCount: targetCardIds.length,
    totalReviewCount,
    totalLearnedCardCount,
    todayReviewCount: targetReviewCardIds.length,
    todayNewCount: targetNewCardIds.length,
    cardSample: cardInfo.map(toCardSummary),
    noteSample: notesInfo.map(toNoteSummary),
    tags,
    reviewHistory,
    syncedAt: new Date().toISOString(),
  };
}
