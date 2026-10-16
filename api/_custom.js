// ═══════════════════════════════════════════════════════════════
// СВОЙ ПРОВАЙДЕР: юзер сам вписал адрес, ключ и модель.
// Форматы всех провайдеров не угадать, поэтому говорим на двух общепринятых «языках»:
//   images — как у OpenAI: POST {base}/images/generations (рефы — /images/edits файлами)
//   chat   — картинка в ответе чат-ручки: POST {base}/chat/completions (рефы — image_url)
// Какой язык сработал — запоминаем в Redis на пару «адрес+модель», чтобы не гадать каждый раз.
// Если провайдер не принял референсы — рисуем без них и сообщаем об этом (note: 'no_refs').
//
// Файл с подчёркиванием: Vercel НЕ публикует его как маршрут, его только импортирует generate.js.
// ═══════════════════════════════════════════════════════════════
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const GEN_TIMEOUT_MS = 240000;      // сама генерация (лимит функции — 300с)
const DL_TIMEOUT_MS = 30000;        // скачать готовую картинку по ссылке
const MAX_BYTES = 30 * 1024 * 1024; // предел ответа: не даём залить в функцию что угодно
const RATE_LIMIT = 40;              // запросов на юзера…
const RATE_WINDOW_S = 600;          // …за 10 минут

// Ошибка с готовым текстом для карточки (заголовок + совет)
export function igError(title, advice, retry = true, detail = '') {
  const e = new Error(detail || title);
  e.igTitle = title; e.igAdvice = advice; e.igRetry = retry;
  return e;
}

// ---------- Защита: никаких локальных и внутренних адресов ----------
function isPrivateIp(addr) {
  if (net.isIPv4(addr)) {
    const p = addr.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||   // CGNAT
      (p[0] === 169 && p[1] === 254) ||                 // link-local, метаданные облака
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      p[0] >= 224;                                      // multicast и зарезервированные
  }
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    if (a === '::' || a === '::1') return true;
    if (a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true;
    const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // не разобрали — считаем опасным
}

// Проверяем адрес и возвращаем нормализованную базу (без хвоста /chat/completions и т.п.)
export async function checkUrl(raw, { isBase = true } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) {
    throw igError('Адрес провайдера написан с ошибкой', 'Он должен выглядеть так: https://api.example.com/v1', false);
  }
  if (u.protocol !== 'https:') throw igError('Нужен адрес с https://', 'Небезопасные адреса (http://) не принимаем. Проверь адрес провайдера.', false);
  if (u.username || u.password) throw igError('В адресе не должно быть логина и пароля', 'Ключ вписывается в отдельное поле.', false);
  if (u.port && u.port !== '443') throw igError('Нестандартный порт в адресе', 'Подходят только обычные адреса https:// без номера порта.', false);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(local|localhost|internal|lan|home|corp)$/.test(host) || !host.includes('.') && !net.isIP(host)) {
    throw igError('Это внутренний адрес', 'Подходят только публичные адреса провайдеров в интернете.', false);
  }
  let addrs = [];
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map(x => x.address); }
    catch (e) { throw igError('Адрес провайдера не найден', 'Такого сайта нет — проверь адрес на опечатки.', false); }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw igError('Это внутренний адрес', 'Подходят только публичные адреса провайдеров в интернете.', false);
  if (!isBase) return u.toString();
  // юзеры часто вставляют полный адрес ручки — отрезаем хвост, оставляем базу
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(images\/generations|images\/edits|chat\/completions|models)$/i, '');
  return u.origin + path;
}

