import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeckAnkiDetail,
  buildGoalAnkiDetail,
  buildAnkiOverview,
  classifyAnkiCardState,
  extractAnkiTemplateFieldNames,
  normalizeAnkiModelTemplates,
  resolveAnkiCardTemplate,
} from "../src/lib/ankiAnalysis";
import type { Goal } from "../src/types";

const deckConfig = {
  id: 7,
  name: "学習用",
  new: { perDay: 15 },
  rev: { perDay: 150 },
  lapse: {},
};

test("目標詳細JSONは元fieldsを保持し、レンダリング済み本文を除外する", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      action: string;
      params: { actions?: Array<{ action: string; params?: Record<string, unknown> }> };
    };
    if (body.action === "requestPermission") {
      return new Response(JSON.stringify({ result: { permission: "granted", requireApikey: false, version: 6 }, error: null }), { status: 200 });
    }
    if (body.action === "deckNamesAndIds") {
      return new Response(JSON.stringify({ result: { "中国語::2級": 12, "中国語::3級": 13 }, error: null }));
    }
    if (body.action === "getDeckStats") {
      return new Response(JSON.stringify({ result: {
        "12": { new_count: 4, learn_count: 2, review_count: 30 },
        "13": { new_count: 3, learn_count: 1, review_count: 20 },
      }, error: null }));
    }
    assert.equal(body.action, "multi");
    const results = (body.params.actions ?? []).map(({ action, params }) => {
      if (action === "findCards") {
        const query = String(params?.query ?? "");
        if (!query.includes("prop:")) return [101];
        if (query.includes("prop:s>=0")) return [101];
        if (query.includes("prop:s>=7 prop:s<21")) return [101];
        if (query.includes("prop:d>=0.3 prop:d<0.7")) return [101];
        if (query.includes("prop:r>=0.9")) return [101];
        return [];
      }
      if (action === "cardsInfo") {
        return [{
            cardId: 101,
            note: 201,
            deckName: "中国語::2級",
            modelName: "Basic",
            queue: 2,
            type: 2,
            interval: 30,
            factor: 2500,
            reps: 8,
            lapses: 1,
            ord: 0,
            question: "<style>.card{color:red}</style><b>你好</b> [anki:play:q:0]",
            answer: "<b>你好</b><hr id=answer>こんにちは",
            css: "含めないCSS",
          }];
      }
      if (action === "notesInfo") {
        return [{ noteId: 201, tags: ["grammar"], fields: { 表面: { value: "你好", order: 0 }, 裏面: { value: "こんにちは", order: 1 } } }];
      }
      if (action === "modelTemplates") {
        return { "中国語 → 日本語": { Front: "{{表面}}", Back: "{{FrontSide}}<hr>{{裏面}}" } };
      }
      if (action === "getIntervals") return [[1, 3, 30]];
      if (action === "getReviewsOfCards") return { "101": [{ id: Date.now(), ease: 1 }] };
      if (action === "getDeckConfig") return deckConfig;
      throw new Error(`unexpected action: ${action}`);
    });
    return new Response(JSON.stringify({ result: results, error: null }), { status: 200 });
  }) as typeof fetch;

  const goal: Goal = {
    id: "goal-1",
    title: "中国語検定2級",
    status: "active",
    readiness: 0,
    targetXp: 100,
    xp: 0,
    skillIds: [],
    collectionIds: [],
    ankiDeckNames: ["中国語::2級"],
  };

  try {
    const progress: number[] = [];
    const output = await buildGoalAnkiDetail(goal, (update) => progress.push(update.percent));
    assert.equal(output.schemaVersion, "1.5.0");
    assert.equal(output.analysisMode, "goal");
    assert.deepEqual(output.cards[0].fields, {
      表面: { value: "你好", order: 0 },
      裏面: { value: "こんにちは", order: 1 },
    });
    assert.deepEqual(output.cards[0].intervalHistory, [1, 3, 30]);
    assert.deepEqual(output.cards[0].template, {
      name: "中国語 → 日本語",
      nameRole: "author_defined_label",
      ord: 0,
      frontSide: { fieldNames: ["表面"] },
      backSide: { fieldNames: ["裏面"] },
    });
    assert.equal(output.cards[0].cardOrd, 0);
    assert.equal(output.cards[0].templateWarning, null);
    assert.equal(output.cards[0].questionText, "你好 [anki:play:q:0]");
    assert.equal(output.cards[0].answerText, "你好\nこんにちは");
    assert.deepEqual(output.cards[0].audio.question, {
      hasAudio: true,
      references: ["[anki:play:q:0]"],
    });
    assert.deepEqual(output.cards[0].fsrs.stability, {
      range: "from7ToUnder21",
      minimum: 7,
      maximumExclusive: 21,
      unit: "days",
    });
    assert.equal(output.cards[0].fsrs.difficulty?.range, "from0_3ToUnder0_7");
    assert.equal(output.cards[0].fsrs.difficulty?.unit, "normalized_0_to_1");
    assert.equal(output.cards[0].fsrs.retrievability?.range, "atLeast0_9");
    assert.equal(output.cards[0].fsrs.exactValueAvailable, false);
    assert.deepEqual(output.cards[0].directionEvidence, {
      cardTypeKey: "Basic::ord:0",
      source: "cardOrd_and_rendered_card_sides",
      questionSide: { fieldNames: ["表面"], hasAudio: true },
      answerSide: { fieldNames: ["裏面"], hasAudio: false, answerOnlyAudioReferences: [] },
      renderedTextFields: { question: "questionText", answer: "answerText" },
      warning: "Template names are author-defined labels. Determine the actual problem direction from cardOrd, questionText, answerText, fields, and audio evidence instead of the template name alone.",
    });
    assert.deepEqual(output.deckLimits[0].dailyLimits.preset, {
      available: true,
      newCardsPerDay: 15,
      reviewsPerDay: 150,
      preset: { id: 7, name: "学習用" },
      source: {
        provider: "AnkiConnect",
        action: "getDeckConfig",
        fields: ["new.perDay", "rev.perDay"],
        note: "Preset values shared by decks using this preset.",
      },
    });
    assert.equal(output.deckLimits[0].dailyLimits.deckSpecific.available, false);
    assert.equal(output.deckLimits[0].dailyLimits.todayOnly.newCardsPerDay, null);
    assert.deepEqual(
      output.deckLimits[0].dailyLimits.effectiveAfterParentLimits.availableCardsTodayAfterLimits,
      { new: 4, learning: 2, review: 30 },
    );
    assert.equal(output.cards[0].weakness.againCount, 1);
    assert.equal(output.cards[0].weakness.last30Days.againRate, 1);
    assert.equal(output.cards[0].weakness.last90Days.hardRate, 0);
    assert.equal(output.cards[0].recordedReviewTime.last30Days.reviewCount, 1);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.some((percent) => percent > 0 && percent < 100));
    assert.doesNotMatch(JSON.stringify(output), /<style>|<b>|含めないCSS/);

    const deckOutput = await buildDeckAnkiDetail("中国語::2級");
    assert.equal(deckOutput.analysisMode, "deck");
    assert.deepEqual(deckOutput.deck, { name: "中国語::2級" });
    assert.deepEqual(deckOutput.deckNames, ["中国語::2級"]);
    assert.ok(!("goal" in deckOutput));
    assert.equal(deckOutput.cards.length, 1);

    const multipleDeckOutput = await buildDeckAnkiDetail(["中国語::2級", "中国語::3級"]);
    assert.equal(multipleDeckOutput.analysisMode, "deck");
    assert.deepEqual(multipleDeckOutput.deckNames, ["中国語::2級", "中国語::3級"]);
    assert.ok(!("deck" in multipleDeckOutput));
    assert.ok(!("goal" in multipleDeckOutput));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue -2/-3をburiedとして分類し、未知queueだけをotherにする", () => {
  assert.equal(classifyAnkiCardState(-2), "buried");
  assert.equal(classifyAnkiCardState(-3), "buried");
  assert.equal(classifyAnkiCardState(-1), "suspended");
  assert.equal(classifyAnkiCardState(99), "other");
});

