// OneLink Intake - local demo MVP. No accounts, no external services, no paid APIs.
// Extraction is LOCAL: Tesseract OCR + rule-based parsing (clearly labeled in the UI).
// Production extraction would run on a document model (e.g. Vultr Serverless Inference), not built here.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const PORT = process.env.PORT || 8123;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const RATE_LIMIT = 30; // uploads per hour per IP per request link
const EXPIRY_DAYS = 10;

fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });

// Real cleanup: expired requests lose both their metadata and their uploaded bytes.
function sweepExpired() {
  for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.json'))) {
    const r = loadReq(f.replace(/\.json$/, ''));
    if (r && expired(r)) {
      fs.rmSync(path.join(DATA, 'files', r.id), { recursive: true, force: true });
      fs.rmSync(reqPath(r.id), { force: true });
      console.log('swept expired request', r.id); // id only, never the token
    }
  }
}


const rate = new Map(); // key ip:slug -> [timestamps]
function rateOk(key) {
  const now = Date.now(), win = 3600e3;
  const arr = (rate.get(key) || []).filter(t => now - t < win);
  if (arr.length >= RATE_LIMIT) { rate.set(key, arr); return false; }
  arr.push(now); rate.set(key, arr); return true;
}
const rid = n => crypto.randomBytes(n).toString('base64url');
const itemsHash = items => crypto.createHash('sha1').update((items || []).map(i => [i.id, i.name, i.qty, i.cents].join('|')).join('\n')).digest('hex');
const receiptCentsOf = up => up.review?.reviewed && up.review.total != null ? Math.round(up.review.total * 100) : (up.ocr?.total != null ? Math.round(up.ocr.total * 100) : null);
// Final split/export require a person to confirm the receipt total AND item-list completeness.
// Matching sums alone do not prove the read was complete. Any item/amount edit or re-extraction invalidates it.
const confirmationValid = up => {
  const c = up.confirmation; if (!c) return false;
  const rc = receiptCentsOf(up);
  return rc != null && c.totalCents === rc && c.itemHash === itemsHash(up.items);
};
const reqPath = id => path.join(DATA, id + '.json');
const loadReq = id => { try { return JSON.parse(fs.readFileSync(reqPath(id), 'utf8')); } catch { return null; } };
const saveReq = r => fs.writeFileSync(reqPath(r.id), JSON.stringify(r, null, 2));
const findBySlug = slug => fs.readdirSync(DATA).filter(f => f.endsWith('.json')).map(f => loadReq(f.replace(/\.json$/, ''))).find(r => r && r.slug === slug);
const findByToken = token => fs.readdirSync(DATA).filter(f => f.endsWith('.json')).map(f => loadReq(f.replace(/\.json$/, ''))).find(r => r && r.token === token);
const expired = r => Date.now() > Date.parse(r.expiresAt);

// --- Extraction: local OCR + rules. Returns fields with per-field confidence. ---
// Receipt total: only a dedicated TOTAL line is confident. Savings/deposit/card/subtotal lines
// are never a confident total; a loose match or the largest amount on the slip stays 'low'.
function parseTotal(text) {
  const excluded = /savings|deposits?|change|card|subtotal|rounding/i;
  const lines = (text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^\s*TOTAL\b\s*:?\s*(?:EUR|\u20ac)?\s*([\d]+[.,]\d{2})\s*$/i);
    if (m) return { total: parseFloat(m[1].replace(',', '.')), conf: 'high' };
    // skewed photos sometimes split "TOTAL EUR" and the amount onto adjacent lines
    if (/^\s*TOTAL\b\s*:?\s*(?:EUR|\u20ac)?\s*$/i.test(l)) {
      for (const j of [i + 1, i - 1]) {
        const nx = ((lines[j] || '').trim().match(/^([\d]+[.,]\d{2})$/) || [])[1];
        if (nx) return { total: parseFloat(nx.replace(',', '.')), conf: 'high' };
      }
    }
  }
  for (const l of lines) {
    if (excluded.test(l)) continue;
    const m = l.match(/TOTAL\D{0,20}?([\d]+[.,]\d{2})/i);
    if (m) return { total: parseFloat(m[1].replace(',', '.')), conf: 'low' };
  }
  const amts = [...(text || '').matchAll(/([\d]+[.,]\d{2})/g)].map(m => parseFloat(m[1].replace(',', '.')));
  if (amts.length) return { total: Math.max(...amts), conf: 'low' };
  return { total: null, conf: 'missing' };
}
function parseReceipt(text, avgConf) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const f = { vendor: null, vendor_conf: 'missing', date: null, date_conf: 'missing', total: null, total_conf: 'missing', vat: null, vat_conf: 'missing' };
  if (lines.length) { f.vendor = lines[0].slice(0, 60); f.vendor_conf = avgConf > 75 ? 'high' : 'low'; }
  const mDate = text.match(/Date:\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i) || text.match(/\b([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})\b/);
  if (mDate) { f.date = mDate[1]; f.date_conf = /Date:/i.test(mDate[0]) ? 'high' : 'low'; }
  const tp = parseTotal(text);
  if (tp.total != null) { f.total = tp.total; f.total_conf = tp.conf; }
  const bandRows = lines.filter(l => /%\s*VAT/i.test(l));
  if (bandRows.length >= 2) {
    // VAT breakdown table (rate% VAT net vat-amount per band), no printed total VAT:
    // sum the last amount of each band row. Derived, not printed - stays 'low' confidence.
    let sum = 0, ok = true;
    for (const l of bandRows) {
      const amts = [...l.matchAll(/([\d]+[.,]\d{2})/g)].map(m => parseFloat(m[1].replace(',', '.')));
      if (!amts.length) { ok = false; break; }
      sum += amts[amts.length - 1];
    }
    if (ok) { f.vat = Math.round(sum * 100) / 100; f.vat_conf = 'low'; } else f.vat_conf = 'unreadable';
  } else {
    const mVat = text.match(/VAT[^\d%]*(?:\([\d.,]+%\))?\s*:?\s*([\d]+[.,]\d{2})/i);
    if (mVat) { f.vat = parseFloat(mVat[1].replace(',', '.')); f.vat_conf = 'high'; }
    else if (/VAT/i.test(text)) { f.vat_conf = 'unreadable'; } // VAT line present but amount not parsed
    else { f.vat_conf = 'not found'; } // no VAT line on the receipt at all
  }
  return f;
}

