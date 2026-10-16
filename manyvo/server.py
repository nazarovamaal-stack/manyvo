"""Same-origin JSON API and static UI. Python 3.9+, no external dependencies."""
import argparse
from collections import defaultdict, deque
import getpass
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import ssl
import threading
import time
from urllib.parse import urlsplit

from .core import Problem, Store, require
from .moderation import DemoModerator, OpenAIModerator
from .seed import ACCOUNTS, seed

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if re.fullmatch(r'[A-Z_][A-Z_0-9]*', key.strip()):
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, address, store, demo=False, tls=False, show_demo=False):
        self.store, self.demo, self.tls, self.show_demo = store, demo, tls, show_demo
        self.login_attempts, self.login_lock = defaultdict(deque), threading.Lock()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Manyvo'

    def log_message(self, fmt, *args):
        # Do not record request bodies, query strings, cookies, or API credentials.
        pass

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except Exception:
            return ''
        return cookie['manyvo_session'].value if 'manyvo_session' in cookie else ''

    def send(self, status, body, content_type='application/json; charset=utf-8', cookie=None):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if self.server.tls:
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'Ожидается JSON.', 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise Problem('Неверный размер запроса.')
        require(0 < length <= 37 * 1024 * 1024, 'Слишком большой запрос.', 413)
        try:
            payload = json.loads(self.rfile.read(length), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, UnicodeError):
            raise Problem('Некорректный JSON.')
        require(isinstance(payload, dict), 'Ожидается объект JSON.')
        return payload

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_PUT(self):
        self.dispatch('PUT')

    def dispatch(self, method):
        try:
            host = self.headers.get('Host', '')
            allowed = {'localhost', '127.0.0.1', self.server.server_name}
            allowed.update(h.strip() for h in os.getenv('MANYVO_ALLOWED_HOSTS', '').split(',') if h.strip())
            require(host.split(':')[0] in allowed, 'Недопустимый адрес сервера.', 400)
            path = urlsplit(self.path).path
            if not path.startswith('/api/'):
                require(method == 'GET', 'Метод не поддерживается.', 405)
                assets = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg'}
                require(path in assets, 'Страница не найдена.', 404)
                asset = ROOT / 'static' / assets[path]
                return self.send(200, asset.read_bytes(), (mimetypes.guess_type(asset.name)[0] or 'application/octet-stream') + '; charset=utf-8')
            if method == 'GET' and path == '/api/config':
                return self.send(200, {'demo': self.server.demo, 'moderation': self.server.store.moderator.provider,
                                       'openai_configured': bool(os.getenv('OPENAI_API_KEY')), 'demo_accounts': [{'email': a[0], 'name': a[1], 'role': a[2]} for a in ACCOUNTS] if self.server.show_demo else []})
            if method != 'GET':
                origin = self.headers.get('Origin')
                require(not origin or origin == ('https://' if self.server.tls else 'http://') + host, 'Запрос с другого сайта запрещён.', 403)
                require(self.headers.get('X-Manyvo-Client') == 'web', 'Некорректный клиент.', 403)
                payload = self.read_json()
            if method == 'POST' and path == '/api/login':
                with self.server.login_lock:
                    attempts = self.server.login_attempts[self.client_address[0]]
                    while attempts and attempts[0] < time.time()-60:
                        attempts.popleft()
                    require(len(attempts) < 30, 'Слишком много попыток входа. Подождите минуту.', 429)
                    attempts.append(time.time())
                token, csrf = self.server.store.login(payload.get('email'), payload.get('password'))
                cookie = 'manyvo_session=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400%s' % (token, '; Secure' if self.server.tls else '')
                return self.send(200, {'csrf': csrf}, cookie=cookie)
            user = self.server.store.session(self.token())
            if method != 'GET':
                import hmac
                require(hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf']), 'Обновите страницу и повторите действие.', 403)
            if method == 'GET' and path == '/api/me':
                return self.send(200, self.server.store.me(user) | {'csrf': user['csrf']})
            if method == 'POST' and path == '/api/logout':
                self.server.store.logout(self.token())
                return self.send(200, {'ok': True}, cookie='manyvo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + ('; Secure' if self.server.tls else ''))
            if path == '/api/studies' and method == 'GET':
                return self.send(200, {'studies': self.server.store.listing(user)})
            if path == '/api/studies' and method == 'POST':
                return self.send(201, self.server.store.create(user))
            if path == '/api/history' and method == 'GET':
                return self.send(200, {'history': self.server.store.history(user)})
            if path == '/api/metrics' and method == 'GET':
                return self.send(200, self.server.store.metrics(user))
            match = re.fullmatch(r'/api/studies/([a-f0-9]{32})(?:/(publish|answer|fact))?', path)
            require(match is not None, 'Маршрут не найден.', 404)
            study_id, action = match.groups()
            if action is None and method == 'GET':
                result = self.server.store.detail(user, study_id, opened=True)
            elif action is None and method == 'PUT':
                result = self.server.store.save(user, study_id, payload)
            elif action == 'publish' and method == 'POST':
                result = self.server.store.publish(user, study_id)
            elif action == 'answer' and method == 'POST':
                result = self.server.store.answer(user, study_id, payload)
            elif action == 'fact' and method == 'POST':
                result = self.server.store.save_fact(user, study_id, payload)
            else:
                raise Problem('Метод не поддерживается.', 405)
            return self.send(200, result)
        except Problem as error:
            self.send(error.status, {'error': error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print('Request failed: ' + type(error).__name__, flush=True)
            self.send(500, {'error': 'Не удалось выполнить действие. Попробуйте ещё раз.'})


def main():
    load_env()
    parser = argparse.ArgumentParser(description='Manyvo MVP')
    parser.add_argument('--demo', action='store_true', help='Explicit offline moderation for local demonstrations')
    parser.add_argument('--seed-demo', action='store_true', help='Add demo accounts and example studies to an empty database')
    parser.add_argument('--port', type=int, default=int(os.getenv('MANYVO_PORT', '8000')))
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--db', default=os.getenv('MANYVO_DB', str(ROOT / 'data/manyvo.sqlite3')))
    parser.add_argument('--cert', help='TLS certificate PEM')
    parser.add_argument('--key', help='TLS private key PEM')
    parser.add_argument('--create-user', action='store_true', help='Interactively create an account without registration UI')
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error('--cert and --key must be used together')
    if not args.cert and args.host not in ('127.0.0.1', 'localhost'):
        parser.error('HTTP is permitted only on loopback for local development. Use --cert and --key for a shared server.')
    if args.demo and args.host not in ('127.0.0.1', 'localhost'):
        parser.error('Offline demo mode is local only.')
    store = Store(args.db, DemoModerator() if args.demo else OpenAIModerator())
    if args.create_user:
        email = input('Email: ').strip()
        name = input('Name: ').strip()
        role = input('Role (owner/participant): ').strip()
        age = int(input('Age: '))
        country = input('Country: ').strip()
        store.add_user(email, name, role, age, country, getpass.getpass('Password (10+ characters): '))
        print('Account created.')
        return
    if args.seed_demo:
        seed(store)
    store.settle()
    server = AppServer((args.host, args.port), store, args.demo, bool(args.cert), args.seed_demo)
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    stopped = threading.Event()
    def worker():
        while not stopped.wait(1):
            try:
                store.settle()
            except Exception as error:
                print('Settlement retry: ' + type(error).__name__, flush=True)
    threading.Thread(target=worker, daemon=True).start()
    print('Manyvo: %s://%s:%s | moderation=%s' % ('https' if args.cert else 'http', args.host, args.port, store.moderator.provider), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        server.server_close()


if __name__ == '__main__':
    main()
