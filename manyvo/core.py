"""Domain rules from FR-01…FR-12. SQLite transactions serialize quota/points writes."""
import base64
import binascii
from contextlib import contextmanager, closing
from datetime import date
import hashlib
import hmac
import json
import math
from pathlib import Path
import secrets
import sqlite3
import time
import uuid

from .moderation import ModerationUnavailable


def uid():
    return uuid.uuid4().hex


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status
        super().__init__(message)


def require(condition, message, status=400):
    if not condition:
        raise Problem(message, status)


def text(value, label, limit=500):
    require(isinstance(value, str), label + ': ожидается текст.')
    require(len(value) <= limit, label + ': максимум %d символов.' % limit)
    return value.strip()


def integer(value, label, low, high, optional=True):
    if optional and (value is None or value == ''):
        return None
    require(type(value) is int and low <= value <= high, '%s: целое число от %d до %d.' % (label, low, high))
    return value


def image_data(value):
    if value in (None, ''):
        return None
    require(isinstance(value, str), 'Неверное изображение.')
    prefixes = {'data:image/png;base64,': b'\x89PNG\r\n\x1a\n', 'data:image/jpeg;base64,': b'\xff\xd8\xff'}
    prefix = next((p for p in prefixes if value.startswith(p)), None)
    require(prefix is not None, 'Разрешены только PNG и JPEG.')
    require(len(value) <= 7 * 1024 * 1024, 'Изображение больше 5 МБ.')
    try:
        raw = base64.b64decode(value[len(prefix):], validate=True)
    except (ValueError, binascii.Error):
        raise Problem('Повреждённое изображение.')
    require(len(raw) <= 5 * 1024 * 1024 and raw.startswith(prefixes[prefix]), 'Неверный формат или размер изображения.')
    if prefix == 'data:image/png;base64,':
        require(len(raw) >= 45 and raw[12:16] == b'IHDR' and b'IEND' in raw[-16:], 'Повреждённый PNG.')
    else:
        require(len(raw) >= 20 and raw.endswith(b'\xff\xd9'), 'Повреждённый JPEG.')
    return value


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 210000).hex()
    return salt + ':' + digest


