import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import crypto from 'node:crypto';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const ASSET_PATH = path.join(SCRIPT_DIR, '..', 'assets', 'board.html');
const MAX_BODY = 64 * 1024;
const MAX_NOTE = 8000;

class BoardError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function now() {
  return new Date().toISOString();
}

function jsonError(message, status = 400) {
  const error = new Error(message);
  error.httpStatus = status;
  return error;
}

function randomId() {
  return crypto.randomBytes(2).toString('hex');
}

function boardId() {
  return `b-${Date.now().toString(36)}-${randomId()}`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {};
  const flags = new Set(['open', 'json', 'clear']);
  while (args.length > 0) {
    const key = args.shift();
    if (!key.startsWith('--')) throw new BoardError(`不明な引数です: ${key}`);
    if (flags.has(key.slice(2))) {
      options[key.slice(2)] = true;
      continue;
    }
    const name = key.slice(2);
    if (args.length === 0 || args[0].startsWith('--')) {
      throw new BoardError(`引数がありません: ${key}`);
    }
    const value = args.shift();
    if (name === 'public-url') {
      if (!Array.isArray(options[name])) options[name] = [];
      options[name].push(value);
    } else if (name === 'id') {
      if (!Array.isArray(options.ids)) options.ids = [];
      options.ids.push(value);
      options.id = value;
    } else {
      options[name] = value;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BoardError(`必須引数がありません: --${name}`);
  }
  return value;
}

function usage() {
  return [
    '使い方: node scripts/board.mjs <command> ...',
    '  init --dir <d> --session <s> --cwd <p> [--inbox <JSON配列>]',
    '  add --dir <d> --file <item.json> [--group <区分>]',
    '  group --dir <d> --id <id> [--id <id> ...] (--group <区分> | --clear)',
    '  groups --dir <d> [--json] [--set <JSON配列>]',
    '  read --dir <d> --file <x.md> --title <t>',
    '  close --dir <d> --id <id> [--note <文>]',
    '  reopen --dir <d> --id <id>',
    '  list --dir <d> [--json]',
    '  answers --dir <d>',
    '  serve --dir <d> [--port <n>] [--open] [--public-url <URL> ...]',
    '  url --dir <d>',
    '  stop --dir <d>',
  ].join('\n');
}

function resolvedDir(options) {
  return path.resolve(requireOption(options, 'dir'));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(temp, data, 'utf8');
    await fs.rename(temp, filePath);
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch {}
    throw error;
  }
}

async function readJson(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(source);
  } catch {
    throw new BoardError(`JSON を読めません: ${filePath}`, 1);
  }
}

async function loadBoard(dir) {
  return readJson(path.join(dir, 'board.json'));
}

