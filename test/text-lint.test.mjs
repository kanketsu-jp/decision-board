import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lintScript = path.join(root, 'scripts', 'text_lint.py');

const baseItem = {
  title: '公開前の確認を入れるか',
  sections: [{ type: 'text', md: '確認します。' }],
  answer: { type: 'yesno' },
};

async function runLint(item) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bord-lint-'));
  const itemPath = path.join(dir, 'item.json');
  await fs.writeFile(itemPath, JSON.stringify(item));
  return spawnSync('python3', [lintScript, '--item', itemPath], { encoding: 'utf8' });
}

test('土台の item は lint のエラー 0 件になる', async () => {
  const result = await runLint(baseItem);
  assert.equal(result.status, 0, result.stderr);
});

test('group の文字列は文面の lint 対象外になる', async () => {
  const result = await runLint({
    ...baseItem,
    group: 'NE で注文するアプリをモノレポとして作る件',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('answer.type が不正なら lint がエラーになる', async () => {
  const result = await runLint({
    ...baseItem,
    answer: { type: 'bogus' },
  });
  assert.equal(result.status, 1, result.stdout);
});

test('group に文面ならエラーになる文字列を置いても lint はエラーにならない', async () => {
  const titleResult = await runLint({ ...baseItem, title: '回答は不要です' });
  assert.equal(titleResult.status, 1, titleResult.stdout);
  assert.match(titleResult.stdout, /answer_not_required|回答は不要/);

  const groupResult = await runLint({
    ...baseItem,
    group: '回答は不要です',
  });
  assert.equal(groupResult.status, 0, groupResult.stderr);
});
