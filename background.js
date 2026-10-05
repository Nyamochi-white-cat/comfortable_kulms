// Comfortable KULMS - Background Service Worker
// KULASIS シラバス検索から曜時限情報を取得

const SYLLABUS_BASE = "https://www.k.kyoto-u.ac.jp/external/open_syllabus";
const WEEKDAY_FILTER_BASE = { "月": 10, "火": 20, "水": 30, "木": 40, "金": 50 };

function getWeekScheduleFilter(day, period) {
  const dayBase = WEEKDAY_FILTER_BASE[day];
  const periodNumber = parseInt(period, 10);
  if (!dayBase || !Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > 5) {
    return "";
  }
  const condition = encodeURIComponent(`condition.weekSchedule[${dayBase + periodNumber}]`);
  return `&${condition}=true`;
}

// === Shift_JIS エンコード ===

let sjisEncodeTable = null;

function buildSjisEncodeTable() {
  const map = new Map();
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      try {
        const bytes = new Uint8Array([hi, lo]);
        const char = decoder.decode(bytes);
        if (char.length === 1 && !map.has(char)) {
          map.set(char, [hi, lo]);
        }
      } catch (e) {}
    }
  }
  for (let b = 0xa1; b <= 0xdf; b++) {
    try {
      const bytes = new Uint8Array([b]);
      const char = decoder.decode(bytes);
      if (char.length === 1 && !map.has(char)) {
        map.set(char, [b]);
      }
    } catch (e) {}
  }
  return map;
}

function encodeShiftJIS(str) {
  if (!sjisEncodeTable) sjisEncodeTable = buildSjisEncodeTable();
  let encoded = "";
  for (const char of str) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e
    ) {
      encoded += char;
      continue;
    }
    if (code === 0x20) { encoded += "+"; continue; }
    const bytes = sjisEncodeTable.get(char);
    if (bytes) {
      for (const b of bytes) {
        encoded += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    } else if (code < 0x80) {
      encoded += "%" + code.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return encoded;
}

// === HTML デコード ===

async function fetchAndDecode(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒タイムアウト
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error("Fetch failed: " + res.status);
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "";
    const charsetMatch = ct.match(/charset=([^\s;]+)/i);
    let encoding = charsetMatch ? charsetMatch[1] : "shift_jis";
    try {
      return new TextDecoder(encoding).decode(buf);
    } catch (e) {
      return new TextDecoder("utf-8").decode(buf);
    }
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// === 科目名クリーンアップ ===

function cleanCourseName(name) {
  let cleaned = name.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  // 末尾の括弧を除去するが、短い括弧内容（学科名・分野名など）は残す
  // 例: 「プログラミング演習（数理）」→ そのまま残す
  //     「データ構造とアルゴリズム（2026年度）」→ 括弧を除去
  const parenMatch = cleaned.match(/[\(（]([^\)）]+)[\)）]\s*$/);
  if (parenMatch) {
    const content = parenMatch[1];
    // 年度情報（4桁数字を含む）や長い説明（8文字超）のみ除去
    if (/\d{4}/.test(content) || content.length > 8) {
      cleaned = cleaned.replace(/\s*[\(（][^\)）]+[\)）]\s*$/, "").trim();
    }
  }
  return cleaned;
}

