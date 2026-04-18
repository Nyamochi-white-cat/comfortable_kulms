// Comfortable KULMS - Background Service Worker
// KULASIS シラバス検索から曜時限情報を取得

const SYLLABUS_BASE = "https://www.k.kyoto-u.ac.jp/external/open_syllabus";

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

// === KULASIS 検索 → 曜時限を取得 ===

async function searchSchedule(keyword) {
  const searchUrl =
    SYLLABUS_BASE +
    "/search?condition.keyword=" +
    encodeShiftJIS(keyword) +
    "&condition.departmentNo=&condition.openSyllabusTitle=" +
    "&condition.courseNumberingJugyokeitaiNo=&condition.courseNumberingLanguageNo=" +
    "&condition.semesterNo=&condition.courseNumberingLevelNo=" +
    "&condition.courseNumberingBunkaNo=&condition.teacherName=" +
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
      });
    }
  }

  console.log("[Comfortable KULMS] KULASIS results:", results.length, "entries");
  return results;
}

// 科目名で検索し、最も一致する結果の曜時限を返す
// courseDay/coursePeriod: 元の科目から解析済みの曜日・時限（フォールバック検証用）
async function lookupSchedule(courseName, courseDay, coursePeriod) {
  const keyword = cleanCourseName(courseName);
  if (!keyword) return null;

  try {
    const results = await searchSchedule(keyword);
    if (results.length === 0) return null;

    const normalized = normalizeForMatch(keyword);

    // 完全一致を優先
    const exact = results.find(r => normalizeForMatch(r.name) === normalized);
    if (exact) return exact.schedule;

    // 部分一致
    const partial = results.find(r => {
      const rn = normalizeForMatch(r.name);
      return rn.includes(normalized) || normalized.includes(rn);
    });
    if (partial) return partial.schedule;

    // フォールバック: 先頭結果を採用するが、元の曜日情報と矛盾しないか検証
    if (courseDay && results[0].schedule) {
      const slots = parseScheduleSlots(results[0].schedule);
      const hasMatchingDay = slots.some(s => s.day === courseDay);
      if (!hasMatchingDay) {
        console.warn("[Comfortable KULMS] Fallback result day mismatch for", keyword,
          "- expected", courseDay, "but got", results[0].schedule);
        return null; // 矛盾するのでフォールバックを採用しない
      }
    }
    return results[0].schedule;
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

// === KULASISキャッシュ ===

const CACHE_KEY = "kulms-kulasis-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 1日

async function getCachedSchedules() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const cache = result[CACHE_KEY];
    if (cache && cache.timestamp && (Date.now() - cache.timestamp < CACHE_TTL)) {
      return cache.schedules || {};
    }
  } catch (e) {}
  return null;
}

async function saveCacheSchedules(schedules) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { timestamp: Date.now(), schedules }
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
          if (cached[c.name]) {
            schedules[c.name] = cached[c.name];
          } else {
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
            schedules[c.name] = {
              raw: results[idx].value,
              slots: parseScheduleSlots(results[idx].value),
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
