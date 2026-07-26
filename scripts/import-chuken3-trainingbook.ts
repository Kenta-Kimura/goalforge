import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION_ID = "import-chuken3-trainingbook-v1";
const WRITING_TITLE = "《改訂版》合格奪取！中国語検定 3級 トレーニングブック 【筆記問題編】";
const LISTENING_TITLE = "《改訂版》合格奪取！中国語検定 3級 トレーニングブック 【リスニング問題編】";
const DEFAULT_SOURCE = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/Documents/資格試験/中国語検定/中国語検定2級.numbers",
);
const DEFAULT_DATABASE = join(
  homedir(),
  "Library/Application Support/jp.kenta.goalforge/goalforge.sqlite",
);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoManifest = join(repositoryRoot, "src-tauri/Cargo.toml");
const usage =
  "usage: npm run import:chuken3 -- [--source file.numbers] [--db goalforge.sqlite] [--backup backup.sqlite]";

type Cell = string | number | null | undefined;
type ImportAttempt = {
  sourceAnswerColumn: number;
  answeredAt: string | null;
  value: number;
};
type ImportProblem = {
  key: string;
  number: string;
  title: string;
  attempts: ImportAttempt[];
};
type ImportSection = {
  key: string;
  title: string;
  problems: ImportProblem[];
};
type ImportMaterial = {
  key: "writing" | "listening";
  title: string;
  maxAnswerColumn: number;
  sections: ImportSection[];
};

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workingDirectory = mkdtempSync(join(tmpdir(), "goalforge-chuken3-import-"));
  try {
    const sourcePath = resolve(options.source ?? DEFAULT_SOURCE);
    const databasePath = resolve(options.db ?? DEFAULT_DATABASE);
    const backupPath = resolve(options.backup ?? defaultBackupPath(databasePath));
    const workbookPath = exportNumbersToXlsx(sourcePath, workingDirectory);
    const workbook = readXlsx(workbookPath);
    const payload = {
      migrationId: MIGRATION_ID,
      materials: [
        buildWritingMaterial(requiredSheet(workbook, "筆記（3級）")),
        buildListeningMaterial(requiredSheet(workbook, "リスニング（3級）")),
      ],
    };
    validatePayload(payload.materials);
    const payloadPath = join(workingDirectory, "chuken3-import-payload.json");
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    runImporter(["preflight", databasePath]);
    if (existsSync(backupPath)) {
      throw new Error(`バックアップ先が既に存在します: ${backupPath}`);
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    execFileSync("sqlite3", [databasePath, `.backup '${escapeSqliteDotPath(backupPath)}'`], {
      stdio: "inherit",
    });
    runImporter(["apply", databasePath, backupPath, payloadPath]);
    console.log(`backup: ${backupPath}`);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function parseArguments(arguments_: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--source", "--db", "--backup"].includes(key) || !value) {
      throw new Error(usage);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function defaultBackupPath(databasePath: string) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(dirname(databasePath), "backups", `goalforge-before-chuken3-${timestamp}.sqlite`);
}

function exportNumbersToXlsx(sourcePath: string, directory: string) {
  if (extname(sourcePath).toLowerCase() === ".xlsx") return sourcePath;
  if (extname(sourcePath).toLowerCase() !== ".numbers") {
    throw new Error(`Numbersまたは一時Excelのみ指定できます: ${sourcePath}`);
  }
  const outputPath = join(directory, `${basename(sourcePath, ".numbers")}.xlsx`);
  execFileSync(
    "osascript",
    [
      "-e",
      'tell application "Numbers"',
      "-e",
      `set sourceDocument to open POSIX file ${appleScriptString(sourcePath)}`,
      "-e",
      `export sourceDocument to POSIX file ${appleScriptString(outputPath)} as Microsoft Excel`,
      "-e",
      "close sourceDocument saving no",
      "-e",
      "end tell",
    ],
    { stdio: "inherit" },
  );
  return outputPath;
}

function runImporter(arguments_: string[]) {
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      cargoManifest,
      "--bin",
      "import_chuken3_trainingbook",
      "--",
      ...arguments_,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
}

function buildWritingMaterial(rows: Cell[][]): ImportMaterial {
  assertHeader(rows[0], ["STEP", "UNIT", "大問", "問題"], "筆記（3級）");
  return buildMaterial({
    key: "writing",
    title: WRITING_TITLE,
    rows,
    maxAnswerColumn: 3,
    answerPairs: [
      [7, 8],
      [9, 10],
      [11, 12],
    ],
    structure(row) {
      const step = integer(row[0], "STEP");
      const unit = optionalInteger(row[1]);
      const major = integer(row[2], "大問");
      const problem = integer(row[3], "問題");
      return {
        sectionTitle: [`STEP ${step}`, unit === null ? null : `UNIT ${unit}`, `大問${major}`]
          .filter(Boolean)
          .join(" "),
        problemNumber: String(problem),
        problemTitle: `大問${major} 問${problem}`,
      };
    },
  });
}

function buildListeningMaterial(rows: Cell[][]): ImportMaterial {
  assertHeader(rows[0], ["STEP", "UNIT", "問題"], "リスニング（3級）");
  return buildMaterial({
    key: "listening",
    title: LISTENING_TITLE,
    rows,
    maxAnswerColumn: 6,
    answerPairs: [
      [7, 8],
      [9, 10],
      [11, 12],
      [13, 14],
      [15, 16],
      [17, 18],
    ],
    structure(row) {
      const step = integer(row[0], "STEP");
      const unit = optionalInteger(row[1]);
      const majorOrProblem = integer(row[2], "問題");
      const problem = optionalInteger(row[3]);
      if (problem === null) {
        return {
          sectionTitle: `STEP ${step}`,
          problemNumber: String(majorOrProblem),
          problemTitle: `問${majorOrProblem}`,
        };
      }
      if (unit === null) throw new Error("リスニングSTEP 2のUNITが空です。");
      return {
        sectionTitle: `STEP ${step} UNIT ${unit} 大問${majorOrProblem}`,
        problemNumber: String(problem),
        problemTitle: `大問${majorOrProblem} 問${problem}`,
      };
    },
  });
}

function buildMaterial(input: {
  key: "writing" | "listening";
  title: string;
  rows: Cell[][];
  maxAnswerColumn: number;
  answerPairs: Array<[number, number]>;
  structure: (row: Cell[]) => {
    sectionTitle: string;
    problemNumber: string;
    problemTitle: string;
  };
}): ImportMaterial {
  const sections = new Map<string, ImportSection>();
  input.rows.slice(1).forEach((row, rowIndex) => {
    if (typeof row[0] !== "number" || !Number.isInteger(row[0])) {
      const containsAnswer = input.answerPairs.some(([, answerColumn]) =>
        [0, 1, 2].includes(row[answerColumn] as number),
      );
      if (containsAnswer) {
        throw new Error(`${input.key} 元行${rowIndex + 2}はSTEPなしで回答値を含みます。`);
      }
      return;
    }
    const attempts = input.answerPairs.flatMap(([dateColumn, answerColumn], pairIndex) => {
      const value = row[answerColumn];
      if (value == null || value === "") return [];
      if (![0, 1, 2].includes(value as number)) {
        throw new Error(`${input.key} 元行${rowIndex + 2}に不正な回答値があります: ${String(value)}`);
      }
      return [{
        sourceAnswerColumn: pairIndex + 1,
        answeredAt: excelDateToIso(row[dateColumn]),
        value: value as number,
      }];
    });
    if (attempts.length === 0) return;
    const structure = input.structure(row);
    let section = sections.get(structure.sectionTitle);
    if (!section) {
      section = {
        key: slugKey(structure.sectionTitle),
        title: structure.sectionTitle,
        problems: [],
      };
      sections.set(structure.sectionTitle, section);
    }
    section.problems.push({
      key: `row-${rowIndex + 2}`,
      number: structure.problemNumber,
      title: structure.problemTitle,
      attempts,
    });
  });
  return {
    key: input.key,
    title: input.title,
    maxAnswerColumn: input.maxAnswerColumn,
    sections: [...sections.values()],
  };
}

function validatePayload(materials: ImportMaterial[]) {
  const [writing, listening] = materials;
  const totals = summarize(materials);
  const writingSummary = summarize([writing]);
  const listeningSummary = summarize([listening]);
  const expected = {
    materials: 2,
    sections: 41,
    problems: 661,
    attempts: 1446,
    nullDates: 300,
    value0: 501,
    value1: 343,
    value2: 602,
  };
  if (
    writingSummary.sections !== 30
    || writingSummary.problems !== 511
    || writingSummary.attempts !== 986
    || listeningSummary.sections !== 11
    || listeningSummary.problems !== 150
    || listeningSummary.attempts !== 460
    || Object.entries(expected).some(([key, value]) => totals[key as keyof typeof totals] !== value)
  ) {
    throw new Error(`Numbers解析件数が想定と一致しません: ${JSON.stringify({ totals, writingSummary, listeningSummary })}`);
  }
  for (const material of materials) {
    for (const section of material.sections) {
      for (const problem of section.problems) {
        problem.attempts.forEach((attempt, index) => {
          const attemptNumber = index + 1;
          if (attemptNumber < 1) throw new Error(`${problem.key}のattempt_numberが不正です。`);
        });
      }
    }
  }
}

function summarize(materials: ImportMaterial[]) {
  const attempts = materials
    .flatMap((material) => material.sections)
    .flatMap((section) => section.problems)
    .flatMap((problem) => problem.attempts);
  return {
    materials: materials.length,
    sections: materials.reduce((sum, material) => sum + material.sections.length, 0),
    problems: materials
      .flatMap((material) => material.sections)
      .reduce((sum, section) => sum + section.problems.length, 0),
    attempts: attempts.length,
    nullDates: attempts.filter((attempt) => attempt.answeredAt === null).length,
    value0: attempts.filter((attempt) => attempt.value === 0).length,
    value1: attempts.filter((attempt) => attempt.value === 1).length,
    value2: attempts.filter((attempt) => attempt.value === 2).length,
  };
}

function excelDateToIso(value: Cell) {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`実施日時がExcel日付シリアルではありません: ${String(value)}`);
  }
  const utc = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  return `${utc.toISOString().slice(0, 10)}T00:00:00+09:00`;
}

