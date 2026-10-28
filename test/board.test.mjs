import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'board.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', ...options });
}

async function waitFor(read, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await read();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('待機がタイムアウトしました');
}

function request(port, requestPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path: requestPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function startServer(dir, args = []) {
  const child = spawn(process.execPath, [script, 'serve', '--dir', dir, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const meta = await waitFor(async () => {
    try { return JSON.parse(await fs.readFile(path.join(dir, '.server.json'), 'utf8')); } catch { return null; }
  });
  return { child, meta };
}

test('CLI と受け口の受入', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  let serverProcess;
  try {
    const item1 = {
      title: '標準の処理方式を選ぶか',
      sections: [
        { type: 'text', md: '比較します。' },
        { type: 'callout', variant: 'neutral', md: '短く始めます。' },
        { type: 'options', items: [{ key: 'one', label: '方式一', pros: ['簡単'], cons: ['拡張に工夫'] }, { key: 'two', label: '方式二', pros: ['柔軟'], cons: ['初期負担'] }] },
        { type: 'table', columns: ['候補', '負担'], rows: [['方式一', '小'], ['方式二', '中']] },
        { type: 'chart', chart: { type: 'bar', labels: ['一', '二'], datasets: [{ label: '時間', data: [1, 2] }] } },
        { type: 'metric', items: [{ label: '候補数', value: 2 }, { label: '目標', value: 1, unit: '週' }] },
      ],
      answer: { type: 'choice', options: [{ value: 'one', label: '方式一' }, { value: 'two', label: '方式二' }] },
    };
    const item2 = {
      title: '公開前の確認を入れるか',
      sections: [{ type: 'text', md: '確認します。' }],
      answer: { type: 'yesno' },
    };
    const item1Path = path.join(dir, 'item-1.json');
    const item2Path = path.join(dir, 'item-2.json');
    await fs.writeFile(item1Path, JSON.stringify(item1));
    await fs.writeFile(item2Path, JSON.stringify(item2));
    let result = run(['init', '--dir', dir, '--session', '試験ボード', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    result = run(['add', '--dir', dir, '--file', item1Path]);
    assert.equal(result.status, 0, result.stderr);
    result = run(['add', '--dir', dir, '--file', item2Path]);
    assert.equal(result.status, 0, result.stderr);
    result = run(['list', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 2);
    assert.match(result.stdout, /q-1\topen/);
    assert.match(result.stdout, /q-2\topen/);

    const beforeInvalid = await fs.readFile(path.join(dir, 'board.json'), 'utf8');
    const invalidPath = path.join(dir, 'invalid.json');
    await fs.writeFile(invalidPath, JSON.stringify({ ...item1, answer: { type: 'unknown' } }));
    result = run(['add', '--dir', dir, '--file', invalidPath]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /answer.type/);
    assert.equal(await fs.readFile(path.join(dir, 'board.json'), 'utf8'), beforeInvalid);

    const server = await startServer(dir);
    serverProcess = server.child;
    const port = server.meta.port;
    let response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ id: 'q-1', value: 'one', note: '$(echo x)' }) });
    assert.equal(response.status, 200, response.body);
    const answerResponse = JSON.parse(response.body);
    assert.match(answerResponse.message, /close --dir/);
    assert.match(answerResponse.message, /\$\(echo x\)/);
    assert.match(answerResponse.closeCommand, /q-1/);
    const answeredBoard = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(answeredBoard.items.find((item) => item.id === 'q-1').status, 'answered');
    const lines = (await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, 'q-1');

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: 'two', note: '' }) });
    assert.equal(response.status, 409);
    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ id: 'q-2', value: true }) });
    assert.equal(response.status, 403);
    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(70 * 1024) });
    assert.equal(response.status, 413);
    response = await request(port, '/reads/../board.json');
    assert.equal(response.status, 403);
    response = await request(port, '/reads/%2e%2e/board.json');
    assert.equal(response.status, 403);
    response = await new Promise((resolve, reject) => {
      const requestWithHost = http.request({ hostname: '127.0.0.1', port, path: '/board.json', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      });
      requestWithHost.on('error', reject);
      requestWithHost.end();
    });
    assert.equal(response.statusCode, 403);

    const inboxOutput = path.join(dir, 'inbox.txt');
    const inboxCode = "require('node:fs').writeFileSync(process.argv[1], process.argv.at(-1))";
    const inbox = JSON.stringify([process.execPath, '-e', inboxCode, inboxOutput]);
    result = run(['init', '--dir', dir, '--session', '試験ボード', '--cwd', dir, '--inbox', inbox]);
    assert.equal(result.status, 0, result.stderr);
    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-2', value: true, note: '$(echo x)' }) });
    assert.equal(response.status, 200, response.body);
    await waitFor(async () => { try { return (await fs.readFile(inboxOutput, 'utf8')).includes('$(echo x)') ? true : null; } catch { return null; } });
    const inboxMessage = await fs.readFile(inboxOutput, 'utf8');
    assert.match(inboxMessage, /q-2/);
    assert.match(inboxMessage, /close --dir/);
    assert.match(inboxMessage, /\$\(echo x\)/);

    result = run(['close', '--dir', dir, '--id', 'q-1', '--note', '反映済み']);
    assert.equal(result.status, 0, result.stderr);
    const closedBoard = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(closedBoard.items.find((item) => item.id === 'q-1').status, 'closed');
    const index = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    const snapshot = JSON.parse(index.match(/<script id="board-snapshot" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(snapshot.items.find((item) => item.id === 'q-1').status, 'closed');
    const finalBoardSource = await fs.readFile(path.join(dir, 'board.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(finalBoardSource));
    assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => serverProcess.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('表の回答（table）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  let serverProcess;
  try {
    const inboxOutput = path.join(dir, 'inbox.txt');
    const inboxCode = "require('node:fs').appendFileSync(process.argv[1], process.argv.at(-1) + '\\n---\\n')";
    const inbox = JSON.stringify([process.execPath, '-e', inboxCode, inboxOutput]);
    let result = run(['init', '--dir', dir, '--session', '表試験', '--cwd', dir, '--inbox', inbox]);
    assert.equal(result.status, 0, result.stderr);

    const makeItem = (overrides = {}) => ({
      title: '表で確認する',
      sections: [],
      answer: {
        type: 'table',
        columns: ['サービス', '記入欄'],
        rows: [['Supabase', '初期値'], ['AppSheet', '初期値'], ['Cloudflare', '初期値']],
        inputLabel: '入力してください',
        inputPlaceholder: '任意',
        ...overrides,
      },
    });
    const addItem = async (name, item) => {
      const itemPath = path.join(dir, `${name}.json`);
      await fs.writeFile(itemPath, JSON.stringify(item));
      const addResult = run(['add', '--dir', dir, '--file', itemPath]);
      assert.equal(addResult.status, 0, addResult.stderr);
    };

    await addItem('table-1', makeItem());
    let board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    const invalidItems = [
      makeItem({ rows: [['Supabase', '初期値', '余分']] }),
      makeItem({ rows: Array.from({ length: 51 }, (_, index) => [`行${index + 1}`, '']) }),
      makeItem({ columns: Array.from({ length: 7 }, (_, index) => `列${index + 1}`) }),
      makeItem({ inputLabel: 'あ'.repeat(31) }),
      makeItem({ rows: [['   ', '初期値'], ['AppSheet', '初期値'], ['Cloudflare', '初期値']] }),
      makeItem({ recommended: 'Supabase' }),
    ];
    for (const [index, item] of invalidItems.entries()) {
      const itemPath = path.join(dir, `invalid-table-${index}.json`);
      await fs.writeFile(itemPath, JSON.stringify(item));
      result = run(['add', '--dir', dir, '--file', itemPath]);
      assert.notEqual(result.status, 0);
      board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
      assert.equal(board.items.length, 1);
    }
    await addItem('table-2', makeItem({ inputLabel: 'あ'.repeat(30) }));
    await addItem('table-3', makeItem());
    await addItem('table-4', makeItem());

    const server = await startServer(dir);
    serverProcess = server.child;
    const port = server.meta.port;
    let response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: ['  abc\nxyz  ', '   ', '  def  '], note: '' }) });
    assert.equal(response.status, 200, response.body);
    let responseBody = JSON.parse(response.body);
    assert.equal(responseBody.notified, 'queued');
    assert.deepEqual(responseBody.item.response.value, ['abc\nxyz', '', 'def']);
    const firstAnswers = JSON.parse((await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.deepEqual(firstAnswers.value, ['abc\nxyz', '', 'def']);
    const firstInbox = await waitFor(async () => {
      try {
        const text = await fs.readFile(inboxOutput, 'utf8');
        return text.includes('記入 2 / 3 行') ? text : null;
      } catch {
        return null;
      }
    });
    assert.match(firstInbox, /記入 2 \/ 3 行\nSupabase: abc xyz\nCloudflare: def/);
    assert.doesNotMatch(firstInbox, /AppSheet:/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-2', value: ['', '', ''], note: '表に入らない答え' }) });
    assert.equal(response.status, 200, response.body);
    responseBody = JSON.parse(response.body);
    assert.deepEqual(responseBody.item.response.value, ['', '', '']);
    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-3', value: null, note: 'null でも送れる' }) });
    assert.equal(response.status, 200, response.body);
    responseBody = JSON.parse(response.body);
    assert.deepEqual(responseBody.item.response.value, ['', '', '']);
    const inboxAfterNotes = await waitFor(async () => {
      try {
        const text = await fs.readFile(inboxOutput, 'utf8');
        return text.includes('自由記入: 表に入らない答え') && text.includes('自由記入: null でも送れる') ? text : null;
      } catch {
        return null;
      }
    });
    assert.match(inboxAfterNotes, /回答: 記入 0 \/ 3 行\n自由記入: 表に入らない答え/);

    const invalidResponses = [
      { value: ['', '', ''], note: '  ' },
      { value: null, note: '' },
      { value: ['', ''], note: '不正' },
      { value: ['', 1, ''], note: '不正' },
      { value: ['', '', ''], note: '', byRecommendation: true },
    ];
    for (const payload of invalidResponses) {
      response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-4', ...payload }) });
      assert.equal(response.status, 400, response.body);
    }
    const answers = (await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(answers.length, 3);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => serverProcess.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('保存できたら通知を待たずに返す', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  const failedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  const serverProcesses = [];
  try {
    const delayedOutput = path.join(dir, 'delayed-inbox.txt');
    const delayedCode = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], process.argv.at(-1)), 2000)";
    let result = run(['init', '--dir', dir, '--session', '通知試験', '--cwd', dir, '--inbox', JSON.stringify([process.execPath, '-e', delayedCode, delayedOutput])]);
    assert.equal(result.status, 0, result.stderr);
    const itemPath = path.join(dir, 'item.json');
    await fs.writeFile(itemPath, JSON.stringify({ title: '遅い通知', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }] } }));
    result = run(['add', '--dir', dir, '--file', itemPath]);
    assert.equal(result.status, 0, result.stderr);
    const server = await startServer(dir);
    serverProcesses.push(server.child);
    let stdout = '';
    server.child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    const started = Date.now();
    let response = await request(server.meta.port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: 'a', note: '' }) });
    const responseElapsed = Date.now() - started;
    assert.equal(response.status, 200, response.body);
    assert.ok(responseElapsed < 1500, `応答が遅すぎます: ${responseElapsed}ms`);
    assert.equal((await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(fs.access(delayedOutput));
    await waitFor(async () => {
      try { return (await fs.readFile(delayedOutput, 'utf8')).includes('[decision-board]') ? true : null; } catch { return null; }
    });
    await waitFor(() => stdout.startsWith('') && stdout.includes('notify q-1 ok '));

    const failedOutput = path.join(failedDir, 'failed-inbox.txt');
    result = run(['init', '--dir', failedDir, '--session', '失敗通知試験', '--cwd', failedDir, '--inbox', JSON.stringify([process.execPath, '-e', 'process.exit(1)', failedOutput])]);
    assert.equal(result.status, 0, result.stderr);
    const failedItemPath = path.join(failedDir, 'item.json');
    await fs.writeFile(failedItemPath, JSON.stringify({ title: '失敗する通知', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }] } }));
    result = run(['add', '--dir', failedDir, '--file', failedItemPath]);
    assert.equal(result.status, 0, result.stderr);
    const failedServer = await startServer(failedDir);
    serverProcesses.push(failedServer.child);
    let failedStdout = '';
    failedServer.child.stdout.on('data', (chunk) => { failedStdout += chunk.toString(); });
    response = await request(failedServer.meta.port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: 'a', note: '' }) });
    assert.equal(response.status, 200, response.body);
    await waitFor(() => failedStdout.includes('notify q-1 failed: exit 1 '));
  } finally {
    for (const child of serverProcesses) {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(failedDir, { recursive: true, force: true });
  }
});