test("全デッキ分析でburiedを手動とスケジューラ由来に分けて集計する", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      action: string;
      params: { actions?: Array<{ action: string; params?: Record<string, unknown> }> };
    };
    if (body.action === "requestPermission") {
      return new Response(JSON.stringify({ result: { permission: "granted", requireApikey: false, version: 6 }, error: null }));
    }
    if (body.action === "deckNamesAndIds") {
      return new Response(JSON.stringify({ result: { Deck: 1 }, error: null }));
    }
    if (body.action === "getDeckStats") {
      return new Response(JSON.stringify({ result: { "1": { new_count: 1, learn_count: 0, review_count: 0 } }, error: null }));
    }
    assert.equal(body.action, "multi");
    const results = (body.params.actions ?? []).map(({ action, params }) => {
      if (action === "findCards") {
        const query = String(params?.query ?? "");
        if (query.includes("is:buried-manually")) return [2];
        if (query.includes("is:buried-sibling")) return [3];
        if (query.includes("is:buried")) return [2, 3];
        if (query.includes("is:new")) return [1];
        if (query.includes("is:review")) return [2, 3];
        if (query.includes("prop:") || query.includes("rated:") || query.includes("is:")) return [];
        return [1, 2, 3];
      }
      if (action === "cardsInfo") {
        return [
          { cardId: 1, deckName: "Deck", queue: 0, type: 0, interval: 0 },
          { cardId: 2, deckName: "Deck", queue: -2, type: 2, interval: 10 },
          { cardId: 3, deckName: "Deck", queue: -3, type: 2, interval: 20 },
        ];
      }
      if (action === "getDeckConfig") return deckConfig;
      throw new Error(`unexpected action: ${action}`);
    });
    return new Response(JSON.stringify({ result: results, error: null }));
  }) as typeof fetch;

  try {
    const output = await buildAnkiOverview();
    assert.deepEqual(output.summary.buried, { total: 2, manually: 1, byScheduler: 1 });
    assert.deepEqual(output.decks[0].buried, { total: 2, manually: 1, byScheduler: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("カードordを明示ord付きテンプレートへ対応させ、配列順や条件付き生成でずらさない", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      action: string;
      params: { actions?: Array<{ action: string; params?: Record<string, unknown> }> };
    };
    if (body.action === "requestPermission") {
      return new Response(JSON.stringify({ result: { permission: "granted", requireApikey: false, version: 6 }, error: null }));
    }
    if (body.action === "deckNamesAndIds") {
      return new Response(JSON.stringify({ result: { "ドイツ語🇩🇪": 99 }, error: null }));
    }
    if (body.action === "getDeckStats") {
      return new Response(JSON.stringify({ result: { "99": { new_count: 0, learn_count: 0, review_count: 10 } }, error: null }));
    }
    const results = (body.params.actions ?? []).map(({ action, params }) => {
      if (action === "findCards") {
        const query = String(params?.query ?? "");
        if (query.includes("is:buried-manually")) return [];
        if (query.includes("is:buried-sibling")) return [400];
        if (query.includes("is:buried")) return [400];
        if (!query.includes("prop:")) return [400, 200];
        if (query.includes("prop:s>=0")) return [400, 200];
        if (query.includes("prop:s<7")) return [200];
        if (query.includes("prop:s>=21 prop:s<90")) return [400];
        if (query.includes("prop:d>=0.3 prop:d<0.7")) return [400];
        if (query.includes("prop:d>=0.7")) return [200];
        if (query.includes("prop:r<0.7")) return [200];
        if (query.includes("prop:r>=0.9")) return [400];
        return [];
      }
      if (action === "cardsInfo") {
        return [
          {
            cardId: 200,
            note: 20,
            deckName: "ドイツ語🇩🇪",
            modelName: "文字",
            ord: 1,
            queue: 2,
            type: 2,
            interval: 2,
            factor: 1300,
            reps: 168,
            lapses: 56,
            question: "この音の文字は？<br>[anki:play:q:0]",
            answer: "この音の文字は？<hr>Ö ö",
          },
          {
            cardId: 400,
            note: 40,
            deckName: "ドイツ語🇩🇪",
            modelName: "文字",
            ord: 3,
            queue: -2,
            type: 2,
            interval: 40,
            factor: 2500,
            reps: 7,
            lapses: 1,
            question: "小文字から大文字",
            answer: "ä → Ä",
          },
        ];
      }
      if (action === "notesInfo") {
        return [
          { noteId: 20, tags: ["umlaut"], fields: { 文字: { value: "Ö ö", order: 0 }, 音声: { value: "[sound:o-umlaut.mp3]", order: 1 } } },
          { noteId: 40, tags: [], fields: { 文字: { value: "Ä ä", order: 0 }, 条件: { value: "y", order: 1 } } },
        ];
      }
      if (action === "modelTemplates") {
        return {
          "文字タイプ1　この文字はどんな音？": { Front: "{{文字}}", Back: "{{FrontSide}} {{音声}}" },
          "文字タイプ2　この音の文字は？": { Front: "{{音声}}", Back: "{{FrontSide}} {{文字}}" },
          "文字タイプ3　条件付き小文字": { Front: "{{#条件}}{{文字}}{{/条件}}", Back: "小文字" },
          "文字カード4　条件付き大文字": { Front: "{{#条件}}{{文字}}{{/条件}}", Back: "大文字" },
        };
      }
      if (action === "getIntervals") return [[40], [20]];
      if (action === "getReviewsOfCards") return { "200": [{ id: Date.now(), ease: 1 }], "400": [] };
      if (action === "getDeckConfig") return deckConfig;
      throw new Error(`unexpected action: ${action}`);
    });
    return new Response(JSON.stringify({ result: results, error: null }));
  }) as typeof fetch;

  try {
    const output = await buildDeckAnkiDetail("ドイツ語🇩🇪");
    const audioToText = output.cards.find((card) => card.cardId === 200);
    const conditionalFourth = output.cards.find((card) => card.cardId === 400);
    assert.ok(audioToText);
    assert.equal(audioToText.cardOrd, 1);
    assert.equal(audioToText.template?.ord, 1);
    assert.equal(audioToText.template?.name, "文字タイプ2　この音の文字は？");
    assert.equal(audioToText.lapses, 56);
    assert.equal(audioToText.repetitions, 168);
    assert.equal(audioToText.intervalDays, 2);
    assert.deepEqual(audioToText.intervalHistory, [20]);
    assert.equal(audioToText.audio.question.hasAudio, true);
    assert.deepEqual(audioToText.audio.question.references, ["[anki:play:q:0]", "[sound:o-umlaut.mp3]"]);
    assert.equal(audioToText.fsrs.stability?.range, "under7");
    assert.equal(audioToText.fsrs.difficulty?.range, "atLeast0_7");
    assert.equal(audioToText.fsrs.retrievability?.range, "under0_7");

    assert.ok(conditionalFourth);
    assert.equal(conditionalFourth.cardOrd, 3);
    assert.equal(conditionalFourth.template?.ord, 3);
    assert.equal(conditionalFourth.template?.name, "文字カード4　条件付き大文字");
    assert.equal(conditionalFourth.lapses, 1);
    assert.equal(conditionalFourth.repetitions, 7);
    assert.equal(conditionalFourth.intervalDays, 40);
    assert.deepEqual(conditionalFourth.intervalHistory, [40]);
    assert.equal(conditionalFourth.fsrs.stability?.range, "from21ToUnder90");
    assert.equal(conditionalFourth.state, "buried");
    assert.deepEqual(conditionalFourth.burial, {
      isBuried: true,
      type: "scheduler",
      source: {
        provider: "AnkiConnect",
        action: "findCards",
        queries: ["is:buried", "is:buried-manually", "is:buried-sibling"],
      },
      warning: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ord 0〜3を順番どおり解決し、存在しないordは警告付きで未対応にする", () => {
  const templates = normalizeAnkiModelTemplates({
    first: { Front: "1", Back: "1" },
    second: { Front: "2", Back: "2" },
    third: { Front: "3", Back: "3" },
    fourth: { Front: "4", Back: "4" },
  });
  assert.deepEqual(templates.map(({ name, ord }) => ({ name, ord })), [
    { name: "first", ord: 0 },
    { name: "second", ord: 1 },
    { name: "third", ord: 2 },
    { name: "fourth", ord: 3 },
  ]);
  assert.equal(resolveAnkiCardTemplate(0, templates).template?.name, "first");
  assert.equal(resolveAnkiCardTemplate(1, templates).template?.name, "second");
  const unmatched = resolveAnkiCardTemplate(9, templates);
  assert.equal(unmatched.template, null);
  assert.match(unmatched.warning ?? "", /ord 9/);
});

test("テンプレートの二重・三重波括弧と条件・フィルターからフィールド名を正規化する", () => {
  assert.deepEqual(
    extractAnkiTemplateFieldNames(
      "{{読み}} {{{書き}}} {{#意味}}{{furigana:読み}}{{/意味}} {{tts ja_JP:音声}} {{FrontSide}} {{! コメント }}",
    ),
    ["読み", "書き", "意味", "音声"],
  );
});
