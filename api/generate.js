// ═══════════════════════════════════════════════════════════════
// NAISTERA PROXY для Tavo — генерация картинок через naistera.org
// База: твой картиночный прокси (расшифровка DATA, ImgBB, кэш, реролл, SVG-ошибки).
// API Naistera: POST /api/generate, Bearer <токен>, reference_images = массив data URL (до 5),
// ответ { data_url: "data:image/png;base64,..." }.
// Модели с рефами: "nano banana 2" (дефолт), "grok". БЕЗ рефов: "novelai", "grok-pro".
// ═══════════════════════════════════════════════════════════════

import { createRequire } from 'module';

import Redis from 'ioredis';

import crypto from 'crypto';

const require = createRequire(import.meta.url);

export const maxDuration = 300;

// ---------- SVG-ошибка ----------
function errorSvg(res, title, advice) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Перенос строк для совета
  const wrap = (text, max) => {
    const words = String(text).split(' ');
    const out = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > max) { out.push(line.trim()); line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) out.push(line.trim());
    return out;
  };
  const titleLines = wrap(title, 48);
  const adviceLines = advice ? wrap(advice, 56) : [];
  const lineH = 20;
  let y = 70;
  const titleRows = titleLines.map((l,i) =>
    `<text x="340" y="${y + i*22}" font-family="system-ui,sans-serif" font-size="16" font-weight="600" fill="#f0e6ff" text-anchor="middle">${esc(l)}</text>`
  ).join('\n  ');
  y += titleLines.length * 22 + 8;
  const adviceRows = adviceLines.map((l,i) =>
    `<text x="340" y="${y + i*lineH}" font-family="system-ui,sans-serif" font-size="13" fill="#9d8fc4" text-anchor="middle">${esc(l)}</text>`
  ).join('\n  ');
  const totalH = Math.max(160, y + adviceLines.length * lineH + 24);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="${totalH}" viewBox="0 0 680 ${totalH}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1018"/>
      <stop offset="100%" stop-color="#120a14"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect width="680" height="${totalH}" rx="16" fill="url(#bg)" stroke="url(#accent)" stroke-width="1.5" stroke-opacity="0.4"/>
  <circle cx="340" cy="34" r="14" fill="none" stroke="url(#accent)" stroke-width="2">
    <animate attributeName="stroke-opacity" values="1;0.3;1" dur="1.8s" repeatCount="indefinite"/>
  </circle>
  <text x="340" y="40" font-family="system-ui,sans-serif" font-size="16" fill="#ec4899" text-anchor="middle">!</text>
  ${titleRows}
  ${adviceRows}
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.status(200).send(svg);
}

// ---------- Понятные ошибки ----------
function friendlyError(raw) {
  const f = friendlyErrorObj(raw);
  return f.advice ? `${f.title} — ${f.advice}` : f.title;
}

