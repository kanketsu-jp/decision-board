import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'board.mjs');
const args = [...process.argv.slice(2)];
let dir = path.join(root, '.temp', 'bord-demo');
let open = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--dir') dir = path.resolve(args[++index]);
  else if (args[index] === '--open') open = true;
  else throw new Error(`不明な引数です: ${args[index]}`);
}

function run(commandArgs) {
  const result = spawnSync(process.execPath, [script, ...commandArgs], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await fs.mkdir(dir, { recursive: true });
run(['init', '--dir', dir, '--session', 'デモ: 判断ボード', '--cwd', root]);
const itemDir = path.join(root, 'examples', 'items');
for (const file of (await fs.readdir(itemDir)).filter((name) => name.endsWith('.json')).sort()) run(['add', '--dir', dir, '--file', path.join(itemDir, file)]);
const readDir = path.join(root, 'examples', 'reads');
for (const file of (await fs.readdir(readDir)).filter((name) => name.endsWith('.md')).sort()) {
  const source = await fs.readFile(path.join(readDir, file), 'utf8');
  const heading = source.match(/^ {0,3}#(?!#)\s+(.+?)\s*$/m)?.[1].trim();
  const title = heading || file.replace(/\.md$/i, '');
  run(['read', '--dir', dir, '--file', path.join(readDir, file), '--title', title]);
}
if (open) run(['serve', '--dir', dir, '--open']);
