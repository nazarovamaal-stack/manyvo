"""Server-side OpenAI Moderation API adapter. No credentials reach the browser."""
import json
import os
import urllib.error
import urllib.request


class ModerationUnavailable(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OpenAIModerator:
    provider = 'openai'

    def __init__(self, api_key=None, model=None, transport=None):
        self.api_key = api_key if api_key is not None else os.getenv('OPENAI_API_KEY', '')
        self.model = model or os.getenv('OPENAI_MODERATION_MODEL', 'omni-moderation-latest')
        self.transport = transport or urllib.request.build_opener(NoRedirect()).open

    def check(self, study, options):
        if not self.api_key:
            raise ModerationUnavailable('Добавьте OPENAI_API_KEY в локальный .env и перезапустите сервер.')
        # One request per variant: every changed variant must be checked again.
        for index, option in enumerate(options, 1):
            inputs = [{'type': 'text', 'text': '\n'.join(filter(None, [study['title'], study['question'], option['text']]))}]
            if option.get('image'):
                inputs.append({'type': 'image_url', 'image_url': {'url': option['image']}})
            request = urllib.request.Request(
                'https://api.openai.com/v1/moderations',
                data=json.dumps({'model': self.model, 'input': inputs}).encode(),
                headers={'Authorization': 'Bearer ' + self.api_key, 'Content-Type': 'application/json'},
                method='POST',
            )
            try:
                with self.transport(request, timeout=15) as response:
                    result = json.load(response)
                results = result.get('results')
                if not isinstance(results, list) or not results or any(type(r.get('flagged')) is not bool for r in results):
                    raise ValueError('Invalid moderation response')
                if any(r['flagged'] for r in results):
                    return False, 'Вариант %d не прошёл проверку безопасности. Измените материалы и отправьте заново.' % index
            except urllib.error.HTTPError as error:
                message = {401: 'OpenAI не принял API-ключ. Проверьте ключ на сервере.',
                           403: 'OpenAI отклонил доступ к модерации.',
                           429: 'Достигнут лимит запросов OpenAI. Попробуйте позже.'}.get(error.code, 'OpenAI временно недоступен. Попробуйте позже.')
                raise ModerationUnavailable(message) from None
            except (OSError, ValueError, KeyError, TypeError):
                raise ModerationUnavailable('Не удалось завершить проверку OpenAI. Попробуйте позже.') from None
        return True, ''


class DemoModerator:
    """Explicit offline demonstration only. Never used as an API-error fallback."""
    provider = 'demo'

    def check(self, study, options):
        return True, ''
