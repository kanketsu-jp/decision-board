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

async function startServer(dir) {
  const child = spawn(process.execPath, [script, 'serve', '--dir', dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