// fetch без переходов по редиректам (иначе можно увести запрос во внутреннюю сеть) и с пределом размера
async function safeFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, opts, { redirect: 'manual', signal: ctrl.signal }));
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) throw igError('Провайдер прислал слишком большой ответ', 'Попробуй другую модель.', true);
    return res;
  } catch (e) {
    if (e && e.igTitle) throw e;
    if (e && e.name === 'AbortError') throw igError('Провайдер не успел ответить', 'Генерация шла дольше 4 минут. Нажми ещё раз или выбери модель побыстрее.', true);
    throw igError('Адрес провайдера не отвечает', 'Сервер провайдера недоступен. Проверь адрес или попробуй позже.', true, String(e && e.message || e));
  } finally { clearTimeout(to); }
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const b = Buffer.from(await res.arrayBuffer()); if (b.length > MAX_BYTES) throw igError('Провайдер прислал слишком большой ответ', 'Попробуй другую модель.'); return b; }
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { try { reader.cancel(); } catch (e) {} throw igError('Провайдер прислал слишком большой ответ', 'Попробуй другую модель.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Ссылку на готовую картинку тоже проверяем: провайдер мог прислать что угодно
async function downloadImage(url) {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    await checkUrl(cur, { isBase: false });
    const res = await safeFetch(cur, { headers: { Accept: 'image/*' } }, DL_TIMEOUT_MS);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).toString(); continue; }
    if (!res.ok) throw igError('Не удалось скачать картинку у провайдера', 'Нажми ещё раз.', true, 'download HTTP ' + res.status);
    return (await readCapped(res)).toString('base64');
  }
  throw igError('Не удалось скачать картинку у провайдера', 'Слишком много переадресаций.', true);
}

// ---------- Ограничение частоты: чужой сервер нельзя долбить через нас ----------
export async function rateLimit(redis, userId) {
  if (!redis) return;
  try {
    const k = 'crl:' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, RATE_WINDOW_S);
    if (n > RATE_LIMIT) throw igError('Слишком много запросов подряд', 'Подожди несколько минут и попробуй снова.', true);
  } catch (e) { if (e && e.igTitle) throw e; }
}

// ---------- Разбор ответа: картинка может прийти в разных местах ----------
const DATA_RE = /data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)/;
const URL_RE = /(https:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?)/i;
async function extractImage(j) {
  if (!j || typeof j !== 'object') return null;
  // как у OpenAI images
  const d0 = Array.isArray(j.data) ? j.data[0] : null;
  if (d0 && d0.b64_json) return String(d0.b64_json);
  if (d0 && d0.url) return d0.url.startsWith('data:') ? (d0.url.match(DATA_RE) || [])[1] : await downloadImage(d0.url);
  // чат: message.images (OpenRouter), части content, строка с data:/ссылкой
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  if (msg) {
    const parts = [].concat(Array.isArray(msg.images) ? msg.images : [], Array.isArray(msg.content) ? msg.content : []);
    for (const p of parts) {
      const u = (p && p.image_url && (p.image_url.url || p.image_url)) || (p && p.url);
      if (typeof u === 'string') { const m = u.match(DATA_RE); if (m) return m[1]; if (/^https:/i.test(u)) return await downloadImage(u); }
      if (p && p.source && p.source.data) return String(p.source.data);
      if (p && p.inline_data && p.inline_data.data) return String(p.inline_data.data);
      if (p && p.b64_json) return String(p.b64_json);
    }
    if (typeof msg.content === 'string') {
      const m = msg.content.match(DATA_RE); if (m) return m[1];
      const u = msg.content.match(URL_RE); if (u) return await downloadImage(u[1]);
    }
  }
  if (j.image && typeof j.image === 'string') { const m = j.image.match(DATA_RE); return m ? m[1] : j.image; }
  return null;
}

// Что провайдер сказал об ошибке — одной строкой
function errText(j, status) {
  const e = j && (j.error || j.detail || j.message);
  const s = typeof e === 'string' ? e : (e && (e.message || e.msg)) || '';
  return (s || ('HTTP ' + status)).slice(0, 400);
}

// «Этот язык провайдер не понимает» — тогда пробуем второй
function isDialectMiss(status, msg) {
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (status === 400 || status === 422) return /not\s*(supported|found|available)|unsupported|unknown|invalid (url|endpoint|request)|does not support|no endpoint|modalit|image generation/i.test(msg);
  return false;
}
// «Картинки на входе не принимаем»
function isRefsMiss(status, msg) {
  return (status === 400 || status === 415 || status === 422) && /image|vision|multimodal|input|content type|unsupported|not support/i.test(msg);
}