function friendlyErrorObj(raw) {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/daily credit limit/i.test(s))
    return {title:'Закончились дневные кредиты', advice:'Подожди до завтра или пополни баланс на naistera.org'};
  if (/insufficient credits/i.test(s))
    return {title:'Недостаточно кредитов', advice:'Пополни баланс на naistera.org'};
  if (/IMAGE_OTHER/i.test(s) || (/blocked/i.test(s) && /OTHER/i.test(s)))
    return {title:'Контент заблокирован фильтром', advice:'Упрости промт, замени референс на нейтральный или смени модель'};
  if (/IMAGE_SAFETY/i.test(s) || /safety/i.test(s))
    return {title:'Контент заблокирован по безопасности', advice:'Измени описание сцены и попробуй снова'};
  if (/blocked/i.test(s) && /refunded/i.test(s))
    return {title:'Заблокировано фильтром', advice:'Кредиты возвращены. Попробуй другой промт или модель'};
  if (/possibly filtered/i.test(s) || /No images? (in response|generated)/i.test(s))
    return {title:'Модель не вернула картинку', advice:'Скорее всего цензура. Упрости промт, облегчи референс (<1 МБ) или смени модель'};
  if (/rate.?limit/i.test(s))
    return {title:'Слишком много запросов', advice:'Подожди минуту и попробуй снова'};
  if (/cannot import/i.test(s))
    return {title:'Технический сбой Naistera', advice:'Это на их стороне. Подожди несколько минут или смени модель'};
  if (/HTTP 404/i.test(s) || /Not Found/i.test(s))
    return {title:'Эндпоинт недоступен', advice:'Эта модель сейчас недоступна на Naistera. Используй gemini-модель'};
  if (/upstream_error/i.test(s))
    return {title:'Ошибка на стороне Naistera', advice:'Попробуй ещё раз через минуту'};
  if (/network error/i.test(s))
    return {title:'Ошибка сети', advice:'Проверь соединение и попробуй снова'};
  if (/HTTP 5/i.test(s))
    return {title:'Сервер Naistera недоступен', advice:'Попробуй через минуту'};
  if (/No image from Naistera/i.test(s) || /Нет изображения/i.test(s))
    return {title:'Naistera не вернул изображение', advice:'Попробуй ещё раз или смени модель'};
  if (/Invalid API v1 key/i.test(s) || /imgbb.*key/i.test(s))
    return {title:'Неверный ImgBB ключ', advice:'Перешифруй данные заново на сайте настройки'};
  if (/Invalid encrypted data/i.test(s) || /Missing key/i.test(s))
    return {title:'Неверный ключ конфигурации', advice:'Перешифруй данные на сайте настройки'};
  if (/Missing imgbb/i.test(s))
    return {title:'Отсутствует ImgBB ключ', advice:'Перешифруй данные, указав оба ключа'};
  if (/Not an image/i.test(s))
    return {title:'Ссылка ведёт не на картинку', advice:'Используй прямую ссылку i.ibb.co/.../file.jpg, а не страницу ImgBB'};
  if (/bad decrypt/i.test(s) || /Ошибка расшифровки/i.test(s))
    return {title:'Ошибка расшифровки', advice:'Ключ не совпадает. Перешифруй данные на сайте настройки'};
  return {title:'Что-то пошло не так', advice: s.length > 100 ? s.slice(0,100)+'…' : s};
}

// ---------- Замена generic-слов на имена персонажей ----------
function replaceGenericWords(prompt, chars) {
  if (!chars || chars.length === 0) return prompt;
  const names = chars.map(c => c.name).filter(Boolean);
  if (names.length === 0) return prompt;
  let result = prompt;
  if (names.length === 1) {
    const name = names[0];
    // Порядок важен: сначала длинные фразы, потом короткие
    const generics = [
      'the young man','the young woman','the older man','the older woman',
      'the man','the woman','the guy','the girl','the person','the figure','the character','the individual',
      'a young man','a young woman','an older man','an older woman',
      'a man','a woman','a guy','a girl','a person','a figure','a character',
      'young man','young woman','older man','older woman',
      'man','woman','guy','girl','person','figure',
      'мужчина','женщина','парень','девушка','персонаж','человек','молодой человек','молодая девушка',
      'мужчину','женщину','парня','девушку','персонажа','человека',
      'мужчине','женщине','парню','девушке',
      'мужчиной','женщиной','парнем','девушкой',
      'мужчины','женщины','парня','девушки',
    ];
    for (const word of generics) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), name);
    }
  } else {
    // При 2+ персонажах добавляем явное указание в начало промта
    const nameList = names.join(' and ');
    const hint = `CRITICAL: The ONLY people in this image are ${nameList}. Never use generic terms like man/woman/guy/girl/person/figure — use ONLY their names. `;
    result = hint + result;
  }
  if (result !== prompt) console.log(`🔤 Generic words replaced. Names: ${names.join(', ')}`);
  return result;
}