// 全角→半角正規化
function normalizeForMatch(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSyllabusUrl(rowHtml) {
  const linkRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  const baseUrl = new URL(SYLLABUS_BASE);
  const searchUrl = new URL("search", SYLLABUS_BASE + "/");
  const detailPrefix = baseUrl.pathname.replace(/\/$/, "") + "/";
  let match;

  while ((match = linkRe.exec(rowHtml)) !== null) {
    const href = (match[1] || match[2] || match[3] || "").replace(/&amp;/gi, "&");
    if (!/(?:department_syllabus|la_syllabus)\?/i.test(href)) continue;

    try {
      const url = new URL(href, searchUrl);
      const allowedPath = url.pathname === detailPrefix + "department_syllabus" ||
        url.pathname === detailPrefix + "la_syllabus";
      if (url.protocol === "https:" && url.origin === baseUrl.origin && allowedPath) {
        return url.href;
      }
    } catch (e) {}
  }

  return null;
}

// === KULASIS 検索 → 曜時限・シラバスURLを取得 ===

async function searchSchedule(keyword, courseDay, coursePeriod) {
  const searchUrl =
    SYLLABUS_BASE +
    "/search?condition.keyword=" +
    encodeShiftJIS(keyword) +
    "&condition.departmentNo=&condition.openSyllabusTitle=" +
    "&condition.courseNumberingJugyokeitaiNo=&condition.courseNumberingLanguageNo=" +
    "&condition.semesterNo=&condition.courseNumberingLevelNo=" +
    "&condition.courseNumberingBunkaNo=&condition.teacherName=" +
    getWeekScheduleFilter(courseDay, coursePeriod) +
    "&x=0&y=0";

  console.log("[Comfortable KULMS] searching KULASIS for:", keyword);
  const html = await fetchAndDecode(searchUrl);

  // テーブル行から 科目名 と 曜時限 を抽出
  // 検索結果テーブル: 科目名 | 担当教員 | 学部/大学院 | 学科等 | 授業形態 | 使用言語 | 開講期 | 曜時限 | レベル | 学問分野 | 詳細
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const results = [];
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const rowHtml = rm[1];
    // シラバスリンクがある行だけ（データ行）
    if (!/(department_syllabus|la_syllabus)\?/.test(rowHtml)) continue;

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let td;
    while ((td = tdRe.exec(rowHtml)) !== null) {
      const text = td[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      cells.push(text);
    }

    // cells[0] = 科目名, cells[7] = 曜時限 (0-indexed)
    if (cells.length >= 8) {
      results.push({
        name: cells[0] || "",
        schedule: cells[7] || "",  // "火3 火4" or "月3" etc.
        syllabusUrl: extractSyllabusUrl(rowHtml),
      });
    }
  }

  console.log("[Comfortable KULMS] KULASIS results:", results.length, "entries");
  return results;
}

// 科目名で検索し、曜時限と科目名が最も一致する結果を返す
// courseDay/coursePeriod: 元の科目から解析済みの曜日・時限
async function lookupSchedule(courseName, courseDay, coursePeriod) {
  const keyword = cleanCourseName(courseName);
  if (!keyword) return null;

  try {
    const results = await searchSchedule(keyword, courseDay, coursePeriod);
    if (results.length === 0) return null;

    const normalized = normalizeForMatch(keyword);
    const compatible = results.filter(result =>
      scheduleMatchesAnchor(result.schedule, courseDay, coursePeriod)
    );

    // 曜時限が合う候補のうち、科目名の完全一致を優先する。
    const exact = compatible.find(result => normalizeForMatch(result.name) === normalized);
    if (exact) return { raw: exact.schedule, syllabusUrl: exact.syllabusUrl || null };

    // 完全一致がなければ、包含一致する候補のうち一致文字数が最大のものを選ぶ。
    let partial = null;
    let bestMatchLength = 0;
    compatible.forEach(result => {
      const resultName = normalizeForMatch(result.name);
      if (!resultName || (!resultName.includes(normalized) && !normalized.includes(resultName))) return;
      const matchLength = Math.min(resultName.length, normalized.length);
      if (matchLength > bestMatchLength) {
        partial = result;
        bestMatchLength = matchLength;
      }
    });
    if (partial) return { raw: partial.schedule, syllabusUrl: partial.syllabusUrl || null };

    console.warn("[Comfortable KULMS] No matching syllabus title and slot found for", keyword,
      "- expected", courseDay, coursePeriod);
    return null;
  } catch (e) {
    console.warn("[Comfortable KULMS] KULASIS lookup failed:", e.message);
    return null;
  }
}

// === 曜時限文字列のパース ===
// "火3 火4" → [{day: "火", period: 3}, {day: "火", period: 4}]
// "月3" → [{day: "月", period: 3}]
function parseScheduleSlots(scheduleStr) {
  if (!scheduleStr) return [];
  const slotRe = /([月火水木金土日])(\d)/g;
  const slots = [];
  let m;
  while ((m = slotRe.exec(scheduleStr)) !== null) {
    slots.push({ day: m[1], period: parseInt(m[2], 10) });
  }
  return slots;
}

function scheduleMatchesAnchor(schedule, courseDay, coursePeriod) {
  if (!courseDay || coursePeriod == null || coursePeriod === "") return true;
  const expectedPeriod = parseInt(coursePeriod, 10);
  if (!Number.isInteger(expectedPeriod)) return true;

  const slots = Array.isArray(schedule && schedule.slots)
    ? schedule.slots
    : parseScheduleSlots(typeof schedule === "string" ? schedule : (schedule && schedule.raw) || "");
  return slots.some(slot => slot.day === courseDay && parseInt(slot.period, 10) === expectedPeriod);
}

// === KULASISキャッシュ ===

const CACHE_KEY = "kulms-kulasis-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 1日
const CACHE_SELECTION_VERSION = 3;

async function getCachedSchedules() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const cache = result[CACHE_KEY];
    if (cache && cache.selectionVersion === CACHE_SELECTION_VERSION && cache.timestamp &&
        (Date.now() - cache.timestamp < CACHE_TTL)) {
      return cache.schedules || {};
    }
  } catch (e) {}
  return null;
}

async function saveCacheSchedules(schedules) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { timestamp: Date.now(), selectionVersion: CACHE_SELECTION_VERSION, schedules }
    });
  } catch (e) {
    console.warn("[Comfortable KULMS] Cache save failed:", e);
  }
}

// === メッセージハンドラ ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "lookupSchedules") {
    // courses: [{name, day, period}, ...] 形式を優先、後方互換でcourseNamesも対応
    const courses = message.courses || (message.courseNames || []).map(n => ({ name: n }));
    if (courses.length === 0) {
      sendResponse({ schedules: {} });
      return false;
    }

    (async () => {
      // キャッシュを確認
      const cached = await getCachedSchedules();
      const schedules = {};
      const uncached = [];

      if (cached) {
        courses.forEach(c => {
          if (cached[c.name] && scheduleMatchesAnchor(cached[c.name], c.day, c.period)) {
            schedules[c.name] = cached[c.name];
          } else {
            delete cached[c.name];
            uncached.push(c);
          }
        });
        console.log("[Comfortable KULMS] Cache hit:", Object.keys(schedules).length,
          "/ miss:", uncached.length);
      } else {
        uncached.push(...courses);
      }

      // キャッシュにない科目のみKULASIS検索（5件ずつ並列）
      const BATCH_SIZE = 5;
      for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(c => lookupSchedule(c.name, c.day, c.period))
        );
        batch.forEach((c, idx) => {
          if (results[idx].status === "fulfilled" && results[idx].value) {
            const match = results[idx].value;
            schedules[c.name] = {
              raw: match.raw,
              slots: parseScheduleSlots(match.raw),
              syllabusUrl: match.syllabusUrl || null,
            };
          }
        });
      }

      // キャッシュを更新（既存キャッシュとマージ）
      const merged = Object.assign({}, cached || {}, schedules);
      await saveCacheSchedules(merged);

      sendResponse({ schedules });
    })();

    return true; // async
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Comfortable KULMS] Extension installed/updated");
});