function escapeSnapshot(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

async function renderIndex(dir, board) {
  const template = await fs.readFile(ASSET_PATH, 'utf8');
  const marker = /<script id="board-snapshot" type="application\/json">[\s\S]*?<\/script>/;
  if (!marker.test(template)) {
    throw new BoardError('HTML 雛形に board-snapshot がありません', 1);
  }
  const snapshot = `<script id="board-snapshot" type="application/json">${escapeSnapshot(board)}</script>`;
  await atomicWrite(path.join(dir, 'index.html'), template.replace(marker, snapshot));
}

async function writeBoard(dir, board) {
  board.updatedAt = now();
  await atomicWrite(path.join(dir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
  await renderIndex(dir, board);
}

async function appendJsonLine(filePath, value) {
  let old = '';
  try {
    old = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await atomicWrite(filePath, `${old}${JSON.stringify(value)}\n`);
}

function parseInbox(value) {
  if (value === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BoardError('--inbox は JSON 配列で指定してください');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== 'string')) {
    throw new BoardError('--inbox は空でない文字列配列で指定してください');
  }
  return parsed;
}

function shellQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}` + '"';
}

function commandSet(dir) {
  const quotedScript = shellQuote(SCRIPT_PATH);
  const quotedDir = shellQuote(dir);
  return {
    close: `node ${quotedScript} close --dir ${quotedDir} --id {id}`,
    reopen: `node ${quotedScript} reopen --dir ${quotedDir} --id {id}`,
    list: `node ${quotedScript} list --dir ${quotedDir}`,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim() === '')) {
    throw new BoardError(`${label} は文字列で指定してください`);
  }
}

function answerValueReason(answer, value) {
  if (answer.type === 'choice') {
    if (typeof value !== 'string' || !answer.options.some((option) => option.value === value)) return '選択肢が不正です';
  } else if (answer.type === 'multi') {
    const min = answer.min ?? 1;
    if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((part) => typeof part !== 'string' || !answer.options.some((option) => option.value === part))) return '複数選択が不正です';
    if (value.length < min || (answer.max !== undefined && value.length > answer.max)) return '選択数が範囲外です';
  } else if (answer.type === 'rating') {
    const max = answer.max ?? 5;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return '評価が不正です';
  } else if (answer.type === 'scale') {
    const step = answer.step ?? 1;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < answer.min || value > answer.max || Math.abs((value - answer.min) / step - Math.round((value - answer.min) / step)) > 1e-9) return '尺度の値が不正です';
  } else if (answer.type === 'yesno') {
    if (value !== true && value !== false) return 'はい・いいえの値が不正です';
  } else if (answer.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (answer.min !== undefined && value < answer.min) || (answer.max !== undefined && value > answer.max)) return '数値が不正です';
  } else if (answer.type === 'table') {
    if (!Array.isArray(value) || value.length !== answer.rows.length || value.some((part) => typeof part !== 'string' || part.length > MAX_NOTE)) return '表の回答が不正です';
  } else {
    return '自由記入型には値を指定できません';
  }
  return null;
}

function validateSections(sections) {
  if (!Array.isArray(sections)) throw new BoardError('sections は配列で指定してください');
  for (const [index, section] of sections.entries()) {
    if (!isObject(section) || typeof section.type !== 'string') {
      throw new BoardError(`sections[${index}] の type がありません`);
    }
    if (section.type === 'text') {
      requireString(section.md, `sections[${index}].md`, { empty: true });
      if (section.heading !== undefined) requireString(section.heading, `sections[${index}].heading`);
    } else if (section.type === 'callout') {
      if (!['brand', 'warning', 'danger', 'success', 'neutral'].includes(section.variant)) {
        throw new BoardError(`sections[${index}].variant が不正です`);
      }
      requireString(section.md, `sections[${index}].md`, { empty: true });
    } else if (section.type === 'options') {
      if (!Array.isArray(section.items) || section.items.length === 0) {
        throw new BoardError(`sections[${index}].items は空でない配列にしてください`);
      }
      for (const [itemIndex, item] of section.items.entries()) {
        if (!isObject(item)) throw new BoardError(`sections[${index}].items[${itemIndex}] が不正です`);
        requireString(item.key, `sections[${index}].items[${itemIndex}].key`);
        requireString(item.label, `sections[${index}].items[${itemIndex}].label`);
        for (const field of ['pros', 'cons']) {
          if (item[field] !== undefined && (!Array.isArray(item[field]) || item[field].some((x) => typeof x !== 'string'))) {
            throw new BoardError(`${field} は文字列配列にしてください`);
          }
        }
        if (item.summary !== undefined) requireString(item.summary, `sections[${index}].items[${itemIndex}].summary`, { empty: true });
        if (item.recommended !== undefined && typeof item.recommended !== 'boolean') {
          throw new BoardError('recommended は真偽値にしてください');
        }
      }
    } else if (section.type === 'table') {
      if (section.heading !== undefined) requireString(section.heading, `sections[${index}].heading`);
      if (!Array.isArray(section.columns) || section.columns.some((x) => typeof x !== 'string')) {
        throw new BoardError(`sections[${index}].columns が不正です`);
      }
      if (!Array.isArray(section.rows) || section.rows.some((row) => !Array.isArray(row) || row.length !== section.columns.length)) {
        throw new BoardError(`sections[${index}].rows が不正です`);
      }
    } else if (section.type === 'chart') {
      if (section.heading !== undefined) requireString(section.heading, `sections[${index}].heading`);
      const chart = section.chart;
      if (!isObject(chart) || !['bar', 'line', 'pie', 'doughnut', 'radar'].includes(chart.type)) {
        throw new BoardError(`sections[${index}].chart が不正です`);
      }
      if (!Array.isArray(chart.labels) || chart.labels.some((x) => typeof x !== 'string')) {
        throw new BoardError(`sections[${index}].chart.labels が不正です`);
      }
      if (!Array.isArray(chart.datasets) || chart.datasets.length === 0) {
        throw new BoardError(`sections[${index}].chart.datasets が不正です`);
      }
      for (const dataset of chart.datasets) {
        if (!isObject(dataset) || typeof dataset.label !== 'string' || !Array.isArray(dataset.data) || dataset.data.length !== chart.labels.length || dataset.data.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
          throw new BoardError(`sections[${index}].chart.datasets が不正です`);
        }
      }
    } else if (section.type === 'metric') {
      if (!Array.isArray(section.items) || section.items.length < 2 || section.items.length > 4) {
        throw new BoardError(`sections[${index}].items は 2〜4 件にしてください`);
      }
      for (const item of section.items) {
        if (!isObject(item)) throw new BoardError(`sections[${index}].items が不正です`);
        requireString(item.label, `sections[${index}].items.label`);
        if (item.unit !== undefined) requireString(item.unit, 'metric.unit', { empty: true });
        if (item.note !== undefined) requireString(item.note, 'metric.note', { empty: true });
        if (item.value === undefined || item.value === null) throw new BoardError('metric.value がありません');
      }
    }
  }
}

function validateAnswer(answer) {
  if (!isObject(answer) || !['choice', 'multi', 'rating', 'scale', 'yesno', 'number', 'text', 'table'].includes(answer.type)) {
    throw new BoardError('answer.type が不正です');
  }
  if (answer.prompt !== undefined) requireString(answer.prompt, 'answer.prompt');
  if (['choice', 'multi'].includes(answer.type)) {
    if (!Array.isArray(answer.options) || answer.options.length === 0) throw new BoardError('answer.options が不正です');
    for (const option of answer.options) {
      if (!isObject(option) || typeof option.value !== 'string' || typeof option.label !== 'string') {
        throw new BoardError('answer.options の要素が不正です');
      }
      if (option.hint !== undefined) requireString(option.hint, 'answer.options.hint', { empty: true });
    }
    if (new Set(answer.options.map((option) => option.value)).size !== answer.options.length) {
      throw new BoardError('answer.options の value は重複できません');
    }
    if (answer.type === 'multi') {
      if (answer.min !== undefined && (!Number.isInteger(answer.min) || answer.min < 0)) throw new BoardError('answer.min が不正です');
      if (answer.max !== undefined && (!Number.isInteger(answer.max) || answer.max < 0)) throw new BoardError('answer.max が不正です');
      if (answer.min !== undefined && answer.max !== undefined && answer.min > answer.max) throw new BoardError('answer.min と max が不正です');
    }
  } else if (answer.type === 'rating') {
    if (answer.max !== undefined && (!Number.isInteger(answer.max) || answer.max < 1)) throw new BoardError('rating.max が不正です');
    if (answer.label !== undefined) requireString(answer.label, 'rating.label', { empty: true });
  } else if (answer.type === 'scale') {
    if (typeof answer.min !== 'number' || typeof answer.max !== 'number' || !Number.isFinite(answer.min) || !Number.isFinite(answer.max) || answer.min >= answer.max) throw new BoardError('scale の min/max が不正です');
    if (answer.step !== undefined && (typeof answer.step !== 'number' || !Number.isFinite(answer.step) || answer.step <= 0)) throw new BoardError('scale.step が不正です');
    for (const field of ['minLabel', 'maxLabel']) if (answer[field] !== undefined) requireString(answer[field], `scale.${field}`, { empty: true });
  } else if (answer.type === 'yesno') {
    for (const field of ['yesLabel', 'noLabel']) if (answer[field] !== undefined) requireString(answer[field], `yesno.${field}`, { empty: true });
  } else if (answer.type === 'number') {
    for (const field of ['min', 'max']) if (answer[field] !== undefined && (typeof answer[field] !== 'number' || !Number.isFinite(answer[field]))) throw new BoardError(`number.${field} が不正です`);
    if (answer.min !== undefined && answer.max !== undefined && answer.min > answer.max) throw new BoardError('number.min と max が不正です');
    if (answer.unit !== undefined) requireString(answer.unit, 'number.unit', { empty: true });
  } else if (answer.type === 'table') {
    if (!Array.isArray(answer.columns) || answer.columns.length < 1 || answer.columns.length > 6 || answer.columns.some((column) => typeof column !== 'string' || column.trim() === '')) {
      throw new BoardError('answer.columns は 1〜6 個の文字列にしてください');
    }
    if (!Array.isArray(answer.rows) || answer.rows.length < 1 || answer.rows.length > 50) {
      throw new BoardError('answer.rows は 1〜50 行にしてください');
    }
    for (const row of answer.rows) {
      if (!Array.isArray(row) || row.length !== answer.columns.length || row.some((cell) => typeof cell !== 'string')) {
        throw new BoardError('answer.rows は columns と同じ長さの文字列配列にしてください');
      }
      if (row[0].trim() === '') throw new BoardError('answer.rows の 1 列目は空にできません');
    }
    if (answer.inputLabel !== undefined && (typeof answer.inputLabel !== 'string' || [...answer.inputLabel.trim()].length < 1 || [...answer.inputLabel.trim()].length > 30)) {
      throw new BoardError('answer.inputLabel は trim 後が 1〜30 文字の文字列にしてください');
    }
    if (answer.inputPlaceholder !== undefined && (typeof answer.inputPlaceholder !== 'string' || [...answer.inputPlaceholder].length > 200)) {
      throw new BoardError('answer.inputPlaceholder は 200 文字以内の文字列にしてください');
    }
  }
  if (answer.type === 'table' && answer.recommended !== undefined) throw new BoardError('answer.recommended は table では指定できません');
  if (answer.recommended !== undefined) {
    if (answer.type === 'multi' && Array.isArray(answer.recommended) && answer.recommended.length === 0) {
      throw new BoardError('answer.recommended が不正です: 空配列は指定できません');
    }
    const reason = answerValueReason(answer, answer.recommended);
    if (reason) throw new BoardError(`answer.recommended が不正です: ${reason}`);
  }
}

function validateGroupName(value, label) {
  if (typeof value !== 'string') throw new BoardError(`${label} は 1〜30 文字にしてください`);
  const trimmed = value.trim();
  if ([...trimmed].length < 1 || [...trimmed].length > 30) {
    throw new BoardError(`${label} は 1〜30 文字にしてください`);
  }
  return trimmed;
}

function validateItemInput(item) {
  if (!isObject(item)) throw new BoardError('item はオブジェクトで指定してください');
  requireString(item.title, 'title');
  if (item.importance !== undefined && item.importance !== null && (!Number.isInteger(item.importance) || item.importance < 1 || item.importance > 5)) {
    throw new BoardError('importance は 1〜5 または null にしてください');
  }
  if (item.group !== undefined) validateGroupName(item.group, 'group');
  validateSections(item.sections);
  validateAnswer(item.answer);
}

function nextNumber(values, prefix) {
  let max = 0;
  for (const value of values) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function commandInit(options) {
  const dir = resolvedDir(options);
  const session = requireOption(options, 'session');
  const cwd = path.resolve(requireOption(options, 'cwd'));
  const inbox = parseInbox(options.inbox);
  await ensureDir(dir);
  await ensureDir(path.join(dir, 'reads'));
  let board;
  try {
    board = await loadBoard(dir);
    if (!isObject(board.board)) throw new Error('invalid board');
    board.board.session = session;
    board.board.cwd = cwd;
    board.board.inbox = inbox;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const timestamp = now();
    board = {
      version: 1,
      board: {
        id: boardId(),
        session,
        cwd,
        createdAt: timestamp,
        updatedAt: timestamp,
        inbox,
        commands: commandSet(dir),
      },
      items: [],
      reads: [],
    };
  }
  if (!board.board.commands) board.board.commands = commandSet(dir);
  if (!Array.isArray(board.items)) board.items = [];
  if (!Array.isArray(board.reads)) board.reads = [];
  await writeBoard(dir, board);
  process.stdout.write(`作成しました: ${dir}\n`);
}

async function readInput(file) {
  if (file === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return fs.readFile(file, 'utf8');
}

async function commandAdd(options) {
  const dir = resolvedDir(options);
  const file = requireOption(options, 'file');
  let input;
  try {
    input = JSON.parse(await readInput(file));
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError('入力 JSON が不正です');
  }
  validateItemInput(input);
  const group = options.group !== undefined
    ? validateGroupName(options.group, '--group')
    : input.group === undefined ? undefined : validateGroupName(input.group, 'group');
  const board = await loadBoard(dir);
  const number = nextNumber(board.items.map((item) => item.id), 'q');
  const item = {
    id: `q-${number}`,
    title: input.title,
    status: 'open',
    createdAt: now(),
    importance: input.importance ?? null,
    ...(group === undefined ? {} : { group }),
    sections: input.sections,
    answer: input.answer,
    response: null,
    closedAt: null,
    closeNote: null,
  };
  board.items.push(item);
  await writeBoard(dir, board);
  process.stdout.write(`${item.id}\n`);
}

function safeReadName(source) {
  const base = path.basename(source).replace(/\.md$/i, '');
  const safe = base.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return safe || 'read';
}

async function commandRead(options) {
  const dir = resolvedDir(options);
  const source = requireOption(options, 'file');
  const title = requireOption(options, 'title');
  const board = await loadBoard(dir);
  const number = nextNumber(board.reads.map((read) => read.id), 'r');
  const filename = `r-${number}-${safeReadName(source)}.md`;
  const destination = path.join(dir, 'reads', filename);
  await atomicWrite(destination, await fs.readFile(source));
  board.reads.push({ id: `r-${number}`, title, file: `reads/${filename}`, createdAt: now() });
  await writeBoard(dir, board);
  process.stdout.write(`${filename}\n`);
}

function findItem(board, id) {
  const item = board.items.find((candidate) => candidate.id === id);
  if (!item) throw new BoardError(`項目がありません: ${id}`, 1);
  return item;
}

async function commandGroup(options) {
  const dir = resolvedDir(options);
  const ids = options.ids ?? [];
  if (ids.length === 0) throw new BoardError('--id が 1 つもありません');
  const hasGroup = options.group !== undefined;
  const hasClear = options.clear === true;
  if (hasGroup === hasClear) throw new BoardError('--group または --clear のどちらか一方を指定してください');
  const group = hasGroup ? validateGroupName(options.group, '--group') : undefined;
  const board = await loadBoard(dir);
  const items = ids.map((id) => findItem(board, id));
  for (const item of items) {
    if (hasGroup) item.group = group;
    else delete item.group;
  }
  await writeBoard(dir, board);
  if (hasGroup) process.stdout.write(`${ids.join(',')} を「${group}」へ移しました\n`);
  else process.stdout.write(`${ids.join(',')} の区分を外しました\n`);
}

function groupOrder(board) {
  const order = [];
  const names = new Set();
  const add = (name) => {
    if (!names.has(name)) {
      names.add(name);
      order.push(name);
    }
  };
  if (Array.isArray(board.groups)) {
    for (const name of board.groups) add(name);
  }
  let hasUngrouped = false;
  for (const item of board.items) {
    if (item.group === undefined) {
      hasUngrouped = true;
    } else {
      add(item.group);
    }
  }
  if (hasUngrouped) add('その他');
  return order;
}

async function commandGroups(options) {
  const dir = resolvedDir(options);
  const board = await loadBoard(dir);
  if (options.set !== undefined) {
    let groups;
    try {
      groups = JSON.parse(options.set);
    } catch {
      throw new BoardError('--set は JSON 配列で指定してください');
    }
    if (!Array.isArray(groups)) throw new BoardError('--set は JSON 配列で指定してください');
    const trimmedGroups = groups.map((group, index) => validateGroupName(group, `groups[${index}]`));
    const seen = new Set();
    for (const group of trimmedGroups) {
      if (seen.has(group)) throw new BoardError(`groups に重複があります: ${group}`);
      seen.add(group);
    }
    if (trimmedGroups.length === 0) delete board.groups;
    else board.groups = trimmedGroups;
    await writeBoard(dir, board);
    process.stdout.write('表示順を保存しました\n');
    return;
  }
  const groups = groupOrder(board);
  if (options.json) process.stdout.write(`${JSON.stringify(groups)}\n`);
  else for (const group of groups) process.stdout.write(`${group}\n`);
}

async function commandClose(options) {
  const dir = resolvedDir(options);
  const id = requireOption(options, 'id');
  const board = await loadBoard(dir);
  const item = findItem(board, id);
  item.status = 'closed';
  item.closedAt = now();
  item.closeNote = options.note ?? null;
  await writeBoard(dir, board);
  process.stdout.write(`${id} を閉じました\n`);
}

async function commandReopen(options) {
  const dir = resolvedDir(options);
  const id = requireOption(options, 'id');
  const board = await loadBoard(dir);
  const item = findItem(board, id);
  item.status = 'open';
  item.response = null;
  item.closedAt = null;
  item.closeNote = null;
  await writeBoard(dir, board);
  process.stdout.write(`${id} を再開しました\n`);
}

async function commandList(options) {
  const dir = resolvedDir(options);
  const board = await loadBoard(dir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(board.items)}\n`);
    return;
  }
  const hasGroups = board.items.some((item) => Object.hasOwn(item, 'group'));
  for (const item of board.items) {
    const line = `${item.id}\t${item.status}\t${item.title}`;
    process.stdout.write(`${hasGroups ? `${line}\t${item.group ?? 'その他'}` : line}\n`);
  }
}

