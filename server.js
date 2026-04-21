const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DB_FILE = path.join(ROOT_DIR, 'destinations.database.json');
const DB_BACKUP_FILE = path.join(ROOT_DIR, 'destinations.database.backup.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function validateDestinationsPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Invalid JSON payload';
  }

  if (!Array.isArray(payload.records)) {
    return 'Payload must include a records array';
  }

  for (let i = 0; i < payload.records.length; i += 1) {
    const rec = payload.records[i];
    if (!rec || typeof rec !== 'object') return `Invalid record at index ${i}`;
    if (typeof rec.city !== 'string' || !rec.city.trim()) return `Record ${i}: city is required`;
    if (!rec.place || typeof rec.place !== 'object') return `Record ${i}: place is required`;
    if (typeof rec.place.es !== 'string' || !rec.place.es.trim()) return `Record ${i}: place.es is required`;
    if (!rec.description || typeof rec.description !== 'object') return `Record ${i}: description is required`;
    if (typeof rec.description.es !== 'string') return `Record ${i}: description.es must be a string`;
  }

  return null;
}

function sanitizePayload(payload) {
  const records = payload.records.map((rec) => ({
    city: String(rec.city || '').trim(),
    place: {
      es: String(rec.place?.es || '').trim(),
      en: String(rec.place?.en || rec.place?.es || '').trim()
    },
    image: String(rec.image || '').trim(),
    description: {
      es: String(rec.description?.es || '').trim(),
      en: String(rec.description?.en || rec.description?.es || '').trim()
    }
  })).filter((rec) => rec.city && rec.place.es);

  const cities = [...new Set(records.map((r) => r.city))].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceFile: payload.sourceFile || 'Prueba Itinerario 18 dias - destinos con imagenes.html',
    languages: ['es', 'en'],
    defaultLanguage: 'es',
    cities,
    records
  };
}

function writeJsonAtomic(targetPath, obj) {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  const tempPath = `${targetPath}.tmp`;

  if (fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, DB_BACKUP_FILE);
  }

  fs.writeFileSync(tempPath, json, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function resolveStaticPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  let rel = decodedPath === '/' ? '/Prueba Itinerario 18 dias - destinos con imagenes.html' : decodedPath;
  rel = rel.replace(/\\/g, '/');

  const fullPath = path.normalize(path.join(ROOT_DIR, rel));
  if (!fullPath.startsWith(ROOT_DIR)) return null;

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    return path.join(fullPath, 'index.html');
  }

  return fullPath;
}

const server = http.createServer((req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && parsed.pathname === '/api/destinations') {
      if (!fs.existsSync(DB_FILE)) {
        return sendJson(res, 404, { ok: false, error: 'destinations.database.json not found' });
      }
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(raw);
    }

    if (req.method === 'POST' && parsed.pathname === '/api/save-destinations') {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
        const size = chunks.reduce((acc, c) => acc + c.length, 0);
        if (size > 10 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Payload too large');
          req.destroy();
        }
      });

      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsedJson = JSON.parse(raw);
          const validationError = validateDestinationsPayload(parsedJson);
          if (validationError) {
            return sendJson(res, 400, { ok: false, error: validationError });
          }

          const normalized = sanitizePayload(parsedJson);
          writeJsonAtomic(DB_FILE, normalized);
          return sendJson(res, 200, {
            ok: true,
            file: path.basename(DB_FILE),
            backup: path.basename(DB_BACKUP_FILE),
            records: normalized.records.length,
            cities: normalized.cities.length
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message || 'Invalid JSON' });
        }
      });

      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method Not Allowed');
    }

    const staticPath = resolveStaticPath(parsed.pathname);
    if (!staticPath || !fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }

    const ext = path.extname(staticPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(staticPath);
    res.writeHead(200, { 'Content-Type': mimeType });

    if (req.method === 'HEAD') {
      res.end();
      stream.destroy();
      return;
    }

    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    });
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Internal Server Error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Serving folder: ${ROOT_DIR}`);
  console.log(`Database file: ${DB_FILE}`);
});
