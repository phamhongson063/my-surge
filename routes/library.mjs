import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DB_DIR = join(__dirname, '../database/library');

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function handle(req, res, { pathname }) {
  // GET /api/library → return all articles metadata (no content)
  if (pathname === '/api/library' && req.method === 'GET') {
    try {
      const data = await readFile(join(DB_DIR, 'articles.json'), 'utf8');
      sendJSON(res, 200, { ok: true, articles: JSON.parse(data) });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  // GET /api/library/1 → return single article HTML content
  const m = pathname.match(/^\/api\/library\/(\d+)$/);
  if (m && req.method === 'GET') {
    const id = m[1];
    try {
      const html = await readFile(join(DB_DIR, 'articles', `${id}.html`), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      sendJSON(res, 404, { ok: false, error: 'Article not found' });
    }
    return true;
  }

  return false;
}