async function commandAnswers(options) {
  const dir = resolvedDir(options);
  try {
    process.stdout.write(await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpStatus(url) {
  return new Promise((resolve) => {
    let request;
    try {
      request = http.get(url, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', () => resolve(0));
      request.setTimeout(1000, () => {
        request.destroy();
        resolve(0);
      });
    } catch {
      resolve(0);
    }
  });
}

async function existingServer(metaPath) {
  try {
    const meta = await readJson(metaPath);
    if (pidAlive(meta.pid) && typeof meta.url === 'string' && (await httpStatus(meta.url)) === 200) return meta;
  } catch {}
  return null;
}

function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return;
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function normalizePublicUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) throw new BoardError('--public-url が不正です');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BoardError('--public-url が不正です');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new BoardError('--public-url が不正です');
  }
  return url.origin;
}

function normalizePublicUrls(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => normalizePublicUrl(value));
}

function sameStringSet(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function allowedHost(host, port, publicUrls = []) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || publicUrls.some((publicUrl) => host === new URL(publicUrl).host);
}

function allowedOrigin(origin, port, publicUrls = []) {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || publicUrls.some((publicUrl) => origin === publicUrl);
}

function responseValueText(item, value) {
  const answer = item.answer;
  if (answer.type === 'table') {
    const values = Array.isArray(value) ? value : [];
    const entered = [];
    for (const [index, row] of answer.rows.entries()) {
      const cell = values[index];
      if (typeof cell === 'string' && cell.trim() !== '') {
        entered.push(`${row[0]}: ${cell.replace(/\r\n|\n|\r/g, ' ')}`);
      }
    }
    return [`記入 ${entered.length} / ${answer.rows.length} 行`, ...entered].join('\n');
  }
  if (value == null && answer.type !== 'text') return '選択なし（自由記入のみ）';
  if (answer.type === 'choice') return answer.options.find((option) => option.value === value)?.label ?? String(value);
  if (answer.type === 'multi') return (Array.isArray(value) ? value : []).map((part) => answer.options.find((option) => option.value === part)?.label ?? String(part)).join('、');
  if (answer.type === 'rating') return `★${value}/${answer.max ?? 5}`;
  if (answer.type === 'yesno') return value ? (answer.yesLabel || 'はい') : (answer.noLabel || 'いいえ');
  if (answer.type === 'text') return '自由記入';
  if (answer.type === 'number' && answer.unit) return `${value} ${answer.unit}`;
  return String(value);
}