// Preprocess photos for OCR: grayscale + auto-level + adaptive sharpen helps low-contrast
// phone photos and does not change clean synthetic scans. Falls back to the original file.
function preprocessImage(file) {
  return new Promise(resolve => {
    const out = file + '.pre.png';
    execFile('convert', [file, '-colorspace', 'Gray', '-auto-level', '-adaptive-sharpen', '0x2', out], { timeout: 30000 }, err => resolve(err ? file : out));
  });
}
function runOcr(file) {
  return new Promise(resolve => {
    execFile('tesseract', [file, '-', '--psm', '4', 'tsv'], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve({ text: '', avgConf: 0 });
      let confs = [], lines = [];
      stdout.split('\n').slice(1).forEach(row => {
        const c = row.split('\t');
        if (c.length === 12 && c[11] && c[11].trim()) { confs.push(parseFloat(c[10]) || 0); lines.push(c[11]); }
      });
      const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
      resolve({ text: null, avgConf, words: lines }); // text rebuilt below
    });
  });
}
function ocrText(file) {
  return new Promise(resolve => {
    execFile('tesseract', [file, '-', '--psm', '4'], { timeout: 30000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}
// RapidOCR (PP-OCRv4 ONNX neural OCR) local bridge: one persistent python child so the
// model loads once per server run. Fully on-device: no network, no account, no data leaves.
// Falls back to null (tesseract only) when python/rapidocr is unavailable.
let rapidChild = null, rapidReady = false, rapidWaiters = [], rapidBuf = '';
function rapidProc() {
  if (rapidChild) return rapidChild;
  try {
    rapidChild = spawn('python3', [path.join(__dirname, 'scripts', 'rapid_ocr.py'), '--serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
    rapidChild.stdout.setEncoding('utf8');
    rapidChild.stdout.on('data', chunk => {
      rapidBuf += chunk;
      let i;
      while ((i = rapidBuf.indexOf('\n')) >= 0 && rapidWaiters.length) {
        const line = rapidBuf.slice(0, i); rapidBuf = rapidBuf.slice(i + 1);
        try { rapidWaiters.shift()(JSON.parse(line)); } catch { rapidWaiters.shift()(null); }
      }
    });
    rapidChild.on('exit', () => { rapidChild = null; rapidReady = false; while (rapidWaiters.length) rapidWaiters.shift()(null); });
    rapidReady = true;
  } catch { rapidChild = null; rapidReady = false; }
  return rapidChild;
}
function runRapidOcr(file) {
  return new Promise(resolve => {
    const p = rapidProc();
    if (!p || !rapidReady) return resolve(null);
    const timer = setTimeout(() => resolve(null), 60000);
    rapidWaiters.push(d => { clearTimeout(timer); resolve(d && typeof d.text === 'string' && d.text ? d : null); });
    try { p.stdin.write(file + '\n'); } catch { clearTimeout(timer); resolve(null); }
  });
}
const AI_BASE_URL = process.env.AI_BASE_URL || '';   // e.g. https://api.vultrinference.com/v1 or https://api.tokenfactory.nebius.com/v1
const AI_API_KEY  = process.env.AI_API_KEY || '';      // read from env only; never logged, never written to disk
const AI_MODEL    = process.env.AI_MODEL || '';        // e.g. qwen3.8-flash-next or Qwen/Qwen2-VL-72B-Instruct
const AI_MAX_REQUESTS = parseInt(process.env.AI_MAX_REQUESTS || '0', 10); // 0 = no application limit
const AI_USAGE_PATH = path.join(DATA, 'ai-usage.json');
const loadUsage = () => { try { return JSON.parse(fs.readFileSync(AI_USAGE_PATH, 'utf8')); } catch { return { requests: 0, prompt_tokens: 0, completion_tokens: 0 }; } };
const saveUsage = u2 => fs.writeFileSync(AI_USAGE_PATH, JSON.stringify(u2, null, 2));
const aiEnabled = () => !!(AI_BASE_URL && AI_API_KEY && AI_MODEL) && !(AI_MAX_REQUESTS > 0 && loadUsage().requests >= AI_MAX_REQUESTS);
// NOTE: this is an application-level stop rule (request count), not a provider-enforced spend cap.
// Vultr Serverless Inference billing is usage-based with no documented hard limit control.

// Line-item extraction from OCR text: "Name xN  12.34" per line; discounts are negative lines.
// Hardened for real photos: comma decimals, VAT band letters trailing the amount,
// common OCR digit confusions in the amount token, and "2 x 2.99" qty continuation lines.
// A line whose name looks like a discount but read positive is flagged, never silently negated.
const DISCOUNT_WORD = /offer|discount|saving|multibuy|reduction|promo/i;
// Returns {value, repaired} or null. A fused VAT band letter and a comma decimal are clean
// reads. Anything that needed character substitution or truncation is 'repaired' and the
// item is flagged for human review - malformed money is never silently treated as certain.
function cleanAmountToken(tok) {
  if (!tok) return null;
  const stripped = tok.replace(/[\u20ac\u00a2]/g, '').replace(/([.,]\d{2})[A-Za-z]$/, '$1');
  const dec = stripped.replace(',', '.');
  if (/^-?\d+\.\d{2}$/.test(dec)) return { value: parseFloat(dec), repaired: false };
  let r = stripped.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(',', '.');
  let repaired = r !== dec;
  if (/^-?\d+\.\d{3}$/.test(r)) { r = r.slice(0, -1); repaired = true; }
  if (repaired && /^-?\d+\.\d{2}$/.test(r)) return { value: parseFloat(r), repaired: true };
  return null;
}
function parseItems(text) {
  const items = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /total|vat|date:|thank|change|cash|card|street|deposits?\s+paid|savings|%/i.test(line)) continue;
    const qc = line.match(/^\s*(\d{1,2})\s*[xX]+\s*([\dOlISB|]+[.,][\dOlISB|]{2})\s*[A-Za-z]?$/);
    if (qc && items.length) { items[items.length - 1].qty = parseInt(qc[1], 10); continue; } // qty continuation line
    if (/^\d{1,2}[xX][\d.,]+\s+[\d.,]+[A-Za-z]?$/.test(line)) continue; // deposit-summary detail row ("1x0.15 0.15"), not an item
    const toks = line.split(/\s+/);
    if (toks.length < 2) continue;
    let amt = null, nameEnd = -1, repairedAmt = null;
    for (const take of [1, 2]) { // amount is last token, or second-to-last before a VAT band letter
      if (take === 2 && !/^[A-Za-z\u00a2\u00a9\u00ae\u20ac]$/.test(toks[toks.length - 1])) break;
      const v = cleanAmountToken(toks[toks.length - take]);
      if (v != null) { amt = v.value; repairedAmt = v.repaired ? toks[toks.length - take] : null; nameEnd = toks.length - take; break; }
    }
    if (amt == null || nameEnd < 1) continue;
    let name = toks.slice(0, nameEnd).join(' ').trim();
    if (!/[A-Za-z]/.test(name)) continue; // a bare number line is not an item
    let qty = 1;
    const qm = name.match(/^(.*?)\s+x(\d+)$/i);
    if (qm) { name = qm[1].trim(); qty = parseInt(qm[2], 10); }
    // unit-token letter/digit repair: OCR reads "1kg" as "lkg" etc. Names only, never amounts.
    name = name.replace(/\b[lI](kg|g|ml|cl|oz|lb)\b/gi, (m, u2) => '1' + u2);
    const it = { id: rid(4), name: name.slice(0, 60), qty, cents: Math.round(amt * 100) };
    const warns = [];
    if (repairedAmt) warns.push('amount was partly unreadable (read "' + repairedAmt + '") - check it against the receipt');
    if (it.cents > 0 && DISCOUNT_WORD.test(name)) warns.push('looks like a discount but read as positive - check the sign against the receipt');
    if (warns.length) it.warn = warns.join('; ');
    items.push(it);
  }
  return items;
}

// Deterministic cents allocation. The model NEVER computes money: extraction proposes items,
// code allocates. Remainder cents go one each to the first assignees (stable order).
function computeSplit(up) {
  const sp = up.split || { names: [], assignments: {} };
  const per = {}; (sp.names || []).forEach(n => { per[n] = 0; });
  if (sp.equalAll && (sp.names || []).length) {
    // Equal split divides the grand total so shares look equal (302/302/302), remainder cents to first names.
    const tot = (up.items || []).reduce((x, y) => x + y.cents, 0);
    const share = Math.floor(tot / sp.names.length);
    const rem = tot - share * sp.names.length;
    sp.names.forEach((n, i) => { per[n] = share + (i < rem ? 1 : 0); });
    return { perPerson: per, totalCents: tot, unassigned: [], unassignedCents: 0, payer: sp.payer || null };
  }
  let unassignedCents = 0; const unassigned = [];
  for (const it of up.items || []) {
    const a = (sp.assignments || {})[it.id] || [];
    const list = a.filter(n => (sp.names || []).includes(n));
    if (!list.length) { unassignedCents += it.cents; unassigned.push(it.name); continue; }
    const share = Math.floor(it.cents / list.length);
    const rem = it.cents - share * list.length;
    list.forEach((n, i) => { per[n] += share + (i < rem ? 1 : 0); });
  }
  const totalCents = Object.values(per).reduce((x, y) => x + y, 0);
  return { perPerson: per, totalCents, unassigned, unassignedCents, payer: sp.payer || null };
}

const CONFS = ['high', 'low', 'unreadable', 'not found', 'missing'];
const VAT_CONFS = ['high', 'unreadable', 'not found'];
function clampConf(c, isVat) {
  const set = isVat ? VAT_CONFS : CONFS;
  return set.includes(c) ? c : (c === 'missing' && !isVat ? 'missing' : (isVat ? 'not found' : 'low'));
}
// Parse the model's JSON strictly: numbers only when present, null when absent. Never invent values.
function fieldsFromModel(obj) {
  const num = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? parseFloat(v) : null);
  const txt = v => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 60) : null;
  const date = v => (typeof v === 'string' && /^[0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}$/.test(v.trim())) ? v.trim() : null;
  const conf = (obj.confidence || {});
  return {
    vendor: txt(obj.vendor), vendor_conf: clampConf(conf.vendor),
    date: date(obj.date), date_conf: clampConf(conf.date),
    total: num(obj.total_eur), total_conf: clampConf(conf.total_eur),
    vat: num(obj.vat_eur), vat_conf: clampConf(conf.vat_eur, true),
    model_notes: txt(obj.notes),
  };
}
async function extractWithModel(file) {
  // reserve the request slot synchronously, before any await, so concurrent uploads cannot race past the cap
  const u0 = loadUsage();
  u0.requests += 1;
  saveUsage(u0);
  const b64 = fs.readFileSync(file).toString('base64');
  const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const prompt = [
    'You are reading one receipt or invoice image for a bookkeeper.',
    'Return ONLY a JSON object with keys: vendor, date, total_eur, vat_eur, confidence, notes.',
    'vendor: merchant name as printed. date: purchase date as DD/MM/YYYY. total_eur and vat_eur: numbers in EUR.',
    'Use null for any field that is absent or that you cannot read. Never guess or compute a missing value.',
    'confidence: object with keys vendor, date, total_eur, vat_eur; each one of "high" (clearly legible), "low" (uncertain), "not found" (field absent), "unreadable" (present but illegible).',
    'notes: at most one short sentence about anything ambiguous, or null.',
  ].join(' ');
  const resp = await fetch(AI_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_API_KEY },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
      ] }],
      max_tokens: 400,
      temperature: 0,
    }),
  });
  if (!resp.ok) throw new Error('model API ' + resp.status);
  const data = await resp.json();
  const u2 = loadUsage();
  u2.prompt_tokens += data.usage?.prompt_tokens || 0;
  u2.completion_tokens += data.usage?.completion_tokens || 0;
  saveUsage(u2); // observed usage from the provider response, for real cost reporting
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model returned no JSON');
  return fieldsFromModel(JSON.parse(m[0]));
}