// Ошибки провайдера → понятный текст
function providerError(status, msg) {
  if (status === 401 || status === 403) return igError('Провайдер не принял ключ', 'Проверь ключ на сайте: без пробелов и лишних символов. Ключ должен быть от этого же провайдера.', false, msg);
  if (status === 404) return igError('Провайдер не нашёл модель или ручку', 'Проверь название модели (лучше выбрать из списка на сайте) и адрес — обычно он оканчивается на /v1.', false, msg);
  if (status === 402 || /insufficient|balance|credit|quota exceeded|payment/i.test(msg)) return igError('Закончились деньги или кредиты у провайдера', 'Пополни баланс у провайдера и нажми ещё раз.', false, msg);
  if (status === 429) return igError('Лимит запросов у провайдера', 'Подожди минуту и нажми ещё раз.', true, msg);
  if (/safety|moderation|content[_ ]policy|blocked|nsfw|filtered/i.test(msg)) return igError('Провайдер отказался рисовать эту сцену', 'Сработал фильтр провайдера. Смягчи сцену или выбери другую модель.', true, msg);
  if (status >= 500) return igError('Ошибка на стороне провайдера', 'Его сервер сейчас сбоит. Нажми ещё раз чуть позже.', true, msg);
  return igError('Провайдер вернул ошибку', msg || ('Код ' + status), true, msg);
}

function aspectWords(ar) {
  const m = String(ar || '').match(/^(\d+):(\d+)$/);
  if (!m) return '';
  const w = +m[1], h = +m[2];
  const shape = w > h ? 'landscape (wide)' : w < h ? 'portrait (tall)' : 'square';
  return ` Image aspect ratio ${w}:${h}, ${shape} composition.`;
}

function headers(key) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }; }

// ---------- Язык 1: images (как у OpenAI) ----------
async function viaImages({ base, key, model, prompt, promptRefs, refs }) {
  if (refs.length) {
    // рефы — через /images/edits файлами (умеют не все модели)
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', promptRefs); fd.append('n', '1');
    refs.forEach((du, i) => {
      const m = du.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/);
      if (m) fd.append(refs.length > 1 ? 'image[]' : 'image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `ref${i}.${m[1].split('/')[1].replace('jpeg', 'jpg')}`);
    });
    const res = await safeFetch(base + '/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd }, GEN_TIMEOUT_MS);
    const j = await parseJson(res);
    if (res.ok) { const b64 = await extractImage(j); if (b64) return { b64, refsUsed: true }; }
    const msg = errText(j, res.status);
    if (!(res.status === 404 || res.status === 405 || isRefsMiss(res.status, msg) || isDialectMiss(res.status, msg))) throw providerError(res.status, msg);
    console.log(`   ℹ️ images/edits не принял рефы (${res.status}) — рисую без них`);
  }
  const res = await safeFetch(base + '/images/generations', { method: 'POST', headers: headers(key), body: JSON.stringify({ model, prompt, n: 1 }) }, GEN_TIMEOUT_MS);
  const j = await parseJson(res);
  if (!res.ok) { const e = providerError(res.status, errText(j, res.status)); e.status = res.status; e.miss = isDialectMiss(res.status, errText(j, res.status)); throw e; }
  const b64 = await extractImage(j);
  if (!b64) { const e = igError('Провайдер ответил без картинки', 'Похоже, эта модель не рисует. Выбери модель для картинок.', false, JSON.stringify(j).slice(0, 300)); e.miss = true; throw e; }
  return { b64, refsUsed: false };
}

// ---------- Язык 2: чат с картинкой в ответе ----------
async function viaChat({ base, key, model, prompt, promptRefs, refs }) {
  const send = async (withRefs, withModalities) => {
    const content = [{ type: 'text', text: withRefs ? promptRefs : prompt }];
    if (withRefs) refs.forEach(du => content.push({ type: 'image_url', image_url: { url: du } }));
    const body = { model, messages: [{ role: 'user', content }] };
    if (withModalities) body.modalities = ['image', 'text']; // OpenRouter без этого не отдаёт картинку
    const res = await safeFetch(base + '/chat/completions', { method: 'POST', headers: headers(key), body: JSON.stringify(body) }, GEN_TIMEOUT_MS);
    return { res, j: await parseJson(res) };
  };
  let withModalities = true;
  let { res, j } = await send(refs.length > 0, withModalities);
  if (!res.ok && /modalit/i.test(errText(j, res.status))) { withModalities = false; ({ res, j } = await send(refs.length > 0, false)); }
  let refsUsed = refs.length > 0;
  if (!res.ok && refsUsed && isRefsMiss(res.status, errText(j, res.status))) {
    console.log(`   ℹ️ чат не принял рефы (${res.status}) — рисую без них`);
    refsUsed = false; ({ res, j } = await send(false, withModalities));
  }
  if (!res.ok) { const m = errText(j, res.status); const e = providerError(res.status, m); e.status = res.status; e.miss = isDialectMiss(res.status, m); throw e; }
  const b64 = await extractImage(j);
  if (!b64) { const e = igError('Провайдер ответил текстом, а не картинкой', 'Эта модель, похоже, не рисует. Выбери модель для генерации изображений.', false, JSON.stringify(j).slice(0, 300)); e.miss = true; throw e; }
  return { b64, refsUsed };
}

async function parseJson(res) {
  const buf = await readCapped(res);
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return { error: buf.toString('utf8').slice(0, 300) }; }
}

