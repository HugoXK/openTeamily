"""Isolated loopback demo of management + fake model provider + FlyBot agent.

Binds only 127.0.0.1. Throwaway data. The fake provider is not a real vendor.
Do not print passwords or runtime keys. Not for production.
"""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import time

from .app import App, Config
from .store import Store
from tests.test_management import Client
from tests.test_runtime_infer import SECRET, start_fake_provider


README = '''OpenTeamily 本地自动化演示（仅 127.0.0.1）

地址：{origin}/automations
管理服务 PID：{server_pid}
FlyBot 代理 PID：{agent_pid}
演示监督进程 PID：{demo_pid}
数据目录：{data_dir}

登录
- 用户名见本目录 login 文件中的 username。
- 密码只写在 login 文件里（权限 0600），请在本机打开该文件，不要把它贴到聊天里。
- 这是一次性测试账号，不是生产凭据。

建议操作
1. 用浏览器打开上面的地址，用 login 文件里的账号登录。
2. 打开「本地演示简报」。若代理已跑完，下方「运行记录」会显示假提供方返回的文本。
3. 也可以新建一条「立即运行」的自动化并启用，观察运行记录更新。
4. 运行时页 {origin}/runtimes 可以看到本机代理是否在线。
5. 若要取消一次排队中的运行，先停掉代理再点「取消这次运行」。

说明
- 模型调用走的是本机循环上的假 OpenAI 兼容提供方，不能当成真实厂商已经验证。
- 管理服务、提供方和代理都绑在 127.0.0.1，不会改防火墙或代理。
- 结束后请结束本监督进程（它会带走子进程）。
'''


def _free_port(preferred):
    import socket
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError('No free loopback port')


def _write_private(path, text):
    path = Path(path)
    path.write_text(text)
    os.chmod(path, 0o600)


def seed(data_dir, origin, provider_base, password):
    store = Store(data_dir / 'state')
    app = App(store, Config(origin, insecure_local=True, allow_registration=True), clock=time.time)
    client = Client(app)
    host = origin.split('://', 1)[1]
    original = client.call

    def call(method, path, body=None, headers=None, **kw):
        extra = {'HTTP_HOST': host}
        extra.update(headers or {})
        return original(method, path, body, extra, **kw, origin=origin)

    client.call = call
    created = client.call('POST', '/v1/auth/register', {'username': 'demo', 'password': password})
    if created['status'] not in (200, 201):
        raise RuntimeError('Cannot create the throwaway demo user')
    logged = client.call('POST', '/v1/auth/login', {'username': 'demo', 'password': password})
    if logged['status'] != 200:
        raise RuntimeError('Cannot sign in the throwaway demo user')
    saved = client.call('POST', '/v1/model-api', {
        'revision': 0,
        'changes': {'provider': 'openai', 'base_url': provider_base, 'model': 'fake-model', 'api_key': SECRET},
    })
    if saved['status'] != 200:
        raise RuntimeError('Cannot configure the loopback model API')
    space = client.workspace()
    if space['status'] not in (200, 201):
        raise RuntimeError('Cannot create a demo workspace')
    wid = space['body']['workspace']['id']
    automation = client.call('POST', f'/v1/workspaces/{wid}/automations', {
        'title': '本地演示简报',
        'prompt': '用一句话写一份演示简报。',
        'template_id': 'custom',
        'schedule': {'kind': 'now', 'time_zone': 'Asia/Shanghai'},
        'participants': ['demo'],
    }, {'HTTP_IDEMPOTENCY_KEY': 'demo-automation-0001'})
    if automation['status'] != 201:
        raise RuntimeError('Cannot create the demo automation')
    aid = automation['body']['automation']['id']
    enabled = client.call('POST', f'/v1/workspaces/{wid}/automations/{aid}',
                          {'revision': 1, 'changes': {'enabled': True}})
    if enabled['status'] != 200:
        raise RuntimeError('Cannot enable the demo automation')
    issued = client.call('POST', '/v1/runtime-keys', {'name': 'demo-desk'})
    if issued['status'] not in (200, 201):
        raise RuntimeError('Cannot issue a demo runtime key')
    return issued['body']['token']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default='/tmp/openteamily-lane2-demo-automations')
    parser.add_argument('--port', type=int, default=18765)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    data_dir = Path(args.data_dir)
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, mode=0o700)
    port = _free_port(args.port)
    origin = f'http://127.0.0.1:{port}'
    provider, provider_thread, _seen = start_fake_provider(SECRET, '这是假提供方返回的演示简报。')
    provider_base = 'http://127.0.0.1:%s/v1' % provider.server_address[1]
    password = secrets.token_urlsafe(18)
    _write_private(data_dir / 'login', 'username=demo\npassword=%s\n' % password)
    token = seed(data_dir, origin, provider_base, password)
    _write_private(data_dir / 'runtime-key', token + '\n')
    env = os.environ.copy()
    root = str(Path(__file__).resolve().parents[1])
    env['PYTHONPATH'] = root + ((':' + env['PYTHONPATH']) if env.get('PYTHONPATH') else '')
    server = subprocess.Popen(
        [sys.executable, '-m', 'openteamily.server', '--data-dir', str(data_dir / 'state'),
         '--origin', origin, '--port', str(port), '--insecure-local'],
        cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # Give the server a moment, then start the agent so the first slot is not lost.
    time.sleep(0.4)
    agent = subprocess.Popen(
        [sys.executable, '-m', 'openteamily.flybot', 'daemon', 'start',
         '--origin', origin, '--key-file', str(data_dir / 'runtime-key'),
         '--hostname', 'demo-desk', '--poll', '0.5'],
        cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    (data_dir / 'server.pid').write_text(str(server.pid) + '\n')
    (data_dir / 'agent.pid').write_text(str(agent.pid) + '\n')
    (data_dir / 'demo.pid').write_text(str(os.getpid()) + '\n')
    (data_dir / 'README.txt').write_text(README.format(
        origin=origin, server_pid=server.pid, agent_pid=agent.pid,
        demo_pid=os.getpid(), data_dir=str(data_dir),
    ))
    print('Demo listening at %s/automations; details in %s' % (origin, data_dir / 'README.txt'), flush=True)

    def shutdown(*_args):
        for process in (agent, server):
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        for process in (agent, server):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        provider.shutdown()
        provider_thread.join(3)
        provider.server_close()

    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    try:
        while True:
            if server.poll() is not None or agent.poll() is not None:
                raise SystemExit(1)
            time.sleep(1)
    finally:
        shutdown()


if __name__ == '__main__':
    main()
