"""Deterministic local fixtures, only created when explicitly requested."""
from .core import Store
from .moderation import DemoModerator

DEMO_PASSWORD = 'manyvo-demo'
ACCOUNTS = [
    ('owner@manyvo.local', 'Мария', 'owner', 25, 'Россия'),
    ('anna@manyvo.local', 'Анна', 'participant', 24, 'Россия'),
    ('ivan@manyvo.local', 'Иван', 'participant', 29, 'Россия'),
    ('alina@manyvo.local', 'Алина', 'participant', 21, 'Россия'),
    ('max@manyvo.local', 'Максим', 'participant', 33, 'Россия'),
    ('lena@manyvo.local', 'Елена', 'participant', 27, 'Россия'),
]


def seed(store):
    with store.connect() as db:
        if db.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
            return
    users = [store.user(store.add_user(email, name, role, age, country, DEMO_PASSWORD)) for email, name, role, age, country in ACCOUNTS]
    owner = users[0]
    fixtures = Store(store.path, DemoModerator(), store.clock)
    def study(title, question, variants, quota):
        result = fixtures.create(owner)
        return fixtures.save(owner, result['id'], {
            'version': result['version'], 'title': title, 'question': question,
            'quota': quota, 'age_min': 18, 'age_max': 65, 'country': 'Россия',
            'options': [{'text': v} for v in variants],
        })
    draft = study('Как рассказать о новой подписке?', 'Какое сообщение лучше передаёт ценность подписки?',
                  ['Больше возможностей. Каждый день.', 'Всё, что любите, в одной подписке.'], 50)
    opened = study('Какой заголовок хочется открыть?', 'Представьте, что выбираете приложение для планирования. Какой заголовок вас привлечёт?',
                   ['Меньше планов. Больше сделанного.', 'Ваш день, в котором всё на своих местах.', 'Освободите время для важного.'], 5)
    fixtures.publish(owner, opened['id'])
    closed = study('Выбираем сообщение для кофейни', 'Какое сообщение убедит вас зайти за кофе по дороге на работу?',
                   ['Хороший день начинается с хорошего кофе.', 'Ваш любимый кофе. На минуту ближе.', 'Пять минут для себя.'], 5)
    closed = fixtures.publish(owner, closed['id'])
    ids = [o['id'] for o in closed['options']]
    for user, personal, prediction in zip(users[1:], [0, 0, 1, 1, 2], [0, 1, 1, 1, 2]):
        fixtures.answer(user, closed['id'], {'personal_id': ids[personal], 'prediction_id': ids[prediction]})
