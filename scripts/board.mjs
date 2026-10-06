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
  const flags = new Set(['open', 'json']);
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
    options[name] = args.shift();
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
    '  add --dir <d> --file <item.json>',
    '  read --dir <d> --file <x.md> --title <t>',
    '  close --dir <d> --id <id> [--note <文>]',
    '  reopen --dir <d> --id <id>',
    '  list --dir <d> [--json]',
    '  answers --dir <d>',
    '  serve --dir <d> [--port <n>] [--open]',
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
  if (!isObject(answer) || !['choice', 'multi', 'rating', 'scale', 'yesno', 'number', 'text'].includes(answer.type)) {
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
  }
}

function validateItemInput(item) {
  if (!isObject(item)) throw new BoardError('item はオブジェクトで指定してください');
  requireString(item.title, 'title');
  if (item.importance !== undefined && item.importance !== null && (!Number.isInteger(item.importance) || item.importance < 1 || item.importance > 5)) {
    throw new BoardError('importance は 1〜5 または null にしてください');
  }
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
  const board = await loadBoard(dir);
  const number = nextNumber(board.items.map((item) => item.id), 'q');
  const item = {
    id: `q-${number}`,
    title: input.title,
    status: 'open',
    createdAt: now(),
    importance: input.importance ?? null,
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
  for (const item of board.items) process.stdout.write(`${item.id}\t${item.status}\t${item.title}\n`);
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

function allowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function allowedOrigin(origin, port) {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function responseValueText(item, value) {
  const answer = item.answer;
  if (answer.type === 'choice') return answer.options.find((option) => option.value === value)?.label ?? String(value);
  if (answer.type === 'multi') return (Array.isArray(value) ? value : []).map((part) => answer.options.find((option) => option.value === part)?.label ?? String(part)).join('、');
  if (answer.type === 'rating') return `★${value}/${answer.max ?? 5}`;
  if (answer.type === 'yesno') return value ? 'はい' : 'いいえ';
  if (answer.type === 'text') return '自由記入';
  if (answer.type === 'number' && answer.unit) return `${value} ${answer.unit}`;
  return String(value);
}

function responseReason(item, value, note) {
  if (typeof note !== 'string') return 'note は文字列で指定してください';
  if (note.length > MAX_NOTE) return `note は ${MAX_NOTE} 字以内にしてください`;
  const answer = item.answer;
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
  } else if (answer.type === 'text') {
    if (note.trim() === '') return '自由記入を入力してください';
  }
  return null;
}

function closeCommand(board, id) {
  return board.board.commands.close.replaceAll('{id}', id);
}

function answerMessage(board, item, value, note, answeredAt) {
  const json = JSON.stringify({ boardId: board.board.id, id: item.id, value, note, answeredAt });
  return `[decision-board] 回答が届きました: ${item.id} 「${item.title}」\n回答: ${responseValueText(item, value)}\n自由記入: ${note.trim() === '' ? 'なし' : note}\nJSON: ${json}\n\nこの回答を反映し終えたら、次のコマンドで閉じてください（HTML は自動で更新されます。HTML を手で直さないでください）:\n${closeCommand(board, item.id)}`;
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

function makeServer(dir) {
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
    if (!allowedHost(req.headers.host, port)) {
      replyJson(403, { error: 'Host が不正です' });
      return;
    }
    if (req.method === 'POST' && rawPath === '/api/answer') {
      if (!allowedOrigin(req.headers.origin, port)) {
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
            const note = payload.note === undefined ? '' : payload.note;
            const reason = responseReason(item, payload.value, note);
            if (reason) throw jsonError(reason, 400);
            const answeredAt = now();
            const value = item.answer.type === 'text' ? null : payload.value;
            const message = answerMessage(board, item, value, note, answeredAt);
            item.response = { value, note, answeredAt, via: 'server' };
            item.status = 'answered';
            await appendJsonLine(path.join(dir, 'answers.jsonl'), {
              boardId: board.board.id,
              id: item.id,
              title: item.title,
              value,
              note,
              answeredAt,
            });
            await writeBoard(dir, board);
            const notification = await notifyInbox(board.board.inbox, message);
            const response = { ok: true, item, ...notification, message, closeCommand: closeCommand(board, item.id) };
            replyJson(200, response);
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
  const previous = await existingServer(metaPath);
  if (previous) {
    if (options.open) openUrl(previous.url);
    process.stdout.write(`既に動いています: ${previous.url}\n`);
    return;
  }
  const portValue = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) throw new BoardError('--port が不正です');
  const server = makeServer(dir);
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
  await atomicWrite(metaPath, `${JSON.stringify({ pid: process.pid, port, url, startedAt: now() }, null, 2)}\n`);
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

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}

export { main, responseReason, answerMessage };