function assertHeader(row: Cell[], expected: string[], sheetName: string) {
  expected.forEach((value, index) => {
    if (row[index] !== value) {
      throw new Error(`${sheetName}の列${index + 1}が想定外です: ${String(row[index])}`);
    }
  });
}

function integer(value: Cell, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label}が整数ではありません: ${String(value)}`);
  }
  return value;
}

function optionalInteger(value: Cell) {
  if (value == null || value === "") return null;
  return integer(value, "任意番号");
}

function slugKey(value: string) {
  return value
    .replaceAll("STEP ", "step-")
    .replaceAll(" UNIT ", "-unit-")
    .replaceAll(" 大問", "-major-")
    .toLowerCase();
}

function appleScriptString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeSqliteDotPath(value: string) {
  return value.replaceAll("'", "''");
}

function requiredSheet(workbook: Map<string, Cell[][]>, name: string) {
  const sheet = workbook.get(name);
  if (!sheet) throw new Error(`対象シートがありません: ${name}`);
  return sheet;
}

function readXlsx(path: string) {
  const workbookXml = unzipText(path, "xl/workbook.xml");
  const relationshipsXml = unzipText(path, "xl/_rels/workbook.xml.rels");
  const sharedStrings = readSharedStrings(path);
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = xmlAttributes(match[1]);
    if (attributes.Id && attributes.Target) relationships.set(attributes.Id, attributes.Target);
  }
  const workbook = new Map<string, Cell[][]>();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attributes = xmlAttributes(match[1]);
    const name = attributes.name;
    const relationshipId = attributes["r:id"];
    if (!name || !relationshipId) continue;
    const target = relationships.get(relationshipId);
    if (!target) throw new Error(`Sheet relationshipがありません: ${name}`);
    const normalizedTarget = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^(\.\.\/)+/, "")}`;
    workbook.set(name, readWorksheet(unzipText(path, normalizedTarget), sharedStrings));
  }
  return workbook;
}

