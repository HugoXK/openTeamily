#!/usr/bin/env python3
"""TEMPORARY TEST STUB, NOT DOCKER. Only filesystem state; no images or containers."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[5:]  # --host VALUE --config VALUE
root = Path(sys.argv[4]).parent
statefile, controlsfile = root / 'stub-engine.json', root / 'stub-controls.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
ctrl = json.loads(controlsfile.read_text()) if controlsfile.exists() else {}

def save():
    statefile.write_text(json.dumps(state))

def emit(value):
    print(json.dumps(value))

if args[:2] == ['volume', 'ls']:
    if state.get('volume'):
        print(state['project'])
elif args[:2] == ['volume', 'inspect']:
    emit([{'Name': args[2], 'Driver': 'local', 'Scope': 'local', 'Options': {'device': '/untrusted'} if ctrl.get('volume_driver_options') else None, 'Labels': {'com.docker.compose.project': 'wrong' if ctrl.get('wrong_volume') else args[2], 'com.docker.compose.volume': 'data'}}])
elif args[0] == 'inspect':
    iid = state['project'][3:]
    manifest = json.loads((root / ('compose-' + iid + '.json')).read_text())
    running = state['running']
    emit([{'Id': args[-1], 'Config': {'Image': manifest['services']['flybot']['image'], 'User': '1000:1000',
           'Labels': {'com.docker.compose.project': 'wrong' if ctrl.get('wrong_project') else state['project'], 'com.docker.compose.service': 'flybot'}},
           'HostConfig': {'Privileged': bool(ctrl.get('privileged')), 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                          'SecurityOpt': ['no-new-privileges:true'], 'IpcMode': 'private', 'NetworkMode': state['project'] + '_default', 'PortBindings': {}},
           'State': {'Status': 'running' if running else 'exited', 'Running': running, 'Paused': False, 'Restarting': False,
                     'StartedAt': '2026-11-16T00:00:00.' + str(state.get('generation', 0)).zfill(9) + 'Z',
                     'Health': {'Status': 'starting' if ctrl.get('not_ready') else 'healthy'}},
           'Mounts': [{'Type': 'volume', 'Name': state['project'], 'Destination': '/data', 'RW': True}]}])
elif args[0] == 'compose':
    project = args[args.index('-p') + 1]
    verb = args[args.index('-p') + 2]
    if verb in ('create', 'up', 'stop', 'restart'):
        if verb == 'up':
            time.sleep(ctrl.get('start_delay', 0))
        state.setdefault('id', hashlib.sha256(project.encode()).hexdigest())
        state.update(project=project, volume=True, env_keys=sorted(os.environ))
        state.setdefault('sentinel', 'persistent-test-content')
        if verb in ('up', 'restart'):
            if not ctrl.get('unchanged_identity') or not state.get('generation'):
                state['generation'] = state.get('generation', 0) + 1
            state['running'] = True
        else:
            state['running'] = False
        save()
    elif verb == 'ps':
        if state.get('id'):
            print(state['id'])
    elif verb == 'logs':
        time.sleep(ctrl.get('log_delay', 0))
        if ctrl.get('log_bytes'):
            print('x' * ctrl['log_bytes'])
        else:
            print('stub only {"password":"synthetic-password","token":"synthetic-token"} Bearer manager.synthetic-bearer')
    else:
        raise SystemExit(61)
else:
    raise SystemExit(62)
