// Optional page-fetch proxy for Smartify (Cloudflare Workers, free tier is enough).
//
// 1. In the Cloudflare dashboard: Workers & Pages -> Create -> Worker -> paste this file -> Deploy.
// 2. In Smartify choose "My own proxy" and enter:
//      https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/?url={url}
//
// Tip: change ALLOWED_ORIGIN to your site's address so only your page can use the proxy.

const ALLOWED_ORIGIN = '*';
const MAX_BYTES = 1500000;
const PRIVATE_HOST = /^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|\[?fc|\[?fd)/i;

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Missing or invalid url parameter', { status: 400, headers: cors });
    }

    let host;
    try { host = new URL(target).hostname; } catch (_) {
      return new Response('Invalid url', { status: 400, headers: cors });
    }
    if (PRIVATE_HOST.test(host) || !host.includes('.')) {
      return new Response('Blocked host', { status: 403, headers: cors });
    }

    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SmartifyFetcher/1.0)',
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en',
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });

      const type = upstream.headers.get('content-type') || '';
      if (!/text\/|xml|json/i.test(type)) {
        return new Response('Unsupported content type', { status: 415, headers: cors });
      }

      const body = (await upstream.text()).slice(0, MAX_BYTES);
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch (_) {
      return new Response('Upstream fetch failed', { status: 502, headers: cors });
    }
  },
};
