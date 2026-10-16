# Локальный запуск Manyvo

Нужны Docker с Docker Compose. Для сборки расширения — Node.js 22+.

## Подготовка

В корне проекта создать `.env`, если его ещё нет:

```sh
cp -n .env.example .env
```

Для ИИ-модерации указать свой ключ в `OPENAI_API_KEY` внутри `.env`.

## Запуск

```sh
docker compose up --build -d
```

Сайт: <http://localhost:3000>.

Демовход: `owner@manyvo.local` — заказчик, `anna@manyvo.local` — участник. Пароль: `manyvo-demo`.

Для запуска без ключа OpenAI:

```sh
DEMO_MODE=true docker compose up --build -d
```

В этом режиме материалы публикуются без ИИ-проверки. Чтобы подключить реальную модерацию после добавления ключа:

```sh
DEMO_MODE=false docker compose up -d --force-recreate api
```

## Расширение для Яндекс Браузера

```sh
npm ci
npm run package -w @manyvo/extension
```

1. Открыть `browser://tune` и перетащить в окно `artifacts/manyvo-yandex.crx`, подтвердить установку.
2. На сайте войти участником → **Расширение** → **Создать код подключения**.
3. В настройках расширения указать `http://localhost:3000`, вставить код и сохранить.
4. Нажать **Проверить уведомление**. При необходимости разрешить уведомления Яндекс Браузеру в настройках ОС.

## Управление сервисами

Проверить состояние:

```sh
docker compose ps
```

Посмотреть логи:

```sh
docker compose logs -f api web
```

Остановить сервисы с сохранением данных:

```sh
docker compose down
```