let extractChain = Promise.resolve();
function queueExtract(reqId, upId, storedAs) {
  extractChain = extractChain.then(() => extract(reqId, upId, storedAs)).catch(() => {});
  return extractChain;
}
async function extract(reqId, upId, storedAs) {
  const file = path.join(DATA, 'files', reqId, storedAs);
  const fresh0 = loadReq(reqId);
  if (!fresh0) return;
  if (aiEnabled()) {
    try {
      const fields = await extractWithModel(file);
      const fresh = loadReq(reqId); if (!fresh) return;
      const up = fresh.uploads.find(x => x.id === upId); if (!up) return;
      up.ocr = fields;
      up.ocr_engine = 'model:' + AI_MODEL + ' via ' + new URL(AI_BASE_URL).host;
      up.status = 'extracted';
      up.confirmation = null; // re-extraction invalidates any earlier confirmation
      saveReq(fresh);
      return;
    } catch (e) {
      const fr = loadReq(reqId); const fu = fr && fr.uploads.find(x => x.id === upId);
      if (fu) { fu.status = 'extract_failed'; fu.ocr_engine = 'model:' + AI_MODEL + ' (call failed)'; saveReq(fr); }
      return;
    }
  }
  if (AI_BASE_URL && AI_API_KEY && AI_MODEL && AI_MAX_REQUESTS > 0 && loadUsage().requests >= AI_MAX_REQUESTS) {
    const fr = loadReq(reqId); const fu = fr && fr.uploads.find(x => x.id === upId);
    if (fu) { fu.status = 'extract_failed'; fu.ocr_engine = 'model call skipped: AI_MAX_REQUESTS=' + AI_MAX_REQUESTS + ' reached'; saveReq(fr); }
    return;
  }
  // Two independent local engines read the photo: RapidOCR (neural) and tesseract (classical),
  // both on the original image first. The slower preprocessing rescue pass (grayscale/sharpen +
  // a second tesseract read) runs only when the first pass is weak - it rescues low-contrast
  // phone photos but doubles runtime, so it is not spent on receipts that already read well.
  // recovered item lines dominate; total confidence breaks ties; avgConf is a hair tiebreak.
  // A confident total with zero items must never beat a full item list with a weaker total.
  const scoreOf = (ocr, items, avgConf) => items.length * 10 + (ocr.total_conf === 'high' ? 5 : ocr.total_conf === 'low' ? 2 : 0) + (avgConf || 0) / 1000;
  let best = null;
  const consider = (text, avgConf, engine) => {
    if (!text) return;
    const ocr = parseReceipt(text, avgConf || 0);
    const items = parseItems(text);
    const score = scoreOf(ocr, items, avgConf);
    if (!best || score > best.score) best = { ocr, items, avgConf: avgConf || 0, score, engine };
  };
  console.log('[extract]', upId, 'start', file);
  const [ro, t1, t1c] = await Promise.all([runRapidOcr(file), ocrText(file), runOcr(file)]);
  console.log('[extract]', upId, 'engines done', 'rapid=' + (ro ? ro.text.length : 'null'), 'tess=' + (t1 || '').length);
  if (ro && ro.text) consider(ro.text, ro.avgConf || 0, 'rapidocr-local (PP-OCRv4 neural OCR)');
  consider(t1, t1c.avgConf || 0, 'tesseract-local');
  if (!best || best.ocr.total_conf !== 'high' || !best.items.length) {
    const pre = await preprocessImage(file);
    if (pre !== file) {
      const [t2, t2c] = await Promise.all([ocrText(pre), runOcr(pre)]);
      consider(t2, t2c.avgConf || 0, 'tesseract-local (preprocessed)');
    }
  }
  console.log('[extract]', upId, 'best', best && best.engine, best && best.score);
  const fresh = loadReq(reqId);
  if (!fresh) return;
  const up = fresh.uploads.find(x => x.id === upId);
  if (!up) return;
  up.ocr = best.ocr;
  up.items = best.items;
  up.photoWarning = (!up.items.length || best.avgConf < 45 || (up.ocr && up.ocr.total_conf !== 'high'))
    ? 'This photo was hard to read automatically. Retake it flat, straight and in good light, or expect to correct the items below. Nothing here is final until a person confirms it.'
    : null;
  up.ocr_engine = best.engine || 'tesseract-local';
  up.status = 'extracted';
  up.confirmation = null; // re-extraction invalidates any earlier confirmation
  saveReq(fresh);
}