function sameAnswerValue(answer, value, recommended) {
  if (answer.type !== 'multi') return value === recommended;
  return Array.isArray(value) && Array.isArray(recommended) && value.length === recommended.length && value.every((part) => recommended.includes(part));
}

function responseReason(item, value, note) {
  if (typeof note !== 'string') return 'note は文字列で指定してください';
  if (note.length > MAX_NOTE) return `note は ${MAX_NOTE} 字以内にしてください`;
  const answer = item.answer;
  if (answer.type === 'text') {
    if (note.trim() === '') return '自由記入を入力してください';
    return null;
  }
  if (answer.type === 'table') {
    if (value === null || value === undefined) return note.trim() === '' ? '表に 1 行以上記入するか、自由記入を書いてください' : null;
    const reason = answerValueReason(answer, value);
    if (reason) return reason;
    return value.some((cell) => cell.trim() !== '') || note.trim() !== '' ? null : '表に 1 行以上記入するか、自由記入を書いてください';
  }
  if (value === null || value === undefined) return note.trim() === '' ? '回答か自由記入を入力してください' : null;
  return answerValueReason(answer, value);
}

function closeCommand(board, id) {
  return board.board.commands.close.replaceAll('{id}', id);
}

function answerMessage(board, item, value, note, answeredAt, byRecommendation = false) {
  const jsonValue = { boardId: board.board.id, id: item.id, value, note, answeredAt };
  if (byRecommendation) jsonValue.byRecommendation = true;
  const json = JSON.stringify(jsonValue);
  const display = `${responseValueText(item, value)}${byRecommendation ? '（推奨をそのまま採用）' : ''}`;
  return `[decision-board] 回答が届きました: ${item.id} 「${item.title}」\n回答: ${display}\n自由記入: ${note.trim() === '' ? 'なし' : note}\nJSON: ${json}\n\nこの回答を反映し終えたら、次のコマンドで閉じてください（HTML は自動で更新されます。HTML を手で直さないでください）:\n${closeCommand(board, item.id)}`;
}

function requestBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on('end', () => resolve({ tooLarge, body: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', () => resolve({ tooLarge: false, body: '' }));
  });
}

function notifyInbox(inbox, message) {
  if (!inbox) return Promise.resolve({ notified: null });
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(inbox[0], [...inbox.slice(1), message], { shell: false, stdio: 'ignore' });
      child.once('error', (error) => finish({ notified: false, notifyError: error.message }));
      child.once('exit', (code) => finish(code === 0 ? { notified: true } : { notified: false, notifyError: `exit ${code}` }));
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ notified: false, notifyError: 'timeout' });
      }, 10000);
    } catch (error) {
      finish({ notified: false, notifyError: error.message });
    }
  });
}

function notifyAfterResponse(inbox, itemId, message) {
  if (!inbox) return;
  setImmediate(() => {
    const notifyStarted = Date.now();
    const logResult = (notification) => {
      const elapsed = Date.now() - notifyStarted;
      const timestamp = new Date().toISOString();
      try {
        process.stdout.write(notification.notified ? `notify ${itemId} ok ${timestamp} ${elapsed}ms\n` : `notify ${itemId} failed: ${notification.notifyError} ${timestamp} ${elapsed}ms\n`);
      } catch {}
    };
    Promise.resolve().then(() => notifyInbox(inbox, message)).then(logResult).catch((error) => {
      logResult({ notified: false, notifyError: error.message || '内部エラーです' });
    });
  });
}