function readSharedStrings(path: string) {
  try {
    const xml = unzipText(path, "xl/sharedStrings.xml");
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
      [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((text) => decodeXml(text[1]))
        .join(""),
    );
  } catch {
    return [];
  }
}

function readWorksheet(xml: string, sharedStrings: string[]) {
  const rows: Cell[][] = [];
  for (const cellMatch of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attributes = xmlAttributes(cellMatch[1]);
    const reference = attributes.r;
    if (!reference) continue;
    const coordinate = /^([A-Z]+)(\d+)$/.exec(reference);
    if (!coordinate) continue;
    const rowIndex = Number(coordinate[2]) - 1;
    const columnIndex = columnNumber(coordinate[1]);
    while (rows.length <= rowIndex) rows.push([]);
    while (rows[rowIndex].length <= columnIndex) rows[rowIndex].push(null);
    const body = cellMatch[2] ?? "";
    const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
    const inlineMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
    const raw = valueMatch?.[1] ?? inlineMatch?.[1] ?? "";
    rows[rowIndex][columnIndex] = parseCellValue(attributes.t, decodeXml(raw), sharedStrings);
  }
  return rows;
}

function parseCellValue(type: string | undefined, raw: string, sharedStrings: string[]): Cell {
  if (type === "s") return sharedStrings[Number(raw)] ?? null;
  if (type === "inlineStr" || type === "str") return raw;
  if (raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

function xmlAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  return attributes;
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function columnNumber(letters: string) {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function unzipText(archive: string, member: string) {
  return execFileSync("unzip", ["-p", archive, member], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}