function send(res, code, body, type = 'application/json') {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > cap) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function page(name) { return fs.readFileSync(path.join(PUB, name), 'utf8'); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '?';
  try {
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, page('index.html'), 'text/html');
    if (req.method === 'GET' && u.pathname === '/style.css') return send(res, 200, page('style.css'), 'text/css');

    if (req.method === 'POST' && u.pathname === '/api/requests') {
      const b = JSON.parse((await readBody(req, 64e3)).toString() || '{}');
      const isSplit = b.mode === 'split';
      if (!b.title || (!isSplit && (!Array.isArray(b.clients) || !b.clients.length))) return send(res, 400, { error: 'title and at least one expected client are required' });
      const dueMs = Date.parse(b.due || '') || null;
      let expMs = Date.now() + EXPIRY_DAYS * 864e5;
      let expiryNote = null;
      if (dueMs && dueMs + 2 * 864e5 > expMs) {
        expMs = dueMs + 2 * 864e5; // never expire silently before the due date; 2-day grace after it
        expiryNote = 'The link stays live until 2 days after your due date (' + new Date(expMs).toDateString() + ').';
      }
      const r = {
        id: rid(9), slug: rid(6).toLowerCase(), token: rid(24),
        title: String(b.title).slice(0, 120), need: String(b.need || '').slice(0, 300),
        mode: isSplit ? 'split' : 'collect',
        clients: (Array.isArray(b.clients) ? b.clients : []).map(c => String(c).slice(0, 60)).slice(0, 50), due: String(b.due || '').slice(0, 20),
        createdAt: new Date().toISOString(), expiresAt: new Date(expMs).toISOString(),
        uploads: [],
      };
      saveReq(r);
      return send(res, 200, { uploadPath: '/r/' + r.slug, ownerPath: '/o/' + r.token, expiresAt: r.expiresAt, expiryNote });
    }

    const mUp = u.pathname.match(/^\/r\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && mUp) return send(res, 200, page('upload.html'), 'text/html');

    if (req.method === 'GET' && u.pathname.startsWith('/api/request/')) {
      const r = findBySlug(u.pathname.split('/').pop());
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      return send(res, 200, { title: r.title, need: r.need, due: r.due, expiresAt: r.expiresAt });
    }

    const mPost = u.pathname.match(/^\/api\/upload\/([a-z0-9_-]+)$/i);
    if (req.method === 'POST' && mPost) {
      const r = findBySlug(mPost[1]);
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      if (!rateOk(ip + ':' + r.slug)) return send(res, 429, { error: 'too many uploads from this connection; try later' });
      const filename = String(u.searchParams.get('filename') || 'receipt.png');
      const body = await readBody(req, MAX_BYTES);
      if (!body.length) return send(res, 400, { error: 'empty file' });
      const isPng = body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isJpg = body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
      if (!isPng && !isJpg) return send(res, 415, { error: 'file content is not a PNG or JPG image' });
      const ext = isPng ? '.png' : '.jpg';
      const up = { id: rid(6), name: filename.slice(0, 120), storedAs: rid(12) + ext, uploader: String(u.searchParams.get('uploader') || 'Anonymous').slice(0, 60), uploadedAt: new Date().toISOString(), status: 'processing', ocr: null, review: null };
      const dir = path.join(DATA, 'files', r.id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, up.storedAs), body);
      r.uploads.push(up); saveReq(r);
      queueExtract(r.id, up.id, up.storedAs).catch(() => {
        const fr = loadReq(r.id); const fu = fr && fr.uploads.find(x => x.id === up.id);
        if (fu) { fu.status = 'extract_failed'; saveReq(fr); }
      });
      return send(res, 200, { ok: true, id: up.id });
    }

    const mOwn = u.pathname.match(/^\/o\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && mOwn) return send(res, 200, page('owner.html'), 'text/html');

    if (req.method === 'GET' && u.pathname.startsWith('/api/owner/')) {
      const r = findByToken(u.pathname.split('/').pop());
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      const seen = new Set(r.uploads.map(x => x.uploader.toLowerCase()));
      return send(res, 200, {
        title: r.title, need: r.need, due: r.due, expiresAt: r.expiresAt, expired: expired(r),
        uploadPath: '/r/' + r.slug,
        clients: r.clients.map(c => ({ name: c, received: seen.has(c.toLowerCase()) })),
        uploads: r.uploads.map(x => ({ id: x.id, name: x.name, uploader: x.uploader, uploadedAt: x.uploadedAt, status: x.status, ocr: x.ocr, ocr_engine: x.ocr_engine || null, review: x.review })),
      });
    }

    const mSplit = u.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && mSplit) return send(res, 200, page('split.html'), 'text/html');

    const mSplitApi = u.pathname.match(/^\/api\/split\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (mSplitApi) {
      const r = findByToken(mSplitApi[1]);
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      const up = r.uploads.find(x => x.id === mSplitApi[2]);
      if (!up) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') {
        const receiptCents = receiptCentsOf(up);
        const itemSum = (up.items || []).reduce((x, y) => x + y.cents, 0);
        return send(res, 200, {
          title: r.title, file: up.name, status: up.status, engine: up.ocr_engine || null,
          vendor: (up.review?.reviewed ? up.review.vendor : up.ocr?.vendor) || null,
          receiptCents, itemSumCents: itemSum,
          totalSource: up.review?.reviewed ? 'entered by a person' : (up.ocr?.total != null ? 'read by OCR (' + (up.ocr.total_conf || 'low') + ' confidence)' : 'missing'),
          photoWarning: up.photoWarning || null,
          confirmed: confirmationValid(up), staleConfirmation: !!up.confirmation && !confirmationValid(up),
          sumMatchesReceipt: receiptCents == null ? null : receiptCents === itemSum,
          items: up.items || [], split: up.split || { names: [], assignments: {}, equalAll: false, payer: null },
          computed: computeSplit(up),
        });
      }
      if (req.method === 'POST') {
        if (up.status === 'processing') return send(res, 409, { error: 'extraction still in progress' });
        const b = JSON.parse((await readBody(req, 32e3)).toString() || '{}');
        const names = (Array.isArray(b.names) ? b.names : []).map(n => String(n).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
        const sp = up.split || { assignments: {} };
        sp.names = [...new Set(names)];
        sp.payer = sp.names.includes(b.payer) ? b.payer : null;
        sp.equalAll = !!b.equalAll;
        const asg = {};
        if (b.assignments && typeof b.assignments === 'object') {
          for (const [k, v] of Object.entries(b.assignments)) {
            if ((up.items || []).some(it => it.id === k) && Array.isArray(v)) asg[k] = v.filter(n => sp.names.includes(n));
          }
        }
        sp.assignments = asg;
        // item corrections: name/cents edits only for existing item ids
        if (Array.isArray(b.items)) {
          for (const e of b.items) {
            const it = (up.items || []).find(x => x.id === e.id);
            if (!it) continue;
            if (typeof e.name === 'string' && e.name.trim()) it.name = e.name.trim().slice(0, 60);
            if (typeof e.cents === 'number' && isFinite(e.cents)) {
              const nc = Math.round(e.cents);
              if (nc !== it.cents) { it.cents = nc; delete it.warn; } // a person's edit supersedes the extraction warning
            }
            if (typeof e.qty === 'number' && e.qty >= 1 && e.qty <= 99) it.qty = Math.round(e.qty);
          }
        }
        if (b.confirm === true) {
          const rc0 = receiptCentsOf(up);
          if (rc0 == null) return send(res, 400, { error: 'no receipt total to confirm - set the total first' });
          up.confirmation = { totalCents: rc0, itemHash: itemsHash(up.items), confirmedAt: new Date().toISOString() };
        }
        const check = computeSplit({ items: up.items, split: sp });
        const neg = Object.entries(check.perPerson).find(([, c]) => c < 0);
        if (neg) return send(res, 400, { error: neg[0] + ' would end up at -' + (Math.abs(neg[1]) / 100).toFixed(2) + ' EUR. A discount or negative line cannot exceed that person\'s items. Reassign it to the people whose purchases it belongs to, or share it explicitly.' });
        up.split = sp;
        saveReq(r);
        const receiptCents = receiptCentsOf(up);
        const itemSum = (up.items || []).reduce((x, y) => x + y.cents, 0);
        return send(res, 200, { ok: true, items: up.items, split: sp, computed: computeSplit(up), receiptCents, itemSumCents: itemSum, sumMatchesReceipt: receiptCents == null ? null : receiptCents === itemSum, confirmed: confirmationValid(up), staleConfirmation: !!up.confirmation && !confirmationValid(up) });
      }
    }

    const mSplitCsv = u.pathname.match(/^\/api\/split-csv\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && mSplitCsv) {
      const r = findByToken(mSplitCsv[1]);
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      const up = r.uploads.find(x => x.id === mSplitCsv[2]);
      if (!up) return send(res, 404, { error: 'not found' });
      const c = computeSplit(up);
      if (!(up.items || []).length) return send(res, 409, { error: 'no items extracted yet' });
      if (c.unassigned.length) return send(res, 409, { error: c.unassigned.length + ' item(s) not assigned to anyone yet', unassigned: c.unassigned });
      const rcEarly = receiptCentsOf(up);
      if (rcEarly != null && rcEarly !== c.totalCents) return send(res, 409, { error: 'items add up to ' + (c.totalCents / 100).toFixed(2) + ' EUR but the receipt total reads ' + (rcEarly / 100).toFixed(2) + ' EUR; correct the items before exporting' });
      if (!confirmationValid(up)) return send(res, 409, { error: 'receipt total and item-list completeness are not confirmed yet; check the receipt against the item list and confirm before exporting' });
      const esc = v => {
        let s2 = String(v ?? '');
        if (/^[=+\-@\t]/.test(s2)) s2 = "'" + s2;
        return '"' + s2.replace(/"/g, '""') + '"';
      };
      const sp = up.split || {};
      const rows = [['type', 'item_or_person', 'qty', 'eur', 'assigned_to'].map(esc).join(',')];
      for (const it of up.items) {
        const a = sp.equalAll ? sp.names : (sp.assignments[it.id] || []);
        rows.push(['item', it.name, it.qty, (it.cents / 100).toFixed(2), a.join(' + ')].map(esc).join(','));
      }
      for (const [n, cents] of Object.entries(c.perPerson)) rows.push(['share', n, '', (cents / 100).toFixed(2), n === c.payer ? 'payer' : 'owes ' + (c.payer || '')].map(esc).join(','));
      const rc = receiptCentsOf(up);
      rows.push(['reconciliation', 'split_total_eur', '', (c.totalCents / 100).toFixed(2), rc == null ? 'receipt total unknown' : (rc === c.totalCents ? 'matches receipt total' : 'DIFFERS from receipt total ' + (rc / 100).toFixed(2))].map(esc).join(','));
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="onelink-split.csv"' });
      return res.end(rows.join('\n'));
    }

    const mFile = u.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && mFile) {
      const r = findByToken(mFile[1]);
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      const up = r.uploads.find(x => x.id === mFile[2]);
      if (!up) return send(res, 404, { error: 'not found' });
      const fp = path.join(DATA, 'files', r.id, up.storedAs);
      if (!fs.existsSync(fp)) return send(res, 404, { error: 'file gone' });
      return send(res, 200, fs.readFileSync(fp), ALLOWED_EXT[path.extname(up.storedAs).toLowerCase()] || 'application/octet-stream');
    }

    const mRev = u.pathname.match(/^\/api\/review\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'POST' && mRev) {
      const r = findByToken(mRev[1]);
      if (!r) return send(res, 404, { error: 'not found' });
      const up = r.uploads.find(x => x.id === mRev[2]);
      if (!up) return send(res, 404, { error: 'not found' });
      if (up.status === 'processing') return send(res, 409, { error: 'extraction still in progress for this upload; try again in a few seconds' });
      const b = JSON.parse((await readBody(req, 16e3)).toString() || '{}');
      up.review = {
        vendor: String(b.vendor ?? up.ocr?.vendor ?? '').slice(0, 80),
        date: String(b.date ?? up.ocr?.date ?? '').slice(0, 20),
        total: b.total === '' || b.total == null ? (up.ocr?.total ?? null) : Number(b.total),
        vat: b.vat === '' || b.vat == null ? (up.ocr?.vat ?? null) : Number(b.vat),
        reviewed: !!b.reviewed, reviewedAt: new Date().toISOString(),
      };
      saveReq(r);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && u.pathname.startsWith('/api/export/')) {
      const r = findByToken(u.pathname.split('/').pop());
      if (!r) return send(res, 404, { error: 'not found' });
      if (expired(r)) return send(res, 410, { error: 'this request link has expired' });
      const busy = r.uploads.filter(x => x.status === 'processing');
      if (busy.length) return send(res, 409, { error: busy.length + ' upload(s) still being extracted; wait a few seconds', processing: busy.map(x => x.name) });
      const pending = r.uploads.filter(x => !x.review?.reviewed);
      if (pending.length) return send(res, 409, { error: pending.length + ' upload(s) are not reviewed yet', unreviewed: pending.map(x => x.name) });
      // escape spreadsheet formula injection: prefix dangerous leading characters
      const esc = v => {
        let s2 = String(v ?? '');
        if (/^[=+\-@\t]/.test(s2)) s2 = "'" + s2;
        return '"' + s2.replace(/"/g, '""') + '"';
      };
      const rows = [['upload_id', 'uploader', 'file', 'vendor', 'date', 'total_eur', 'vat_eur', 'field_confidence', 'reviewed', 'value_source'].map(esc).join(',')];
      for (const x of r.uploads) {
        const v = x.review;
        const conf = x.ocr ? [x.ocr.vendor_conf, x.ocr.date_conf, x.ocr.total_conf, x.ocr.vat_conf].join('/') : 'none';
        rows.push([x.id, x.uploader, x.name, v.vendor, v.date, v.total, v.vat, conf, true, 'owner-reviewed'].map(esc).join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="onelink-export.csv"' });
      return res.end(rows.join('\n'));
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: 'server error' });
  }
});
if (require.main === module) {
  sweepExpired();
  setInterval(sweepExpired, 3600e3).unref();
  // recover uploads whose OCR was interrupted (e.g. process restart mid-extraction)
  for (const f of fs.readdirSync(DATA).filter(f => f.endsWith('.json'))) {
    const r = loadReq(f.replace(/\.json$/, ''));
    if (r) for (const up of r.uploads) if (up.status === 'processing') queueExtract(r.id, up.id, up.storedAs).catch(() => {});
  }
  server.listen(PORT, () => console.log('OneLink Intake local demo on http://127.0.0.1:' + PORT));
}
module.exports = { parseItems, parseTotal, parseReceipt }; // for unit tests