test('自由記入だけの回答と未回答値の受け入れ', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  let serverProcess;
  try {
    const items = [
      { title: '選択肢への自由記入', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }] } },
      { title: '空の選択肢回答', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }] } },
      { title: '評価への自由記入', sections: [], answer: { type: 'rating', max: 5 } },
      { title: '複数選択の途中値', sections: [], answer: { type: 'multi', min: 2, options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }] } },
      { title: '値キー無しの回答', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }] } },
      { title: '自由記入型', sections: [], answer: { type: 'text' } },
    ];
    let result = run(['init', '--dir', dir, '--session', '自由記入試験', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    for (const [index, item] of items.entries()) {
      const itemPath = path.join(dir, `item-${index + 1}.json`);
      await fs.writeFile(itemPath, JSON.stringify(item));
      result = run(['add', '--dir', dir, '--file', itemPath]);
      assert.equal(result.status, 0, result.stderr);
    }

    const server = await startServer(dir);
    serverProcess = server.child;
    const port = server.meta.port;
    let response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: null, note: '理由だけ書く' }) });
    assert.equal(response.status, 200, response.body);
    let answerResponse = JSON.parse(response.body);
    assert.equal(answerResponse.item.status, 'answered');
    assert.equal(answerResponse.item.response.value, null);
    assert.match(answerResponse.message, /自由記入のみ/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-2', value: null, note: '  ' }) });
    assert.equal(response.status, 400);
    assert.match(response.body, /回答か自由記入を入力してください/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-3', value: null, note: '評価の理由' }) });
    assert.equal(response.status, 200, response.body);
    answerResponse = JSON.parse(response.body);
    assert.equal(answerResponse.item.response.value, null);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-4', value: ['a'], note: '理由あり' }) });
    assert.equal(response.status, 400);
    assert.match(response.body, /選択数が範囲外です/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-5', note: '値は未回答' }) });
    assert.equal(response.status, 200, response.body);
    answerResponse = JSON.parse(response.body);
    assert.equal(answerResponse.item.response.value, null);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-6', value: null, note: '  ' }) });
    assert.equal(response.status, 400);
    assert.match(response.body, /自由記入を入力してください/);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => serverProcess.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('推奨値の検証と推奨送信', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  let serverProcess;
  try {
    let result = run(['init', '--dir', dir, '--session', '推奨試験', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    const invalidItems = [
      { title: '存在しない推奨', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }], recommended: 'missing' } },
      { title: '自由記入の推奨', sections: [], answer: { type: 'text', recommended: '値' } },
      { title: 'null の推奨', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }], recommended: null } },
      { title: '空配列の推奨', sections: [], answer: { type: 'multi', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }], recommended: [] } },
      { title: '重複配列の推奨', sections: [], answer: { type: 'multi', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }], recommended: ['a', 'a'] } },
    ];
    for (const [index, item] of invalidItems.entries()) {
      const itemPath = path.join(dir, `invalid-${index}.json`);
      await fs.writeFile(itemPath, JSON.stringify(item));
      result = run(['add', '--dir', dir, '--file', itemPath]);
      assert.equal(result.status, 2, `${index}: ${result.stderr}`);
    }

    const items = [
      { title: '保存期間', sections: [], answer: { type: 'choice', options: [{ value: '7', label: '7日' }, { value: '30', label: '30日' }], recommended: '30' } },
      { title: '推奨なし', sections: [], answer: { type: 'choice', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }] } },
      { title: '確認画面', sections: [], answer: { type: 'yesno', recommended: false } },
      { title: '複数選択', sections: [], answer: { type: 'multi', options: [{ value: 'a', label: '案A' }, { value: 'b', label: '案B' }], min: 2, recommended: ['a', 'b'] } },
      { title: '自由記入禁止', sections: [], answer: { type: 'choice', options: [{ value: 'x', label: '案X' }, { value: 'z', label: '案Z' }], recommended: 'z' } },
    ];
    for (const [index, item] of items.entries()) {
      const itemPath = path.join(dir, `item-${index}.json`);
      await fs.writeFile(itemPath, JSON.stringify(item));
      result = run(['add', '--dir', dir, '--file', itemPath]);
      assert.equal(result.status, 0, result.stderr);
    }

    const server = await startServer(dir);
    serverProcess = server.child;
    const port = server.meta.port;
    let response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: '30', note: '', byRecommendation: 'true' }) });
    assert.equal(response.status, 400);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: '7', note: '', byRecommendation: true }) });
    assert.equal(response.status, 400);
    assert.match(response.body, /推奨の値と一致しません/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: '30', note: '', byRecommendation: true }) });
    assert.equal(response.status, 200, response.body);
    let answerResponse = JSON.parse(response.body);
    assert.equal(answerResponse.item.response.value, '30');
    assert.equal(answerResponse.item.response.byRecommendation, true);
    assert.match(answerResponse.message, /回答: 30日（推奨をそのまま採用）/);
    assert.match(answerResponse.message, /"byRecommendation":true/);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-2', value: 'a', note: '', byRecommendation: true }) });
    assert.equal(response.status, 400);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-2', value: 'a', note: '' }) });
    assert.equal(response.status, 200, response.body);
    answerResponse = JSON.parse(response.body);
    assert.equal(Object.hasOwn(answerResponse.item.response, 'byRecommendation'), false);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-3', value: false, note: '', byRecommendation: true }) });
    assert.equal(response.status, 200, response.body);
    answerResponse = JSON.parse(response.body);
    assert.equal(answerResponse.item.response.value, false);
    assert.equal(answerResponse.item.response.byRecommendation, true);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-4', value: ['b', 'a'], note: '', byRecommendation: true }) });
    assert.equal(response.status, 200, response.body);

    response = await request(port, '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-5', value: 'z', note: '理由', byRecommendation: true }) });
    assert.equal(response.status, 400);
    assert.match(response.body, /推奨で送るときは自由記入を空にしてください/);

    const board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items.find((item) => item.id === 'q-1').response.byRecommendation, true);
    const records = (await fs.readFile(path.join(dir, 'answers.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.id === 'q-1').byRecommendation, true);
    assert.equal(Object.hasOwn(records.find((record) => record.id === 'q-2'), 'byRecommendation'), false);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => serverProcess.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('公開 URL の許可と受け口比較', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-public-url-'));
  let serverProcess;
  try {
    let result = run(['init', '--dir', dir, '--session', '公開 URL 試験', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    const itemPath = path.join(dir, 'item.json');
    await fs.writeFile(itemPath, JSON.stringify({ title: '公開回答', sections: [], answer: { type: 'yesno' } }));
    result = run(['add', '--dir', dir, '--file', itemPath]);
    assert.equal(result.status, 0, result.stderr);

    const publicArgs = ['--public-url', 'https://board.example.test', '--public-url', 'https://a.example.test', '--public-url', 'https://b.example.test'];
    for (const invalidUrl of ['ftp://x', 'https://u:p@x.example.test', 'https://x.example.test/path', 'https://x.example.test/?q=1']) {
      result = run(['serve', '--dir', dir, '--public-url', invalidUrl]);
      assert.equal(result.status, 2, `${invalidUrl}: ${result.stderr}`);
      assert.match(result.stderr, /使い方/);
    }

    const server = await startServer(dir, publicArgs);
    serverProcess = server.child;
    const port = server.meta.port;
    assert.deepEqual(server.meta.publicUrls, ['https://board.example.test', 'https://a.example.test', 'https://b.example.test']);

    for (const host of ['board.example.test', 'a.example.test', 'b.example.test']) {
      const response = await request(port, '/', { headers: { Host: host } });
      assert.equal(response.status, 200, host);
    }
    let response = await request(port, '/', { headers: { Host: 'evil.example.test' } });
    assert.equal(response.status, 403);
    response = await request(port, '/', { headers: { Host: 'board.example.test.evil.test' } });
    assert.equal(response.status, 403);
    response = await request(port, '/', { headers: { Host: 'evil.board.example.test' } });
    assert.equal(response.status, 403);
    response = await request(port, '/api/answer', { method: 'POST', headers: { Host: 'board.example.test', Origin: 'https://evil.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: true, note: '' }) });
    assert.equal(response.status, 403);
    response = await request(port, '/api/answer', { method: 'POST', headers: { Host: 'board.example.test', Origin: 'https://board.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'q-1', value: true, note: '' }) });
    assert.equal(response.status, 200, response.body);

    result = run(['url', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [server.meta.url, ...publicArgs.filter((value) => value.startsWith('https://'))]);

    result = run(['serve', '--dir', dir, '--public-url', 'https://b.example.test', '--public-url', 'https://board.example.test', '--public-url', 'https://a.example.test']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['serve', '--dir', dir, '--public-url', 'https://other.example.test']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /既に動いています。公開 URL を変えるには stop してから serve し直してください/);
    result = run(['serve', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => serverProcess.once('exit', resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('シンボリックリンク経由の CLI init', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-link-'));
  try {
    const linkedRoot = path.join(dir, 'linked-repository');
    const boardDir = path.join(dir, 'board');
    await fs.symlink(root, linkedRoot, 'dir');
    const linkedScript = path.join(linkedRoot, 'scripts', 'board.mjs');
    const result = spawnSync(process.execPath, [linkedScript, 'init', '--dir', boardDir, '--session', 'リンク試験', '--cwd', dir], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const board = JSON.parse(await fs.readFile(path.join(boardDir, 'board.json'), 'utf8'));
    assert.equal(board.board.session, 'リンク試験');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('区分（group）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-board-'));
  try {
    let result = run(['init', '--dir', dir, '--session', '区分試験', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);

    const baseItem = { title: '区分を試す', sections: [{ type: 'text', md: '確認します。' }], answer: { type: 'yesno' } };
    const basePath = path.join(dir, 'item.json');
    await fs.writeFile(basePath, JSON.stringify(baseItem));
    result = run(['add', '--dir', dir, '--file', basePath]);
    assert.equal(result.status, 0, result.stderr);
    let board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(Object.hasOwn(board.items[0], 'group'), false);

    await fs.writeFile(basePath, JSON.stringify({ ...baseItem, group: '乙' }));
    result = run(['add', '--dir', dir, '--file', basePath, '--group', ' 丙 ']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['add', '--dir', dir, '--file', basePath, '--group', ' 甲 ']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items[1].group, '丙');
    assert.equal(board.items[2].group, '甲');

    const thirty = 'あ'.repeat(30);
    result = run(['add', '--dir', dir, '--file', basePath, '--group', thirty]);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items[3].group, thirty);
    const itemCount = board.items.length;
    result = run(['add', '--dir', dir, '--file', basePath, '--group', 'あ'.repeat(31)]);
    assert.equal(result.status, 2);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items.length, itemCount);
    await fs.writeFile(basePath, JSON.stringify({ ...baseItem, group: null }));
    result = run(['add', '--dir', dir, '--file', basePath]);
    assert.equal(result.status, 2);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items.length, itemCount);

    result = run(['group', '--dir', dir, '--id', 'q-1', '--id', 'q-2', '--group', ' 乙 ']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items.find((item) => item.id === 'q-1').group, '乙');
    assert.equal(board.items.find((item) => item.id === 'q-2').group, '乙');
    const unchanged = await fs.readFile(path.join(dir, 'board.json'), 'utf8');
    result = run(['group', '--dir', dir, '--id', 'q-1', '--id', 'q-99', '--group', '丙']);
    assert.equal(result.status, 1);
    assert.equal(await fs.readFile(path.join(dir, 'board.json'), 'utf8'), unchanged);
    result = run(['group', '--dir', dir, '--id', 'q-1', '--clear']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(Object.hasOwn(board.items.find((item) => item.id === 'q-1'), 'group'), false);
    result = run(['group', '--dir', dir, '--id', 'q-1', '--group', '乙', '--clear']);
    assert.equal(result.status, 2);

    result = run(['groups', '--dir', dir, '--set', '["乙","甲"]']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.deepEqual(board.groups, ['乙', '甲']);
    result = run(['groups', '--dir', dir, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['乙', '甲', thirty, 'その他']);
    result = run(['groups', '--dir', dir, '--set', '["甲","甲"]']);
    assert.equal(result.status, 2);
    result = run(['groups', '--dir', dir, '--set', 'x']);
    assert.equal(result.status, 2);
    result = run(['groups', '--dir', dir, '--set', '[]']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(Object.hasOwn(board, 'groups'), false);

    result = run(['list', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    const groupedLines = result.stdout.trim().split('\n').map((line) => line.split('\t'));
    assert.equal(groupedLines.length, 4);
    assert.equal(groupedLines.every((columns) => columns.length === 4), true);
    assert.equal(groupedLines.find((columns) => columns[0] === 'q-1')[3], 'その他');
    result = run(['group', '--dir', dir, '--id', 'q-1', '--id', 'q-2', '--id', 'q-3', '--id', 'q-4', '--clear']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['list', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').every((line) => line.split('\t').length === 3), true);

    result = run(['close', '--dir', dir, '--id', 'q-1']);
    assert.equal(result.status, 0, result.stderr);
    board = JSON.parse(await fs.readFile(path.join(dir, 'board.json'), 'utf8'));
    assert.equal(board.items.find((item) => item.id === 'q-1').status, 'closed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
