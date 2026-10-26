"""Send a bounded, factual OpenEduLab worker status to Feishu cron."""
import csv
import io
import os
from pathlib import Path
import subprocess

ROOT = Path('G:/hermes/projects/openedulab')
PID = 20864


def is_running(pid: int) -> bool:
    result = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'], capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        return False
    for row in csv.reader(io.StringIO(result.stdout)):
        if len(row) >= 2 and row[1].strip('"') == str(pid):
            return True
    return False


def main() -> None:
    status = (ROOT / 'docs/PROJECT_STATE.md').read_text(encoding='utf-8')
    done = [label for label in ('B3', 'B4', 'B5', 'B6') if f'**{label}（' in status[:2200] and '已完成' in status[:2200].split(f'**{label}（', 1)[1][:120]]
    stage = done[-1] if done else 'B2 或更早（请查项目状态）'
    sha = subprocess.run(['git', '-C', str(ROOT), 'log', '-1', '--format=%h %s'], capture_output=True, text=True).stdout.strip() or '未知'
    running = is_running(PID)
    state = '仍在运行' if running else '进程已结束；需要核验最终产物/阻塞后决定是否续跑'
    print(f'OpenEduLab 定时进度：{state}（PID {PID}）。\n已记录完成关口：{stage}；当前提交：{sha}。\n下一工序与测试证据见 docs/PROJECT_STATE.md。本地任务，未获批准不部署生产。')


if __name__ == '__main__':
    main()
