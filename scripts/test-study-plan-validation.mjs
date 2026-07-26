import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outfile = `/private/tmp/goalforge-study-plan-validation-${Date.now()}.mjs`;

await build({
  bundle: true,
  entryPoints: ["src/lib/studyPlan.ts"],
  format: "esm",
  outfile,
  platform: "node",
});

const { toStudyPlan, validateStudyPlanJson } = await import(pathToFileURL(outfile));

const goal = {
  id: "chuken-2",
  title: "中国語検定2級",
  subtitle: "",
  status: "active",
  readiness: 0,
  targetXp: 3600,
  xp: 0,
  examDate: "2026-11-22",
  skillIds: [],
  collectionIds: [],
};

const existingPlan = {
  id: "plan-chuken-2",
  goalId: "chuken-2",
  planName: "中国語検定2級 学習計画",
  examDate: "2026-11-22",
  overallStrategy: "",
  importedAt: "2026-06-28T00:00:00.000Z",
  resourceMergeModes: {},
  milestones: [],
  warnings: [],
  resources: [
    {
      id: "grammar-textbook",
      name: "文法テキスト",
      type: "book",
      unit: "pages",
      targetAmount: 320,
      currentAmount: 40,
      weight: 25,
      weeklyTarget: 20,
      priority: "high",
      notes: "",
    },
  ],
};

function basePlan(overrides = {}) {
  return {
    goalId: "chuken-2",
    planName: "中国語検定2級 学習計画",
    examDate: "2026-11-22",
    overallStrategy: "語彙と文法を先に固める。",
    resources: [
      {
        id: "grammar-textbook",
        name: "文法テキスト",
        type: "book",
        unit: "pages",
        targetAmount: 320,
        currentAmount: 40,
        weight: 25,
        weeklyTarget: 20,
        priority: "high",
        notes: "",
      },
    ],
    ...overrides,
  };
}

function validate(value, plan = existingPlan) {
  return validateStudyPlanJson(JSON.stringify(value), goal, plan);
}

{
  const result = validate(
    basePlan({
      resources: [
        {
          ...basePlan().resources[0],
          startCondition: { type: "immediate" },
        },
      ],
    }),
  );
  assert.equal(result.errors.length, 0, "immediate startCondition should be accepted");
  assert.equal(result.plan.resources[0].startCondition, undefined);
}

{
  const result = validate(
    basePlan({
      resources: [{ ...basePlan().resources[0], id: "unknown-id" }],
    }),
  );
  assert.equal(result.errors.length, 0, "unknown id with matching name should not fail");
  assert.match(result.warnings.join("\n"), /name "文法テキスト"/);
}

{
  const markdown = `\uFEFF　\`\`\`json
${JSON.stringify(basePlan(), null, 2)}
\`\`\``;
  const result = validateStudyPlanJson(markdown, goal, existingPlan);
  assert.equal(result.errors.length, 0, "markdown fenced JSON should parse");
}

{
  const result = validate(basePlan({ goalId: "chuken-2" }));
  assert.equal(result.errors.length, 0, "goalId chuken-2 should be accepted");
}

{
  const result = validate(
    basePlan({
      resources: [{ ...basePlan().resources[0], startDate: undefined, endDate: undefined }],
    }),
  );
  assert.equal(result.errors.length, 0, "missing resource dates should be filled");
  assert.match(result.plan.resources[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(result.plan.resources[0].endDate, /^\d{4}-\d{2}-\d{2}$/);
}

{
  const result = validate(
    basePlan({
      resources: [{ ...basePlan().resources[0], type: "other" }],
    }),
  );
  assert.equal(result.errors.length, 0, "type other should be accepted");
  assert.equal(result.plan.resources[0].type, "other");
}

{
  const result = validate(
    basePlan({
      resources: [
        { ...basePlan().resources[0], unit: "cards" },
        {
          id: "practice-sessions",
          name: "練習セッション",
          type: "manual",
          unit: "sessions",
          targetAmount: 10,
          currentAmount: 1,
          weight: 15,
          weeklyTarget: 0.5,
          priority: "medium",
          notes: "",
        },
      ],
    }),
  );
  assert.equal(result.errors.length, 0, "unknown display units should be accepted");
  assert.equal(result.plan.resources[0].unit, "cards");
  assert.equal(result.plan.resources[1].unit, "sessions");
}

{
  const result = validate(
    basePlan({
      resources: [{ ...basePlan().resources[0], weight: 25 }],
    }),
  );
  assert.equal(result.errors.length, 0, "weight total not 100 should be warning only");
  assert.match(result.warnings.join("\n"), /weight の合計/);
}

{
  const result = validate(
    basePlan({
      resources: [
        {
          ...basePlan().resources[0],
          priority: 1,
          weeklyTarget: "unexpected",
          startCondition: { type: "afterResourceProgress", resourceId: "", threshold: 80 },
        },
      ],
    }),
  );
  assert.equal(result.errors.length, 0, "coerced values should be warnings, not errors");
  assert.match(result.warnings.join("\n"), /priority/);
  assert.match(result.warnings.join("\n"), /weeklyTarget/);
  assert.match(result.warnings.join("\n"), /startCondition.resourceId/);
}

{
  const result = validateStudyPlanJson("{ broken", goal, existingPlan);
  assert.equal(result.errorType, "parse");
  assert.match(result.errors[0], /JSONとして正しくありません/);
}

{
  const result = validate(basePlan({ goalId: "wrong-goal" }));
  assert.equal(result.errorType, "schema");
  assert.match(result.errors.join("\n"), /GoalForgeの取り込み形式/);
  assert.match(result.errors.join("\n"), /goalId/);
}

{
  const imported = validate(basePlan()).plan;
  const planWithExtraResources = {
    ...existingPlan,
    resources: [
      ...existingPlan.resources,
      { ...existingPlan.resources[0], id: "extra-1", name: "追加教材1" },
      { ...existingPlan.resources[0], id: "extra-2", name: "追加教材2" },
    ],
  };
  const saved = toStudyPlan(imported, "chuken-2", planWithExtraResources, {
    "grammar-textbook": "update",
  });
  assert.equal(saved.resources.length, 1, "import should save exactly the resources in JSON");
  assert.equal(saved.resources[0].id, "grammar-textbook", "name-matched update should keep existing id");
}

console.log("study plan validation tests passed");