class Store:
    def __init__(self, path, moderator, clock=time.time):
        self.path, self.moderator, self.clock = str(path), moderator, clock
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as db:
            db.executescript(Path(__file__).with_name('schema.sql').read_text())

    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=15000')
        return db

    @contextmanager
    def tx(self):
        db = self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def add_user(self, email, name, role, age, country, password):
        require(role in ('owner', 'participant'), 'Неверная роль.')
        require(len(password) >= 10, 'Пароль должен содержать минимум 10 символов.')
        user_id = uid()
        with self.tx() as db:
            db.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',
                       (user_id, email.lower().strip(), name, role, age, country, password_hash(password)))
        return user_id

    def login(self, email, password):
        require(isinstance(email, str) and isinstance(password, str), 'Введите почту и пароль.')
        with self.tx() as db:
            row = db.execute('SELECT * FROM users WHERE email=?', (email.strip().lower(),)).fetchone()
            encoded = row['password_hash'] if row else password_hash('invalid-password', 'dummy-salt')
            require(hmac.compare_digest(password_hash(password, encoded.split(':')[0]), encoded) and row is not None,
                    'Неверная почта или пароль.', 401)
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
            db.execute('DELETE FROM sessions WHERE expires_at<?', (self.clock(),))
            db.execute('INSERT INTO sessions VALUES (?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), row['id'], csrf, self.clock()+86400))
            return token, csrf

    def session(self, token):
        with closing(self.connect()) as db:
            row = db.execute('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?',
                             (hashlib.sha256(token.encode()).hexdigest(), self.clock())).fetchone()
            require(row is not None, 'Войдите в аккаунт.', 401)
            return dict(row)

    def logout(self, token):
        with self.tx() as db:
            db.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def user(self, user_id):
        with closing(self.connect()) as db:
            row = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
            require(row is not None, 'Аккаунт не найден.', 401)
            return dict(row)

    def me(self, user):
        with closing(self.connect()) as db:
            balance = db.execute('SELECT COALESCE(SUM(amount),0) FROM ledger WHERE user_id=?', (user['id'],)).fetchone()[0]
        return {key: user[key] for key in ['id', 'name', 'email', 'role', 'age', 'country']} | {'balance': balance}

    def event(self, db, event_type, study_id, user_id=None, version=None):
        anonymous = hashlib.sha256(('manyvo:' + user_id).encode()).hexdigest() if user_id else None
        db.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)', (uid(), event_type, study_id, anonymous, self.clock(), version))

    def study(self, db, study_id):
        row = db.execute('SELECT * FROM studies WHERE id=?', (study_id,)).fetchone()
        require(row is not None, 'Исследование не найдено.', 404)
        return dict(row)

    def owner(self, user, study):
        require(user['role'] == 'owner' and study['owner_id'] == user['id'], 'Нет доступа к исследованию.', 403)

    def eligible(self, user, study):
        return (user['role'] == 'participant' and user['id'] != study['owner_id'] and type(user['age']) is int
                and user['age'] >= 18 and user['country'] and user['country'] == study['country']
                and study['age_min'] <= user['age'] <= study['age_max'])

    def create(self, user):
        require(user['role'] == 'owner', 'Создавать исследования может заказчик.', 403)
        study_id = uid()
        with self.tx() as db:
            db.execute('INSERT INTO studies(id,owner_id,created_at) VALUES (?,?,?)', (study_id, user['id'], self.clock()))
        return self.detail(user, study_id)

    def save(self, user, study_id, payload):
        title = text(payload.get('title', ''), 'Название', 120)
        question = text(payload.get('question', ''), 'Вопрос')
        quota = integer(payload.get('quota'), 'Квота', 2, 500)
        minimum = integer(payload.get('age_min'), 'Минимальный возраст', 18, 120)
        maximum = integer(payload.get('age_max'), 'Максимальный возраст', 18, 120)
        require(minimum is None or maximum is None or minimum <= maximum, 'Проверьте диапазон возраста.')
        country = text(payload.get('country', ''), 'Страна', 80)
        options = payload.get('options', [])
        require(isinstance(options, list) and len(options) <= 5, 'Допускается до 5 вариантов.')
        normalized = []
        for option in options:
            require(isinstance(option, dict), 'Неверный вариант.')
            normalized.append((text(option.get('text', ''), 'Вариант'), image_data(option.get('image'))))
        with self.tx() as db:
            study = self.study(db, study_id)
            self.owner(user, study)
            require(study['status'] == 'draft', 'Редактировать можно только черновик.', 409)
            require(type(payload.get('version')) is int and payload['version'] == study['version'], 'Черновик изменён в другой вкладке. Обновите страницу.', 409)
            db.execute('UPDATE studies SET title=?,question=?,quota=?,age_min=?,age_max=?,country=?,version=version+1,moderation_reason=? WHERE id=?',
                       (title, question, quota, minimum, maximum, country, '', study_id))
            db.execute('DELETE FROM options WHERE study_id=?', (study_id,))
            for position, (value, image) in enumerate(normalized):
                db.execute('INSERT INTO options VALUES (?,?,?,?,?)', (uid(), study_id, position, value, image))
        return self.detail(user, study_id)

    def publish(self, user, study_id):
        with self.tx() as db:
            study = self.study(db, study_id)
            self.owner(user, study)
            require(study['status'] == 'draft', 'Опубликовать можно только черновик.', 409)
            options = [dict(r) for r in db.execute('SELECT * FROM options WHERE study_id=? ORDER BY position', (study_id,))]
            require(study['title'] and study['question'] and study['country'] and study['age_min'] is not None and study['age_max'] is not None,
                    'Заполните название, вопрос, страну и диапазон возраста.')
            require(2 <= len(options) <= 5 and all(o['text'] or o['image'] for o in options), 'Заполните от 2 до 5 вариантов.')
            db.execute("UPDATE studies SET status='moderating',moderation_started=?,moderation_reason='' WHERE id=?", (self.clock(), study_id))
        try:
            allowed, reason = self.moderator.check(study, options)
        except ModerationUnavailable as error:
            allowed, reason = False, str(error)
        except Exception:
            allowed, reason = False, 'Сервис модерации недоступен. Попробуйте позже.'
        with self.tx() as db:
            current = self.study(db, study_id)
            # Ignore expired approvals, including those arriving after recovery or a newer edit.
            if current['status'] == 'moderating' and current['version'] == study['version']:
                if allowed:
                    now = self.clock()
                    db.execute("UPDATE studies SET status='open',quota=COALESCE(quota,50),published_at=?,deadline=?,moderation_provider=? WHERE id=?",
                               (now, now+86400, self.moderator.provider, study_id))
                    self.event(db, 'published', study_id)
                else:
                    db.execute("UPDATE studies SET status='draft',moderation_reason=?,moderation_provider=? WHERE id=?",
                               (reason, self.moderator.provider, study_id))
        return self.detail(user, study_id)

    def distribution(self, db, study_id, column):
        assert column in ('personal_id', 'prediction_id')
        rows = db.execute('SELECT %s,COUNT(*) FROM answers WHERE study_id=? GROUP BY %s' % (column, column), (study_id,)).fetchall()
        counts = {r[0]: r[1] for r in rows}
        total = sum(counts.values())
        if not total:
            return [], []
        options = db.execute('SELECT id,text,position FROM options WHERE study_id=? ORDER BY position', (study_id,)).fetchall()
        result = [{'id': o['id'], 'text': o['text'], 'position': o['position'], 'count': counts.get(o['id'], 0),
                   'percent': round(100 * counts.get(o['id'], 0) / total, 1)} for o in options]
        maximum = max(counts.values())
        return result, [o['id'] for o in result if o['count'] == maximum]

    def award(self, db, study_id, user_id, kind):
        db.execute('INSERT OR IGNORE INTO ledger VALUES (?,?,?,?,?,?)', (uid(), user_id, study_id, kind, 1, self.clock()))

    def close(self, db, study):
        if study['status'] != 'open':
            return
        count = db.execute('SELECT COUNT(*) FROM answers WHERE study_id=?', (study['id'],)).fetchone()[0]
        if count < study['quota'] and self.clock() < study['deadline']:
            return
        db.execute("UPDATE studies SET status='closed',closed_at=?,closure_reason=? WHERE id=?", (self.clock(), 'quota' if count >= study['quota'] else 'deadline', study['id']))
        _, winners = self.distribution(db, study['id'], 'personal_id')
        for answer in db.execute('SELECT * FROM answers WHERE study_id=?', (study['id'],)):
            if answer['prediction_id'] in winners:
                self.award(db, study['id'], answer['user_id'], 'bonus')
        self.event(db, 'closed', study['id'])

    def settle(self):
        with self.tx() as db:
            for row in db.execute("SELECT * FROM studies WHERE status='open'").fetchall():
                self.close(db, dict(row))
            db.execute("UPDATE studies SET status='draft',version=version+1,moderation_reason='Проверка прервана. Отправьте материалы заново.' WHERE status='moderating' AND moderation_started<?", (self.clock()-120,))

    def answer(self, user, study_id, payload):
        require(user['role'] == 'participant', 'Отвечать может участник.', 403)
        self.settle()
        with self.tx() as db:
            study = self.study(db, study_id)
            require(self.eligible(user, study), 'Исследование недоступно вашему профилю.', 403)
            previous = db.execute('SELECT * FROM answers WHERE study_id=? AND user_id=?', (study_id, user['id'])).fetchone()
            if previous is None:
                require(study['status'] == 'open' and self.clock() < study['deadline'], 'Сбор ответов завершён.', 409)
                count = db.execute('SELECT COUNT(*) FROM answers WHERE study_id=?', (study_id,)).fetchone()[0]
                require(count < study['quota'], 'Квота уже набрана.', 409)
                ids = {r[0] for r in db.execute('SELECT id FROM options WHERE study_id=?', (study_id,))}
                personal, prediction = payload.get('personal_id'), payload.get('prediction_id')
                require(isinstance(personal, str) and isinstance(prediction, str) and personal in ids and prediction in ids, 'Выберите личный вариант и прогноз из этого исследования.')
                accepted_at = self.clock()
                require(accepted_at < study['deadline'], 'Сбор ответов завершён.', 409)
                db.execute('INSERT INTO answers VALUES (?,?,?,?,?,?)', (uid(), study_id, user['id'], personal, prediction, accepted_at))
                self.award(db, study_id, user['id'], 'base')
                self.event(db, 'opened', study_id, user['id'])
                self.event(db, 'answered', study_id, user['id'])
                self.close(db, study)
        return self.detail(user, study_id)

    def comparison(self, db, study_id):
        count = db.execute('SELECT COUNT(*) FROM answers WHERE study_id=?', (study_id,)).fetchone()[0]
        fact_row = db.execute('SELECT * FROM facts WHERE study_id=? ORDER BY version DESC LIMIT 1', (study_id,)).fetchone()
        fact = dict(fact_row) if fact_row else None
        if fact:
            fact['values'] = json.loads(fact.pop('values_json'))
        _, predicted = self.distribution(db, study_id, 'prediction_id')
        actual = []
        if fact:
            maximum = max(v['value'] for v in fact['values'])
            actual = [v['option_id'] for v in fact['values'] if v['value'] == maximum]
        if not count:
            code, label = 'empty', 'Нет ответов — сверка невозможна'
        elif not fact:
            code, label = 'no_fact', 'Нет данных'
        elif len(actual) != 1 or len(predicted) != 1:
            code, label = 'tie', 'Ничья, однозначная сверка невозможна'
        elif actual == predicted:
            code, label = 'match', 'Совпало'
        else:
            code, label = 'mismatch', 'Не совпало'
        return {'code': code, 'label': label, 'fact': fact, 'predicted_leaders': predicted, 'actual_leaders': actual}

    def detail(self, user, study_id, opened=False):
        self.settle()
        with self.tx() as db:
            study = self.study(db, study_id)
            is_owner = user['role'] == 'owner' and study['owner_id'] == user['id']
            answer = db.execute('SELECT personal_id,prediction_id,accepted_at FROM answers WHERE study_id=? AND user_id=?', (study_id, user['id'])).fetchone()
            require(is_owner or (study['status'] in ('open', 'closed') and (answer is not None or self.eligible(user, study))), 'Нет доступа к исследованию.', 403)
            if opened and not is_owner and study['status'] == 'open':
                self.event(db, 'opened', study_id, user['id'])
            result = {k: study[k] for k in ['id', 'title', 'question', 'status', 'version', 'quota', 'age_min', 'age_max', 'country', 'created_at', 'published_at', 'deadline', 'closed_at']}
            result['options'] = [dict(row) for row in db.execute('SELECT id,text,image,position FROM options WHERE study_id=? ORDER BY position', (study_id,))]
            result['my_answer'] = dict(answer) if answer else None
            if is_owner:
                result['count'] = db.execute('SELECT COUNT(*) FROM answers WHERE study_id=?', (study_id,)).fetchone()[0]
                result['moderation_reason'] = study['moderation_reason']
                result['moderation_provider'] = study['moderation_provider']
                if study['status'] == 'closed':
                    result['complete'] = result['count'] == study['quota']
                    result['personal'], result['personal_leaders'] = self.distribution(db, study_id, 'personal_id')
                    result['predictions'], result['prediction_leaders'] = self.distribution(db, study_id, 'prediction_id')
                    result['comparison'] = self.comparison(db, study_id)
            elif answer:
                result['points'] = {r['kind']: r['amount'] for r in db.execute('SELECT kind,amount FROM ledger WHERE study_id=? AND user_id=?', (study_id, user['id']))}
                if study['status'] == 'closed':
                    _, result['personal_leaders'] = self.distribution(db, study_id, 'personal_id')
                    count = db.execute('SELECT COUNT(*) FROM answers WHERE study_id=?', (study_id,)).fetchone()[0]
                    result['complete'] = count == study['quota']
            return result

    def listing(self, user):
        self.settle()
        with closing(self.connect()) as db:
            if user['role'] == 'owner':
                rows = db.execute('SELECT id FROM studies WHERE owner_id=? ORDER BY created_at DESC', (user['id'],)).fetchall()
            else:
                rows = db.execute("SELECT DISTINCT s.id FROM studies s LEFT JOIN answers a ON a.study_id=s.id AND a.user_id=? WHERE (s.status='open' AND s.country=? AND s.age_min<=? AND s.age_max>=?) OR a.user_id=? ORDER BY s.created_at DESC", (user['id'], user['country'], user['age'], user['age'], user['id'])).fetchall()
        return [self.detail(user, r['id']) for r in rows]

    def save_fact(self, user, study_id, payload):
        metric, unit = text(payload.get('metric', ''), 'Метрика', 120), text(payload.get('unit', ''), 'Единица измерения', 40)
        require(metric and unit, 'Укажите метрику и единицу измерения.')
        try:
            start, end = date.fromisoformat(payload['start_date']), date.fromisoformat(payload['end_date'])
        except (KeyError, ValueError, TypeError):
            raise Problem('Укажите корректный период.')
        require(start <= end, 'Конец периода не может быть раньше начала.')
        is_rate = payload.get('is_rate', False)
        require(type(is_rate) is bool, 'Неверный тип метрики.')
        values = payload.get('values')
        require(isinstance(values, list), 'Введите значения всех вариантов.')
        with self.tx() as db:
            study = self.study(db, study_id)
            self.owner(user, study)
            require(study['status'] == 'closed', 'Факт доступен после закрытия.', 409)
            ids = {r[0] for r in db.execute('SELECT id FROM options WHERE study_id=?', (study_id,))}
            require(all(isinstance(v, dict) for v in values), 'Неверные значения.')
            require(len(values) == len(ids) and {v.get('option_id') for v in values} == ids, 'Нужны значения всех вариантов без повторов.')
            normalized = []
            for item in values:
                number = item.get('value')
                require(type(number) in (int, float) and math.isfinite(number) and number >= 0, 'Значения должны быть конечными неотрицательными числами.')
                denominator = item.get('denominator')
                if is_rate:
                    require(type(denominator) in (int, float) and math.isfinite(denominator) and denominator > 0, 'Для ставки укажите положительный знаменатель каждого варианта.')
                normalized.append({'option_id': item['option_id'], 'value': number, 'denominator': denominator if is_rate else None})
            version = db.execute('SELECT COALESCE(MAX(version),0)+1 FROM facts WHERE study_id=?', (study_id,)).fetchone()[0]
            db.execute('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?)', (study_id, version, metric, unit, start.isoformat(), end.isoformat(), int(is_rate), json.dumps(normalized), self.clock()))
            self.event(db, 'fact_saved', study_id, version=version)
        return self.detail(user, study_id)

    def history(self, user):
        with closing(self.connect()) as db:
            return [dict(r) for r in db.execute('SELECT l.kind,l.amount,l.created_at,s.title,s.id AS study_id FROM ledger l JOIN studies s ON s.id=l.study_id WHERE l.user_id=? ORDER BY l.created_at DESC', (user['id'],))]

    def metrics(self, user):
        require(user['role'] == 'owner', 'Нет доступа.', 403)
        self.settle()
        with closing(self.connect()) as db:
            rows = db.execute('SELECT * FROM studies WHERE owner_id=? AND published_at IS NOT NULL', (user['id'],)).fetchall()
            studies, starts, pairs, matches, comparable, ties, missing = [], 0, 0, 0, 0, 0, 0
            for row in rows:
                study = dict(row)
                opened = db.execute("SELECT COUNT(*) FROM events WHERE study_id=? AND type='opened'", (study['id'],)).fetchone()[0]
                times = [r[0] for r in db.execute('SELECT accepted_at FROM answers WHERE study_id=? ORDER BY accepted_at', (study['id'],))]
                elapsed = times[49]-study['published_at'] if len(times) >= 50 else None
                starts += opened
                pairs += len(times)
                item = {'id': study['id'], 'title': study['title'], 'quota': study['quota'], 'starts': opened, 'pairs': len(times), 't50_seconds': elapsed,
                        'g1_met': elapsed is not None and elapsed <= 3600 if study['quota'] == 50 else None}
                if study['status'] == 'closed':
                    comparison = self.comparison(db, study['id'])
                    item['comparison'] = comparison['code']
                    if comparison['code'] in ('match', 'mismatch'):
                        comparable += 1
                        matches += int(comparison['code'] == 'match')
                    elif comparison['code'] == 'tie':
                        ties += 1
                    else:
                        missing += 1
                studies.append(item)
            return {'studies': studies, 'starts': starts, 'pairs': pairs, 'completion_percent': round(100*pairs/starts, 1) if starts else None,
                    'agreement_percent': round(100*matches/comparable, 1) if comparable else None, 'comparable': comparable, 'ties': ties, 'missing': missing}
