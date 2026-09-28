"""HTTP for connectors: verified TLS (certifi), gzip, retries with backoff, and a per-host pause so public
servers are never hammered."""
import gzip
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

import certifi

from .config import USER_AGENT

_CTX = ssl.create_default_context(cafile=certifi.where())
_last = {}          # host -> time of the last request
PAUSE = 0.35        # seconds between requests to the same host


class HTTPError(Exception):
    def __init__(self, status, url, body=""):
        super().__init__(f"HTTP {status} for {url}: {body[:300]}")
        self.status, self.url, self.body = status, url, body


def get_bytes(url, params=None, headers=None, timeout=60, retries=4):
    if params:
        url = f"{url}{'&' if '?' in url else '?'}{urllib.parse.urlencode(params)}"
    host = urllib.parse.urlsplit(url).netloc
    h = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    h.update(headers or {})
    delay = 2.0
    for attempt in range(retries + 1):
        wait = PAUSE - (time.time() - _last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout, context=_CTX) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as e:
            body = e.read()[:2000].decode("utf-8", "replace")
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise HTTPError(e.code, url, body) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise HTTPError(0, url, str(e)) from None


def get_json(url, params=None, **kw):
    return json.loads(get_bytes(url, params, **kw))