// Модели, которые почти наверняка рисуют через чат (gemini-image и родня) — начинаем с чата
function chatFirst(model) { return /gemini|nano|banana|image-preview|flash-image|gpt-4o|chatgpt/i.test(model); }

// ---------- Главная функция ----------
// Возвращает { b64, note } — note: 'no_refs', если референсы не прошли.
export async function generateCustom({ base, key, model, prompt, faceLock, refs, aspectRatio, redis }) {
  if (!model) throw igError('Не указана модель', 'Впиши название модели на сайте и пересобери плагин.', false);
  const fullPrompt = prompt + aspectWords(aspectRatio);
  const promptRefs = (faceLock || '') + fullPrompt; // «копируй лица» — только вместе с самими рефами
  const dkey = 'cdial:' + crypto.createHash('sha256').update(base + '|' + model).digest('hex').slice(0, 32);
  let known = null;
  if (redis) { try { known = await redis.get(dkey); } catch (e) {} }
  const order = known ? [known, known === 'chat' ? 'images' : 'chat'] : (chatFirst(model) ? ['chat', 'images'] : ['images', 'chat']);
  console.log(`🧭 Свой провайдер: ${new URL(base).host}, модель ${model}, порядок ${order.join('→')}${known ? ' (запомнен)' : ''}`);

  let firstErr = null;
  for (const dialect of order) {
    try {
      const r = dialect === 'images'
        ? await viaImages({ base, key, model, prompt: fullPrompt, promptRefs, refs })
        : await viaChat({ base, key, model, prompt: fullPrompt, promptRefs, refs });
      if (redis && known !== dialect) { try { await redis.set(dkey, dialect, 'EX', 30 * 86400); } catch (e) {} }
      console.log(`✅ Язык «${dialect}» сработал${refs.length ? (r.refsUsed ? ', рефы приняты' : ', рефы НЕ приняты') : ''}`);
      return { b64: r.b64, note: (refs.length && !r.refsUsed) ? 'no_refs' : '' };
    } catch (e) {
      console.warn(`   «${dialect}» не подошёл: ${e.igTitle || e.message}${e.status ? ' (HTTP ' + e.status + ')' : ''}`);
      if (!e.miss) throw e;              // ключ, деньги, фильтр, таймаут — второй язык не поможет
      if (!firstErr) firstErr = e;
    }
  }
  throw firstErr || igError('Провайдер не понял запрос', 'Он не поддерживает ни формат OpenAI images, ни картинки через чат.', false);
}