// ---------- Расшифровка с нормализацией base64 ----------
function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    let normalized = encryptedBase64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const parts = normalized.split(':');
    if (parts.length !== 2) {
      console.error('Invalid format: expected iv:encrypted, got', parts.length);
      return null;
    }
    const [ivBase64, encryptedBase64Data] = parts;
    const iv = Buffer.from(ivBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64Data, 'base64');
    const key = Buffer.from(secretKeyBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

// ---------- Загрузка стилей ----------
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ [1/9] styles.json error:', err.message);
  styleMap = { kodak_portra_400: "Kodak Portra 400 film look" };
}

// ---------- Redis ----------
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
let redis = null;
if (redisUrl) {
  redis = new Redis(redisUrl);
  redis.on('error', (err) => console.warn('Redis warning:', err.message));
}

function getCacheKey(userId, prompt, characters, style) {
  let chars = [];
  try { chars = JSON.parse(characters || '[]'); chars.sort((a,b)=>a.name.localeCompare(b.name)); } catch(e) {}
  const hash = Buffer.from(JSON.stringify({ userId, prompt, characters: chars, style })).toString('base64');
  return `img:${hash}`;
}

async function fetchImageBuffer(url) {
  // Авто-фикс ссылки на страницу ImgBB → прямую ссылку
  if (/^https?:\/\/ibb\.co\/[a-zA-Z0-9]+$/.test(url)) {
    try {
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await pageRes.text();
      const match = html.match(/https:\/\/i\.ibb\.co\/[^"'\s]+\.(?:jpg|jpeg|png|webp|gif)/i);
      if (match) { console.log(`🔗 Fixed ImgBB URL: ${url} → ${match[0]}`); url = match[0]; }
    } catch(e) { console.warn('ImgBB URL fix failed:', e.message); }
  }
  const res = await fetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

function extFromContentType(ct) {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

async function uploadToImgBB(imgbb_key, b64) {
  const clean = b64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
  const form = new FormData();
  form.append('key', imgbb_key);
  form.append('image', clean);
  form.append('name', `gen_${Date.now()}`);
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`ImgBB error: ${data.error?.message || 'unknown'}`);
  return data.data.url;
}

// ---------- Fetch с retry ----------
async function fetchWithRetry(url, options, retries = 3, delay = 1500) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      lastError = new Error(`Network error: ${networkErr.message}`);
      console.error(`❌ Network error attempt ${attempt}/${retries}: ${networkErr.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const rawText = await res.text();

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        json: async () => {
          try { return JSON.parse(rawText); }
          catch(e) { throw new Error(`Invalid JSON from Naistera: ${rawText.slice(0, 200)}`); }
        }
      };
    }

    let errorDetails = rawText;
    try {
      const parsed = JSON.parse(rawText);
      errorDetails = JSON.stringify(parsed, null, 2);
    } catch(e) {}

    console.error(`❌ Naistera attempt ${attempt}/${retries} — HTTP ${res.status}`);
    console.error(`   Response: ${errorDetails.slice(0, 800)}`);
    lastError = new Error(friendlyError(`Naistera HTTP ${res.status}: ${errorDetails}`));

    if (res.status !== 502 && res.status !== 503) throw lastError;
    if (attempt < retries) {
      console.warn(`⏳ Retry in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    console.log('🚀 [2/9] Начало запроса');
    console.log('🔍 RAW data:', req.query.data?.slice(0, 80));

    const encryptionKey = process.env.ENCRYPTION_KEY;
    let key, charactersRaw, imgbb_key;

    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        imgbb_key = decrypted.imgbb_key;
        charactersRaw = decrypted.characters || req.query.characters;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return errorSvg(res, 'Ошибка расшифровки данных', 'Ключ шифрования не совпадает. Перешифруй ключи заново на сайте настройки и обнови DATA в промте');
      }
    } else {
      key = req.query.key;
      charactersRaw = req.query.characters;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Незашифрованный запрос');
    }

    // Чистим ключи от «умных» символов (автозамена телефона: – — → -, неразрывные пробелы, кавычки)
    // и от любых non-ASCII, чтобы не падал HTTP-заголовок Authorization (ByteString ошибка)
    function sanitizeKey(k){
      if (!k || typeof k !== 'string') return k;
      return k
        .replace(/[\u2010-\u2015\u2212]/g, '-')   // разные тире/минусы → дефис
        .replace(/[\u2018\u2019\u201C\u201D]/g, '') // умные кавычки → убрать
        .replace(/[\u00A0\u2000-\u200B]/g, '')      // неразрывные/тонкие пробелы → убрать
        .replace(/[^\x00-\x7F]/g, '')               // всё остальное не-ASCII → убрать
        .trim();
    }
    key = sanitizeKey(key);
    imgbb_key = sanitizeKey(imgbb_key);

    if (charactersRaw && typeof charactersRaw === 'string' && charactersRaw.includes('%')) {
      try {
        charactersRaw = decodeURIComponent(charactersRaw);
        console.log('🔓 characters decoded');
      } catch (e) { console.warn('Decode failed', e.message); }
    }
    console.log('🔍 charactersRaw:', charactersRaw);

    const userId = req.query.userId;
    const prompt = req.query.prompt;
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';

    if (!key || !prompt || !userId) {
      console.error(`❌ 400: key=${!!key}, prompt=${!!prompt}, userId=${!!userId}`);
      return errorSvg(res, 'Неполная конфигурация', 'Отсутствует ключ, промт или userId. Перешифруй данные на сайте настройки');
    }
    if (!imgbb_key) {
      console.error('❌ 400: imgbb_key missing');
      return errorSvg(res, 'Отсутствует ImgBB ключ', 'Перешифруй данные, указав оба ключа');
    }
    console.log(`✅ [3/9] userId: ${userId}, model: ${model}`);

    // Стиль: ключ из каталога → его описание; иначе произвольный текст юзера как есть;
    // иначе дефолт. Лимит — чтобы длинное полотно не съедало таймаут генерации.
    const MAX_STYLE_LEN = 300;
    let finalStyle;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else if (style && style.trim()) {
      finalStyle = style.trim().slice(0, MAX_STYLE_LEN);
      console.log(`🎨 [4/9] Кастомный стиль (${finalStyle.length} симв.)`);
    } else {
      const defaultStyle = 'kodak_portra_400';
      finalStyle = styleMap[defaultStyle] || "Kodak Portra 400 film look";
      console.log(`🎨 [4/9] Стиль по умолчанию (${defaultStyle})`);
    }

    // ---- Парсим персонажей заранее для замены generic-слов ----
    let chars = [];
    try {
      chars = JSON.parse(charactersRaw || '[]');
      console.log(`📸 [6/9] Референсов: ${chars.length}`);
    } catch(e) {
      console.warn('Ошибка парсинга characters:', e.message);
    }

    // Заменяем generic-слова на имена персонажей
    const cleanPrompt = replaceGenericWords(prompt, chars);

    // ---- Модель и поддержка референсов ----
    const NAISTERA_REF_MODELS = ['nano banana 2', 'grok'];   // рефы работают только тут
    const naisteraModel = (model && String(model).trim()) || 'nano banana 2';
    const refsSupported = NAISTERA_REF_MODELS.includes(naisteraModel.toLowerCase());
    const aspectRatio = (req.query.aspect_ratio || req.query.aspectRatio || '3:2');

    // Жёсткая инструкция: точное соответствие лиц референсам.
    // Только когда рефы реально уйдут в запрос — иначе модель (novelai/grok-pro)
    // получает указание копировать несуществующие картинки.
    let faceLock = '';
    const named = chars.filter(c => c && c.name && c.url).map(c => c.name);
    if (refsSupported && named.length > 0) {
      faceLock = `[CRITICAL: The reference image(s) show the EXACT appearance of ${named.join(' and ')}. You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]\n\n`;
    }
    const fullPrompt = `${faceLock}${finalStyle}\n\n${cleanPrompt}`;

    // ---- Кэш и блокировка ----
    // Каждый реролл кэшируется ОТДЕЛЬНО — по своему _r. Это принципиально:
    // в историю на клиенте сохраняется именно этот URL (с _r), и при листании
    // рероллов он запрашивается снова. Раньше _r отключал кэш → каждое листание
    // жгло токены заново. Теперь новый _r = новая генерация, повтор того же _r = кэш.
    const rerollTag = String(req.query._r || '');
    const isReroll = !!rerollTag;
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle + '|r=' + rerollTag);
    let cachedUrl = null;
    let lockAcquired = false;
    const lockKey = `lock:${cacheKey}`;

    if (redis) {
      console.log('🔄 [5/9] Проверка кэша...');
      try { cachedUrl = await redis.get(cacheKey); } catch(e) { console.warn('Redis error:', e.message); }
      if (!cachedUrl) {
        const locked = await redis.set(lockKey, 'locked', 'EX', 2, 'NX');
        if (locked) {
          lockAcquired = true;
          console.log(`🔒 Блокировка получена`);
        } else {
          console.log(`⏳ Ожидание блокировки`);
          await new Promise(resolve => setTimeout(resolve, 600));
          const retryCache = await redis.get(cacheKey);
          if (retryCache) return res.redirect(302, retryCache);
          else await redis.del(lockKey);
        }
      }
    }
    if (cachedUrl) return res.redirect(302, cachedUrl);
    console.log(isReroll ? '🔁 [5/9] Генерация (реролл)' : '❌ [5/9] Кэш промах, генерация');

    console.log(`🤖 [7/9] Запрос в Naistera (${naisteraModel}, ${aspectRatio})...`);

    // ---- Референсы: скачиваем с ImgBB → data URL (Naistera ждёт именно data URL) ----
    const referenceImages = [];
    if (refsSupported) {
      for (const c of chars) {
        if (!c.url) continue;
        if (referenceImages.length >= 5) { console.log('   ⚠️ лимит 5 референсов достигнут'); break; }
        try {
          const { buf, contentType } = await fetchImageBuffer(c.url);
          referenceImages.push(`data:${contentType};base64,${buf.toString('base64')}`);
          console.log(`   ✅ "${c.name}" загружен (${buf.length} bytes)`);
        } catch(e) { console.warn(`   ⚠️ "${c.name}": ${e.message}`); }
      }
    } else {
      console.log(`   ℹ️ Модель "${naisteraModel}" не поддерживает референсы — пропускаем`);
    }

    // ---- Тело запроса ----
    const naisteraBody = {
      prompt: fullPrompt,
      aspect_ratio: aspectRatio,
      model: naisteraModel,
    };
    if (referenceImages.length > 0) naisteraBody.reference_images = referenceImages;

    const naisteraRes = await fetchWithRetry('https://naistera.org/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(naisteraBody),
    });
    const naisteraData = await naisteraRes.json();
    console.log('🔍 Naistera response keys:', JSON.stringify(Object.keys(naisteraData)));

    // ---- Ответ: { data_url: "data:image/png;base64,..." } ----
    let b64 = null;
    if (naisteraData.data_url && typeof naisteraData.data_url === 'string') {
      const m = naisteraData.data_url.match(/base64,([a-zA-Z0-9+/=]+)/);
      if (m) b64 = m[1];
    }
    if (!b64) {
      const rawMsg = naisteraData.error || naisteraData.message || JSON.stringify(naisteraData).slice(0, 400);
      console.error('❌ Full Naistera response:', JSON.stringify(naisteraData).slice(0, 1500));
      throw new Error(friendlyError(rawMsg));
    }
    console.log('✅ [7/9] Naistera ответила');
    const imageUrl = await uploadToImgBB(imgbb_key, b64);

    console.log(`✅ [8/9] Изображение готово`);

    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        if (lockAcquired) await redis.del(lockKey);
        console.log(`💾 [9/9] Сохранено в кэш`);
      } catch(e) { console.warn('Redis set error:', e.message); }
    }

    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    const fe = friendlyErrorObj(err.message);
    return errorSvg(res, fe.title, fe.advice);
  }
}