function jsonResponse(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function textResponse(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...headers });
  res.end(body);
}

function decodedReadPath(rawPath) {
  if (!rawPath.startsWith('/reads/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw jsonError('パスが不正です', 403);
  }
  const rest = decoded.slice('/reads/'.length);
  if (!rest || rest.includes('/') || rest.includes('\\') || rest === '.' || rest === '..' || rest.includes('..') || !/^[A-Za-z0-9._-]+\.md$/.test(rest)) {
    throw jsonError('パスが不正です', 403);
  }
  return rest;
}

function makeServer(dir, publicUrls = []) {
  let postQueue = Promise.resolve();
  const server = http.createServer((req, res) => {
    const rawPath = String(req.url ?? '/').split('?')[0];
    let logged = false;
    const finishLog = (status) => {
      if (!logged) {
        logged = true;
        process.stdout.write(`${req.method} ${rawPath} ${status}\n`);
      }
    };
    const replyJson = (status, value, headers) => {
      finishLog(status);
      jsonResponse(res, status, value, headers);
    };
    const replyText = (status, body, type, headers) => {
      finishLog(status);
      textResponse(res, status, body, type, headers);
    };
    const port = server.address()?.port;
    if (!allowedHost(req.headers.host, port, publicUrls)) {
      replyJson(403, { error: 'Host が不正です' });
      return;
    }
    if (req.method === 'POST' && rawPath === '/api/answer') {
      if (!allowedOrigin(req.headers.origin, port, publicUrls)) {
        replyJson(403, { error: 'Origin が不正です' });
        return;
      }
      if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
        replyJson(415, { error: 'Content-Type は application/json にしてください' });
        return;
      }
      requestBody(req).then(({ tooLarge, body }) => {
        if (tooLarge) {
          replyJson(413, { error: '本文が大きすぎます' });
          return;
        }
        postQueue = postQueue.then(async () => {
          try {
            let payload;
            try {
              payload = JSON.parse(body);
            } catch {
              throw jsonError('JSON が不正です', 400);
            }
            if (!isObject(payload) || typeof payload.id !== 'string' || payload.id.length === 0) throw jsonError('id がありません', 404);
            const board = await loadBoard(dir);
            const item = board.items.find((candidate) => candidate.id === payload.id);
            if (!item) throw jsonError('項目がありません', 404);
            if (item.status !== 'open') throw jsonError('この項目は回答済みです', 409);
            if (payload.byRecommendation !== undefined && typeof payload.byRecommendation !== 'boolean') throw jsonError('byRecommendation は真偽値で指定してください', 400);
            const byRecommendation = payload.byRecommendation === true;
            const note = payload.note === undefined ? '' : payload.note;
            if (byRecommendation) {
              if (item.answer.recommended === undefined) throw jsonError('推奨がありません', 400);
              if (typeof note === 'string' && note.trim() !== '') throw jsonError('推奨で送るときは自由記入を空にしてください', 400);
              if (!sameAnswerValue(item.answer, payload.value, item.answer.recommended)) throw jsonError('推奨の値と一致しません', 400);
            }
            const reason = responseReason(item, payload.value, note);
            if (reason) throw jsonError(reason, 400);
            const answeredAt = now();
            const value = item.answer.type === 'table'
              ? (Array.isArray(payload.value) ? payload.value.map((cell) => cell.trim()) : Array(item.answer.rows.length).fill(''))
              : item.answer.type === 'text' || payload.value == null ? null : payload.value;
            const message = answerMessage(board, item, value, note, answeredAt, byRecommendation);
            item.response = { value, note, answeredAt, via: 'server' };
            if (byRecommendation) item.response.byRecommendation = true;
            item.status = 'answered';
            const answerRecord = {
              boardId: board.board.id,
              id: item.id,
              title: item.title,
              value,
              note,
              answeredAt,
            };
            if (byRecommendation) answerRecord.byRecommendation = true;
            await appendJsonLine(path.join(dir, 'answers.jsonl'), answerRecord);
            await writeBoard(dir, board);
            const response = { ok: true, item, notified: board.board.inbox ? 'queued' : null, message, closeCommand: closeCommand(board, item.id) };
            replyJson(200, response);
            notifyAfterResponse(board.board.inbox, item.id, message);
          } catch (error) {
            const status = error.httpStatus ?? 500;
            replyJson(status, { error: error.message || '内部エラーです' });
          }
        }).catch((error) => replyJson(500, { error: error.message || '内部エラーです' }));
      });
      return;
    }
    if (req.method !== 'GET') {
      replyJson(404, { error: '見つかりません' });
      return;
    }
    if (rawPath === '/') {
      fs.readFile(path.join(dir, 'index.html'), 'utf8').then((body) => replyText(200, body, 'text/html; charset=utf-8')).catch(() => replyJson(404, { error: '見つかりません' }));
      return;
    }
    if (rawPath === '/board.json') {
      fs.readFile(path.join(dir, 'board.json'), 'utf8').then((body) => replyText(200, body, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' })).catch(() => replyJson(404, { error: '見つかりません' }));
      return;
    }
    if (rawPath.startsWith('/reads/')) {
      let filename;
      try {
        filename = decodedReadPath(rawPath);
      } catch (error) {
        replyJson(error.httpStatus ?? 403, { error: error.message });
        return;
      }
      fs.readFile(path.join(dir, 'reads', filename), 'utf8').then((body) => replyText(200, body, 'text/markdown; charset=utf-8')).catch((error) => replyJson(error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '見つかりません' : '内部エラーです' }));
      return;
    }
    replyJson(404, { error: '見つかりません' });
  });
  return server;
}

async function commandServe(options) {
  const dir = resolvedDir(options);
  const metaPath = path.join(dir, '.server.json');
  const publicUrls = normalizePublicUrls(options['public-url']);
  const previous = await existingServer(metaPath);
  if (previous) {
    if (options['public-url'] !== undefined) {
      const previousPublicUrls = normalizePublicUrls(previous.publicUrls);
      if (!sameStringSet(previousPublicUrls, publicUrls)) {
        throw new BoardError('既に動いています。公開 URL を変えるには stop してから serve し直してください', 1);
      }
    }
    if (options.open) openUrl(previous.url);
    process.stdout.write(`既に動いています: ${previous.url}\n`);
    return;
  }
  const portValue = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) throw new BoardError('--port が不正です');
  const server = makeServer(dir, publicUrls);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(portValue, '127.0.0.1');
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : portValue;
  const url = `http://127.0.0.1:${port}/`;
  await atomicWrite(metaPath, `${JSON.stringify({ pid: process.pid, port, url, publicUrls, startedAt: now() }, null, 2)}\n`);
  process.stdout.write(`起動しました: ${url}\n`);
  if (options.open) openUrl(url);
  await new Promise((resolve) => {
    let stopping = false;
    const stopServer = () => {
      if (stopping) return;
      stopping = true;
      fs.unlink(metaPath).catch(() => {}).finally(() => {
        server.close(() => resolve());
      });
    };
    process.once('SIGTERM', stopServer);
    process.once('SIGINT', stopServer);
  });
}

