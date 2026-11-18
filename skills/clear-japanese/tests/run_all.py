#!/usr/bin/env python3
"""tests/ の中の試験を全部実行する。pytest は要らない。

使い方:
    python3 tests/run_all.py

実行する物は3種類ある。
- unittest のクラス（test_*.py の中の TestCase）
- 関数だけで書かれた試験（test_*.py の中の、クラスに入っていない test_ で始まる関数）
- 自分で件数を数えて終了コードを返す試験（test_scripts.py、test_trim_commas.py）

1つでも失敗したら、終了コード1で終わる。
"""
import importlib
import inspect
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
STANDALONE = ("test_scripts.py", "test_trim_commas.py")


def main():
    failed = 0
    total = 0

    suite = unittest.defaultTestLoader.discover(HERE, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=0).run(suite)
    total += result.testsRun
    failed += len(result.failures) + len(result.errors)
    print(f"unittest: {result.testsRun}件中 {len(result.failures) + len(result.errors)}件失敗")

    names = sorted(f[:-3] for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".py"))
    count = bad = 0
    for name in names:
        module = importlib.import_module(name)
        for fname, func in inspect.getmembers(module, inspect.isfunction):
            if not fname.startswith("test_") or func.__module__ != name:
                continue
            count += 1
            try:
                func()
            except Exception as e:  # noqa: BLE001
                bad += 1
                print(f"NG {name}.{fname}: {type(e).__name__}: {e}")
    total += count
    failed += bad
    print(f"関数の試験: {count}件中 {bad}件失敗")

    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    for script in STANDALONE:
        r = subprocess.run([sys.executable, os.path.join(HERE, script)], capture_output=True, text=True, encoding="utf-8", env=env)
        out = r.stdout.strip()
        last = out.splitlines()[-1] if out else ""
        m = re.match(r"(\d+)/(\d+) OK$", last)
        if m:
            ok, n = int(m.group(1)), int(m.group(2))
        else:  # 件数を読めない時は、1件の失敗として数える
            ok, n = 0, 1
        if r.returncode != 0 and ok == n:
            ok = n - 1
        total += n
        failed += n - ok
        print(f"{script}: {n}件中 {n - ok}件失敗（終了コード {r.returncode}）")
        if n - ok:
            print(out)

    print(f"合計: {total}件中 {failed}件失敗")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
