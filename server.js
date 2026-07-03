/* 直播團隊每日回報系統 — 後端 + 主管彙整儀表板
 * 儲存：libsql（本機用 file:local.db；線上設 TURSO_DATABASE_URL 即用 Turso 雲端，永久保存）
 * 啟動：node server.js   （或 npm start）
 * 環境變數：PORT（預設 4321）、ADMIN_PASSWORD（預設 admin123）、TURSO_DATABASE_URL、TURSO_AUTH_TOKEN
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 4321;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// 本機沒設 Turso → 用 file:local.db（SQLite 檔，持久於本機）；線上設環境變數即用 Turso 雲端
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const TEMPLATE_FILE = path.join(PUBLIC, 'default-template.json');
async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    pos TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE(name, pos, date)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
  const t = await db.execute({ sql: 'SELECT value FROM config WHERE key=?', args: ['template'] });
  if (!t.rows.length) {
    let def = '{}'; try { def = fs.readFileSync(TEMPLATE_FILE, 'utf8'); } catch (e) {}
    await db.execute({ sql: 'INSERT INTO config (key,value) VALUES (?,?)', args: ['template', def] });
  }
}
async function getTemplate() {
  const r = await db.execute({ sql: 'SELECT value FROM config WHERE key=?', args: ['template'] });
  if (r.rows.length) { try { return JSON.parse(r.rows[0].value); } catch (e) {} }
  try { return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')); } catch (e) { return {}; }
}

const sessions = new Set(); // in-memory admin tokens (reset on restart)

/* ---------- helpers ---------- */
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function isAdmin(req) { const c = cookies(req); return c.sid && sessions.has(c.sid); }
function csv(v) { v = (v == null ? '' : String(v)); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

async function listSubs(month, pos) {
  const conds = [], args = [];
  if (month) { conds.push('substr(date,1,7)=?'); args.push(month); }
  if (pos) { conds.push('pos=?'); args.push(pos); }
  let sql = 'SELECT id,payload,received_at FROM submissions';
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY date DESC, received_at DESC';
  const r = await db.execute({ sql, args });
  return r.rows.map(row => Object.assign({ id: row.id, receivedAt: row.received_at }, JSON.parse(row.payload)));
}

/* 月度彙總：把每日 metrics 滾成每人一列（接考核） */
function summarize(subs) {
  const g = {};
  subs.forEach(s => {
    const k = s.name + '|' + s.pos;
    if (!g[k]) g[k] = { name: s.name, pos: s.pos, days: 0, rates: [], helps: 0, ded: 0, scores: [] };
    const G = g[k]; G.days++;
    const m = s.metrics || {};
    if (m.denom > 0) G.rates.push(m.rate);
    G.helps += (m.helpCount || 0);
    G.ded += (m.dedTotal || 0);
    if (s.review && s.review.score != null && s.review.score !== '') G.scores.push(Number(s.review.score));
  });
  return Object.values(g)
    .map(G => ({
      name: G.name, pos: G.pos, days: G.days,
      avgRate: G.rates.length ? Math.round(G.rates.reduce((a, b) => a + b, 0) / G.rates.length) : 0,
      helps: G.helps, ded: Math.max(-30, G.ded),
      avgScore: G.scores.length ? Math.round(G.scores.reduce((a, b) => a + b, 0) / G.scores.length) : null
    }))
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.name.localeCompare(b.name));
}

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  const p = path.join(PUBLIC, decodeURIComponent(rel === '/' ? '/index.html' : rel));
  if (!p.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(p, (e, d) => {
    if (e) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(d);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pn = u.pathname;
  try {
    // 填寫者送出（送出即鎖定：同人同日只能送一次，之後由主管後台統一管理）
    if (pn === '/api/submit' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.pos || !b.name || !b.date) return send(res, 400, { error: '缺少必要欄位（崗位/姓名/日期）' });
      const existing = await db.execute({ sql: 'SELECT id FROM submissions WHERE name=? AND pos=? AND date=?', args: [b.name, b.pos, b.date] });
      if (existing.rows.length > 0) {
        return send(res, 409, { error: b.name + '（' + b.pos + '）' + b.date + ' 的回報已送出並鎖定，由主管後台統一管理。如需修改，請聯繫主管。', locked: true });
      }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const receivedAt = new Date().toISOString();
      await db.execute({
        sql: 'INSERT INTO submissions (id,pos,name,date,payload,received_at) VALUES (?,?,?,?,?,?)',
        args: [id, b.pos, b.name, b.date, JSON.stringify(b), receivedAt]
      });
      return send(res, 200, { ok: true, id });
    }

    // 回報表範本（填寫頁載入用，公開讀取）
    if (pn === '/api/template' && req.method === 'GET') {
      return send(res, 200, await getTemplate());
    }

    // 主管登入 / 狀態 / 登出
    if (pn === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.password === ADMIN_PASSWORD) {
        const t = crypto.randomBytes(16).toString('hex'); sessions.add(t);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=' + t + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400' });
      }
      return send(res, 401, { error: '密碼錯誤' });
    }
    if (pn === '/api/admin/check') return send(res, 200, { isAdmin: isAdmin(req) });
    if (pn === '/api/admin/logout' && req.method === 'POST') { sessions.delete(cookies(req).sid); return send(res, 200, { ok: true }); }

    // 受保護的主管 API
    if (pn.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: '請先登入' });

      if (pn === '/api/admin/data') {
        const subs = await listSubs(u.searchParams.get('month'), u.searchParams.get('pos'));
        return send(res, 200, { submissions: subs, summary: summarize(subs) });
      }
      if (pn === '/api/admin/submission' && req.method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM submissions WHERE id=?', args: [u.searchParams.get('id')] });
        return send(res, 200, { ok: true });
      }
      // 主管在後台新增/編輯某筆回報的扣分
      if (pn === '/api/admin/deductions' && req.method === 'POST') {
        const id = u.searchParams.get('id');
        const b = await readBody(req);
        const deds = Array.isArray(b.deds) ? b.deds.filter(d => d && d.item).map(d => ({ item: String(d.item), reason: String(d.reason || ''), pts: Number(d.pts) || 0 })) : [];
        const r = await db.execute({ sql: 'SELECT payload FROM submissions WHERE id=?', args: [id] });
        if (!r.rows.length) return send(res, 404, { error: '找不到該筆回報' });
        const payload = JSON.parse(r.rows[0].payload);
        payload.deds = deds;
        payload.metrics = payload.metrics || {};
        payload.metrics.dedTotal = deds.reduce((a, d) => a + d.pts, 0);
        await db.execute({ sql: 'UPDATE submissions SET payload=? WHERE id=?', args: [JSON.stringify(payload), id] });
        return send(res, 200, { ok: true, dedTotal: payload.metrics.dedTotal });
      }
      // 主管評分/回饋（每筆；回報送出後 24 小時自動鎖定，之後無法再編輯）
      if (pn === '/api/admin/review' && req.method === 'POST') {
        const id = u.searchParams.get('id');
        const b = await readBody(req);
        const r = await db.execute({ sql: 'SELECT payload, received_at FROM submissions WHERE id=?', args: [id] });
        if (!r.rows.length) return send(res, 404, { error: '找不到該筆回報' });
        if (Date.now() - new Date(r.rows[0].received_at).getTime() > 24 * 3600 * 1000)
          return send(res, 403, { error: '此回報送出已超過 24 小時，主管評分/回饋已鎖定，無法再編輯。', locked: true });
        const payload = JSON.parse(r.rows[0].payload);
        payload.review = {
          score: (b.score === '' || b.score == null) ? null : Number(b.score),
          good: String(b.good || ''), improve: String(b.improve || ''), comment: String(b.comment || '')
        };
        await db.execute({ sql: 'UPDATE submissions SET payload=? WHERE id=?', args: [JSON.stringify(payload), id] });
        return send(res, 200, { ok: true });
      }
      // 主管編輯回報表範本
      if (pn === '/api/admin/template' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: '格式錯誤' });
        const clean = {};
        ['運營', '小編', '群控'].forEach(pos => {
          if (Array.isArray(b[pos])) clean[pos] = b[pos].filter(it => Array.isArray(it) && String(it[1] || '').trim()).map(it => {
            const cat = String(it[0] || ''); const q = String(it[1] || ''); const std = String(it[2] || ''); const type = it[3] === 'n' ? 'n' : 'c';
            if (type === 'n') { const thr = it[4] || {}; return [cat, q, std, 'n', { '微糖': Number(thr['微糖']) || 0, '白姊': Number(thr['白姊']) || 0, '棠棠': Number(thr['棠棠']) || 0 }]; }
            return [cat, q, std, 'c'];
          });
        });
        await db.execute({ sql: 'INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', args: ['template', JSON.stringify(clean)] });
        return send(res, 200, { ok: true });
      }
      if (pn === '/api/admin/export') {
        const m = u.searchParams.get('month');
        const subs = (await listSubs(m, null)).sort((a, b) => a.date.localeCompare(b.date));
        const head = ['日期', '崗位', '姓名', 'IP', '直播日', '完成率', '數字達標', '互助件數', '扣分', '未完成/部分項目', '收到時間'];
        const rows = [head.map(csv).join(',')];
        subs.forEach(s => {
          const m2 = s.metrics || {};
          rows.push([s.date, s.pos, s.name, s.ip, s.live ? '是' : '否',
            (m2.denom > 0 ? m2.rate + '%' : ''), (m2.numOk + '/' + m2.numTot), m2.helpCount, m2.dedTotal,
            (s.fails || []).join('、'), s.receivedAt].map(csv).join(','));
        });
        return send(res, 200, '﻿' + rows.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="report_' + (m || 'all') + '.csv"' });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (pn.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    serveStatic(res, pn);
  } catch (err) {
    console.error(err); send(res, 500, { error: '伺服器錯誤' });
  }
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log('直播團隊每日回報系統  http://localhost:' + PORT);
    console.log('主管彙整後台        http://localhost:' + PORT + '/admin.html');
    console.log('儲存：' + (process.env.TURSO_DATABASE_URL ? 'Turso 雲端' : 'file:local.db（本機）'));
    console.log('（後台密碼預設 admin123，可用環境變數 ADMIN_PASSWORD 變更）');
  });
}).catch(err => { console.error('啟動失敗:', err); process.exit(1); });