async function commandUrl(options) {
  const dir = resolvedDir(options);
  try {
    const meta = await readJson(path.join(dir, '.server.json'));
    if (typeof meta.url !== 'string') throw new Error('invalid');
    process.stdout.write(`${meta.url}\n`);
    const publicUrls = Array.isArray(meta.publicUrls) ? meta.publicUrls : [];
    for (const publicUrl of publicUrls) process.stdout.write(`${publicUrl}\n`);
  } catch {
    throw new BoardError('受け口は動いていません', 1);
  }
}

async function commandStop(options) {
  const dir = resolvedDir(options);
  const metaPath = path.join(dir, '.server.json');
  let meta;
  try {
    meta = await readJson(metaPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stdout.write('既に止まっていました\n');
      return;
    }
    throw error;
  }
  if (pidAlive(meta.pid)) {
    try {
      process.kill(meta.pid, 'SIGTERM');
    } catch {}
    process.stdout.write('停止しました\n');
  } else {
    process.stdout.write('既に止まっていました\n');
  }
  try {
    await fs.unlink(metaPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (!parsed.command) throw new BoardError(usage());
    switch (parsed.command) {
      case 'init': return await commandInit(parsed.options);
      case 'add': return await commandAdd(parsed.options);
      case 'group': return await commandGroup(parsed.options);
      case 'groups': return await commandGroups(parsed.options);
      case 'read': return await commandRead(parsed.options);
      case 'close': return await commandClose(parsed.options);
      case 'reopen': return await commandReopen(parsed.options);
      case 'list': return await commandList(parsed.options);
      case 'answers': return await commandAnswers(parsed.options);
      case 'serve': return await commandServe(parsed.options);
      case 'url': return await commandUrl(parsed.options);
      case 'stop': return await commandStop(parsed.options);
      default: throw new BoardError(`不明なコマンドです: ${parsed.command}\n${usage()}`);
    }
  } catch (error) {
    const exitCode = error instanceof BoardError ? error.exitCode : 1;
    process.stderr.write(`${error.message}\n`);
    if (exitCode === 2) process.stderr.write(`${usage()}\n`);
    process.exitCode = exitCode;
  }
}

const INVOKED_SCRIPT_PATH = process.argv[1] ? path.resolve(process.argv[1]) : null;
let directInvocation = INVOKED_SCRIPT_PATH === SCRIPT_PATH;
if (INVOKED_SCRIPT_PATH) {
  try {
    directInvocation = fssync.realpathSync(INVOKED_SCRIPT_PATH) === fssync.realpathSync(SCRIPT_PATH);
  } catch {}
}
if (directInvocation) {
  await main();
}

export { main, responseReason, answerMessage };
