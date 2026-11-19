
'use strict';

const express = require('express');
const cors = require('cors');
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const { timingSafeEqual } = require('node:crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.KML_API_KEY || '';

const MAX_REDIRECTS = 5;
const MAX_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

if (!API_KEY || API_KEY.length < 24) {
  console.error(
    'Configuration manquante : définissez KML_API_KEY (au moins 24 caractères) dans Render.'
  );
  process.exit(1);
}

app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-KML-Key']
}));

app.use(express.urlencoded({ extended: false, limit: '4kb' }));
app.use(express.json({ limit: '4kb' }));

const requestCounts = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  let bucket = requestCounts.get(ip);

  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    requestCounts.set(ip, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_LIMIT) {
    return res
      .status(429)
      .type('text/plain')
      .send('Trop de requêtes. Réessaie dans une minute.');
  }

  if (requestCounts.size > 1000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start >= RATE_WINDOW_MS) {
        requestCounts.delete(key);
      }
    }
  }

  next();
});

function constantTimeKeyMatch(received) {
  if (typeof received !== 'string') return false;

  const a = Buffer.from(received);
  const b = Buffer.from(API_KEY);

  return a.length === b.length && timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!constantTimeKeyMatch(req.get('x-kml-key'))) {
    return res
      .status(401)
      .type('text/plain')
      .send('Clé KML invalide ou absente.');
  }

  next();
}

function isPublicIp(address) {
  if (!net.isIP(address)) return false;

  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

async function validatePublicHttpUrl(raw) {
  let target;

  try {
    target = new URL(raw);
  } catch {
    throw new Error('URL invalide.');
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Seules les URL HTTP et HTTPS sont autorisées.');
  }

  if (!target.hostname || target.username || target.password) {
    throw new Error('URL invalide.');
  }

  const hostname = target.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Les adresses locales ne sont pas autorisées.');
  }

  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error('Adresse IP privée ou réservée non autorisée.');
    }
  } else {
    let records;

    try {
      records = await dns.lookup(hostname, {
        all: true,
        verbatim: true
      });
    } catch {
      throw new Error('Le domaine de la playlist est introuvable.');
    }

    if (
      !records.length ||
      records.some(record => !isPublicIp(record.address))
    ) {
      throw new Error(
        'Le domaine ne pointe pas uniquement vers des adresses IP publiques.'
      );
    }
  }

  return target;
}

async function fetchPlaylistWithRedirects(rawUrl) {
  let url = rawUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const target = await validatePublicHttpUrl(url);
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
          
          'Accept':
            'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*'
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');

        if (!location) {
          throw new Error(
            'Redirection invalide du serveur de playlist.'
          );
        }

        if (redirects === MAX_REDIRECTS) {
          throw new Error('Trop de redirections.');
        }

        url = new URL(location, target).toString();

        if (response.body) {
          await response.body.cancel().catch(() => {});
        }

        continue;
      }

      console.log(
        '[KML] TEST : réponse distante reçue',
        response.status
      );

      if (!response.ok) {
        let errorBody = '';

        try {
          errorBody = await response.text();
          errorBody = errorBody.slice(0, 1000);
        } catch {
          errorBody = '(corps de réponse illisible)';
        }

        console.error('[KML] Diagnostic réponse distante :', {
          status: response.status,
          statusText: response.statusText,
          hostname: target.hostname,
          server: response.headers.get('server'),
          via: response.headers.get('via'),
          contentType: response.headers.get('content-type'),
          location: response.headers.get('location'),
          cfRay: response.headers.get('cf-ray'),
          date: response.headers.get('date'),
          errorBody
        });

        throw new Error(
          `Le serveur de playlist a répondu HTTP ${response.status}.`
        );
      }

      if (!response.body) {
        throw new Error('Le serveur a renvoyé une réponse vide.');
      }

      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          total += value.byteLength;

          if (total > MAX_BYTES) {
            await reader.cancel();
            throw new Error(
              'La playlist dépasse la limite de 25 Mo.'
            );
          }

          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }

      const content = Buffer.concat(chunks).toString('utf8');

      if (
        !content.includes('#EXTM3U') &&
        !content.includes('#EXTINF')
      ) {
        throw new Error(
          'La réponse reçue ne semble pas être une playlist M3U.'
        );
      }

      return content;

    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(
          'Le serveur de playlist a mis trop de temps à répondre.'
        );
      }

      throw error;

    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    'Impossible de suivre les redirections de la playlist.'
  );
}

app.get('/', (req, res) => {
  res.json({
    service: 'KML Player Playlist Proxy',
    status: 'ok',
    health: '/health',
    playlistEndpoint: 'POST /api/playlist'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/playlist', requireApiKey, async (req, res) => {
  const playlistUrl =
    typeof req.body?.url === 'string'
      ? req.body.url.trim()
      : '';

  if (!playlistUrl || playlistUrl.length > 4096) {
    return res
      .status(400)
      .type('text/plain')
      .send('URL de playlist absente ou trop longue.');
  }

  try {
    const content = await fetchPlaylistWithRedirects(playlistUrl);

    res.set('Cache-Control', 'no-store');

    return res
      .status(200)
      .type('text/plain; charset=utf-8')
      .send(content);

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Erreur inconnue.';

    const status =
      /URL invalide|autorisées|non autorisée|introuvable|adresse IP/i.test(message)
        ? 400
        : 502;

    console.error(`Playlist proxy failed: ${message}`);

    return res
      .status(status)
      .type('text/plain; charset=utf-8')
      .send(message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `KML playlist proxy listening on port ${PORT}`
  );
});
