"""Manager-side adapter to the original Deployment JS planner. NEVER executes Docker.

Not imported by the Web app. Node runs only the fixed local pure planner bridge;
returned executable/argv are data. Real execution, realpath/filesystem validation,
container inspection, log scrubbing and failure recovery remain separate work.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


class PlanningFailure(Exception):
    pass


class NodeComposePlanner:
    def __init__(self):
        self.node = shutil.which('node', path=os.defpath)
        self.bridge = Path(__file__).resolve().parent.parent / 'manager' / 'compose-planner' / 'plan-stdio.mjs'

    def plan(self, registry, request):
        payload = json.dumps({'registry': registry, 'request': request}, allow_nan=False).encode()
        if not self.node or len(payload) > 131072:
            raise PlanningFailure('Node planner unavailable or input exceeds bound')
        try:
            result = subprocess.run([self.node, str(self.bridge)], input=payload, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, shell=False, timeout=3, check=False,
                                    env={'PATH': os.defpath}, cwd=self.bridge.parent)
            if result.returncode or len(result.stdout) > 32768:
                raise PlanningFailure('Planner failed')
            plan = json.loads(result.stdout)
            if not isinstance(plan, dict) or type(plan.get('ok')) is not bool:
                raise ValueError()
            return plan
        except (OSError, subprocess.SubprocessError, ValueError):
            raise PlanningFailure('Planner unavailable or failed') from None


def main():
    # Input may contain private operator paths: never echo it on failure.
    try:
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError()
        data = json.loads(raw)
        result = NodeComposePlanner().plan(data['registry'], data['request'])
    except (ValueError, TypeError, KeyError, PlanningFailure):
        result = {'ok': False, 'error': {'code': 'planner_failure', 'message': 'Invalid or unavailable planner'}}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
