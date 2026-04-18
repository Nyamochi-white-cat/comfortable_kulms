// === Comfortable KULMS - 課題データ取得 ===
// kulms-extension の assignments.js から課題取得ロジックのみ抽出
// パネルUI・メモ・プレビュー機能は削除し、APIを window に公開

(function () {
  "use strict";

  var CACHE_KEY = "kulms-assignments";
  var CONCURRENT_LIMIT = 4;
  var BASE_URL = window.location.origin;
  var CHECKED_KEY = "kulms-checked-assignments";
  var MIN_DOM_COURSES_TRUSTED = 3;
  // Keep previous data when a refresh suddenly drops to an implausibly small count.
  var DROP_GUARD_RATIO = 0.2;
  var DROP_GUARD_MIN_PREVIOUS = 8;

  // --- State ---
  var checkedState = {};
  var lastAssignments = [];

  // --- ログイン状態判定 ---

  function isLoggedInDOM() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].textContent &&
          scripts[i].textContent.indexOf('"loggedIn": true') !== -1) {
        return true;
      }
    }
    return false;
  }

  function LoggedOutError() {
    var err = new Error("LOGGED_OUT");
    err.loggedOut = true;
    return err;
  }

  // --- Sakai Direct API ヘルパー ---

  async function sakaiGet(path) {
    var res = await fetch(BASE_URL + path, { credentials: "include" });
    if (res.redirected && /\/portal\/(x?login|relogin|logout)/.test(res.url)) {
      throw LoggedOutError();
    }
    var ct = res.headers.get("content-type") || "";
    if (ct && ct.indexOf("json") === -1) {
      throw LoggedOutError();
    }
    if (!res.ok) {
      throw new Error("API " + path + " returned " + res.status);
    }
    return res.json();
  }

  // --- コース一覧取得 ---

  async function fetchCoursesFromAPI() {
    var data = await sakaiGet("/direct/site.json?_limit=200");
    var sites = data.site_collection || [];
    return sites
      .filter(function (s) { return s.type === "course" || s.type === "project"; })
      .map(function (s) {
        return {
          id: s.id,
          name: s.title,
          url: BASE_URL + "/portal/site/" + s.id,
        };
      });
  }

  async function fetchCoursesFromPortal() {
    var res = await fetch(BASE_URL + "/portal", { credentials: "include" });
    if (!res.ok) throw new Error("Portal fetch failed: " + res.status);
    var html = await res.text();
    var doc = new DOMParser().parseFromString(html, "text/html");
    var courses = [];
    doc.querySelectorAll('a[href*="/portal/site/"]').forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var match = href.match(/\/portal\/site\/([^\/?#]+)/);
      if (!match || match[1].startsWith("~")) return;
      var rest = href.substring(href.indexOf(match[1]) + match[1].length);
      if (/^\/(tool|page|tool-reset|page-reset)/.test(rest)) return;
      var fullUrl = href.startsWith("http") ? href : BASE_URL + href;
      courses.push({
        id: match[1],
        name: a.textContent.trim(),
        url: fullUrl,
      });
    });
    return deduplicateCourses(courses);
  }

  function deduplicateCourses(courses) {
    var seen = new Set();
    return courses.filter(function (c) {
      if (!c.name || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  async function getCourses() {
    try {
      var apiCourses = await fetchCoursesFromAPI();
      if (apiCourses.length > 0) return apiCourses;
    } catch (e) {
      if (e && e.loggedOut) throw e;
    }

    try {
      var courses = await fetchCoursesFromPortal();
      if (courses.length > 0) return courses;
    } catch (e) { /* ignore */ }

    throw new Error("コース一覧を取得できませんでした");
  }

  // --- 日付・緊急度 ---

  function getUrgencyClass(deadline) {
    if (!deadline) return "urgency-other";
    var s = window.__kulmsSettings || {};
    var diff = deadline - Date.now();
    if (diff < 0) return "urgency-overdue";
    if (diff < (s.dangerHours || 24) * 3600000) return "urgency-danger";
    if (diff < (s.warningDays || 5) * 86400000) return "urgency-warning";
    if (diff < (s.successDays || 14) * 86400000) return "urgency-success";
    return "urgency-other";
  }

  function formatDeadline(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // --- タイムスタンプ抽出 ---

  function extractTimestamp(val) {
    if (!val) return null;
    if (typeof val === "number") return val;
    if (typeof val === "object") {
      if (val.epochSecond) return val.epochSecond * 1000;
      if (val.time) return val.time;
    }
    if (typeof val === "string") {
      var n = Number(val);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // --- 課題ツールURL取得 ---

  async function fetchAssignmentToolUrl(siteId) {
    try {
      var data = await sakaiGet("/direct/site/" + siteId + "/pages.json");
      var pages = Array.isArray(data) ? data : [];
      for (var i = 0; i < pages.length; i++) {
        var tools = pages[i].tools || [];
        for (var j = 0; j < tools.length; j++) {
          if (tools[j].toolId === "sakai.assignment.grades") {
            return BASE_URL + "/portal/site/" + siteId + "/tool/" + tools[j].id;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // --- 課題データ取得 ---

  async function fetchAssignmentsForCourse(course) {
    try {
      var data = await sakaiGet("/direct/assignment/site/" + course.id + ".json");
      var list = data.assignment_collection || [];

      var courseAssignUrl = await fetchAssignmentToolUrl(course.id)
        || BASE_URL + "/portal/site/" + course.id;

      var itemResults = await Promise.allSettled(
        list.map(function (a) {
          return sakaiGet("/direct/assignment/item/" + (a.entityId || a.id) + ".json");
        })
      );

      return list.map(function (a, idx) {
        var deadline =
          extractTimestamp(a.dueTime) ||
          extractTimestamp(a.dueDate) ||
          extractTimestamp(a.closeTime);

        var itemData = itemResults[idx].status === "fulfilled" ? itemResults[idx].value : null;
        var sub = itemData && itemData.submissions && itemData.submissions[0];
        if (!sub) sub = a.submissions && a.submissions[0];

        var status = "";
        var grade = "";
        if (sub) {
          var subStatusRaw = sub.status || "";
          var subStatusLower = subStatusRaw.toLowerCase();
          var statusIndicatesSubmitted =
            subStatusLower.includes("提出済") || subStatusLower.includes("submitted") ||
            subStatusLower.includes("再提出") || subStatusLower.includes("resubmitted") ||
            subStatusLower.includes("評定済") || subStatusLower.includes("graded") ||
            subStatusLower.includes("採点済") ||
            subStatusLower.includes("返却") || subStatusLower.includes("returned");

          if (statusIndicatesSubmitted) {
            if (sub.graded && sub.returned) {
              status = "評定済";
            } else {
              status = "提出済";
            }
            grade = sub.grade || "";
          } else if (sub.userSubmission && !sub.draft && !subStatusRaw) {
            status = "提出済";
            if (sub.graded) grade = sub.grade || "";
          } else if (subStatusRaw && subStatusRaw !== "未開始" && subStatusLower !== "not started") {
            status = subStatusRaw;
          }
        }

        return {
          courseName: course.name,
          courseId: course.id,
          name: a.title || "",
          url: courseAssignUrl,
          deadline: deadline,
          closeTime: extractTimestamp(a.closeTime) || deadline,
          deadlineText: deadline ? formatDeadline(deadline) : "",
          status: status,
          grade: grade || a.gradeDisplay || a.grade || "",
          entityId: a.entityId || a.id || "",
          type: "assignment",
          allowResubmission: !!(a.allowResubmission || (itemData && itemData.allowResubmission)),
        };
      });
    } catch (e) {
      if (e && e.loggedOut) throw e;
      console.warn("[Comfortable KULMS] assignment fetch failed for", course.name, e.message);
      return [];
    }
  }

  // --- クイズ取得 ---

  async function fetchQuizzesForCourse(course) {
    try {
      var data = await sakaiGet("/direct/sam_pub/context/" + course.id + ".json");
      var list = data.sam_pub_collection || [];
      var quizUrl = BASE_URL + "/portal/site/" + course.id;
      var now = Date.now();
      list = list.filter(function (q) {
        var startTs = extractTimestamp(q.startDate);
        return !startTs || startTs <= now;
      });
      return list.map(function (q) {
        var deadline = extractTimestamp(q.dueDate);
        var closeTime = extractTimestamp(q.retractDate) || deadline;
        return {
          courseName: course.name,
          courseId: course.id,
          name: q.title || "",
          url: quizUrl,
          deadline: deadline,
          closeTime: closeTime,
          deadlineText: deadline ? formatDeadline(deadline) : "",
          status: "",
          grade: "",
          entityId: q.publishedAssessmentId ? String(q.publishedAssessmentId) : "",
          type: "quiz",
        };
      });
    } catch (e) {
      if (e && e.loggedOut) throw e;
      return [];
    }
  }

  async function fetchAllAssignments(onProgress) {
    var courses = await getCourses();
    if (courses.length === 0) throw new Error("コース一覧を取得できませんでした");

    var allAssignments = [];
    var completed = 0;

    for (var i = 0; i < courses.length; i += CONCURRENT_LIMIT) {
      var batch = courses.slice(i, i + CONCURRENT_LIMIT);
      var results = await Promise.allSettled(
        batch.flatMap(function (c) {
          return [
            fetchAssignmentsForCourse(c),
            fetchQuizzesForCourse(c)
          ];
        })
      );
      for (var ri = 0; ri < results.length; ri++) {
        if (results[ri].status === "rejected" && results[ri].reason && results[ri].reason.loggedOut) {
          throw results[ri].reason;
        }
      }
      results.forEach(function (r) {
        if (r.status === "fulfilled") {
          allAssignments.push.apply(allAssignments, r.value);
        }
      });
      completed += batch.length;
      if (onProgress) onProgress(completed, courses.length);
    }

    return allAssignments;
  }

  // --- 提出状態判定 ---

  function isSubmitted(status) {
    if (!status) return false;
    var s = status.toLowerCase();
    return (
      s.includes("提出済") || s.includes("submitted") ||
      s.includes("再提出") || s.includes("resubmitted") ||
      s.includes("評定済") || s.includes("graded") ||
      s.includes("採点済") ||
      s.includes("返却") || s.includes("returned")
    );
  }

  // --- 完了チェック ---

  async function loadCheckedState() {
    return new Promise(function (resolve) {
      window.__kulmsSafeStorage.get(CHECKED_KEY, function (result) {
        checkedState = result[CHECKED_KEY] || {};
        resolve();
      });
    });
  }

  function saveCheckedState() {
    window.__kulmsSafeStorage.set({ [CHECKED_KEY]: checkedState });
  }

  function getCheckedKey(assignment) {
    if (assignment.entityId) return assignment.entityId;
    return assignment.courseId + ":" + assignment.name;
  }

  function isAssignmentChecked(assignment) {
    var key = getCheckedKey(assignment);
    var val = checkedState[key];
    if (val && val !== "active") return true;
    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      var legacyVal = checkedState[legacyKey];
      if (legacyVal && legacyVal !== "active") return true;
    }
    return false;
  }

  function isExplicitlyActive(assignment) {
    var key = getCheckedKey(assignment);
    return checkedState[key] === "active";
  }

  function migrateCheckedKeys(assignments) {
    var changed = false;
    assignments.forEach(function (a) {
      if (!a.entityId) return;
      var legacyKey = a.courseId + ":" + a.name;
      if (checkedState[legacyKey] && !checkedState[a.entityId]) {
        checkedState[a.entityId] = checkedState[legacyKey];
        delete checkedState[legacyKey];
        changed = true;
      }
    });
    if (changed) saveCheckedState();
  }

  function toggleChecked(assignment) {
    var key = getCheckedKey(assignment);

    if (assignment.entityId) {
      var legacyKey = assignment.courseId + ":" + assignment.name;
      if (checkedState[legacyKey]) {
        delete checkedState[legacyKey];
      }
    }

    if (isSubmitted(assignment.status) && assignment.allowResubmission) {
      if (checkedState[key] === "active") {
        delete checkedState[key];
      } else {
        checkedState[key] = "active";
      }
    } else {
      if (checkedState[key]) {
        delete checkedState[key];
      } else {
        checkedState[key] = Date.now();
      }
    }

    saveCheckedState();

    if (lastAssignments && lastAssignments.length > 0) {
      var urgency = computeCourseUrgency(lastAssignments);
      window.__kulmsAssignments = lastAssignments;
      window.__kulmsCourseUrgency = urgency;
      if (window.__kulmsOnAssignmentsUpdated) {
        window.__kulmsOnAssignmentsUpdated(lastAssignments, urgency);
      }
    }
  }

  function shouldPreserveOnLargeDrop(nextAssignments) {
    if (!Array.isArray(nextAssignments)) return false;
    var prevCount = Array.isArray(lastAssignments) ? lastAssignments.length : 0;
    var nextCount = nextAssignments.length;
    if (prevCount < DROP_GUARD_MIN_PREVIOUS) return false;
    return nextCount < Math.floor(prevCount * DROP_GUARD_RATIO);
  }

  function publishAssignments(assignments) {
    lastAssignments = assignments;
    migrateCheckedKeys(assignments);
    window.__kulmsAssignments = assignments;
    window.__kulmsCourseUrgency = computeCourseUrgency(assignments);
    if (window.__kulmsOnAssignmentsUpdated) {
      window.__kulmsOnAssignmentsUpdated(assignments, window.__kulmsCourseUrgency);
    }
  }

  // --- キャッシュ ---

  function getFetchIntervalMs() {
    var s = window.__kulmsSettings || {};
    var sec = typeof s.fetchInterval === "number" ? s.fetchInterval : 120;
    return sec * 1000;
  }

  async function loadCache() {
    return new Promise(function (resolve) {
      window.__kulmsSafeStorage.get(CACHE_KEY, function (result) {
        var cached = result[CACHE_KEY];
        if (cached && cached.timestamp && Date.now() - cached.timestamp < getFetchIntervalMs()) {
          resolve(cached);
        } else {
          resolve(null);
        }
      });
    });
  }

  async function loadStaleCache() {
    return new Promise(function (resolve) {
      window.__kulmsSafeStorage.get(CACHE_KEY, function (result) {
        resolve(result[CACHE_KEY] || null);
      });
    });
  }

  function saveCache(assignments) {
    window.__kulmsSafeStorage.set({
      [CACHE_KEY]: { timestamp: Date.now(), assignments: assignments },
    });
  }

  // --- 色分け ---

  function injectUrgencyColors(s) {
    var style = document.createElement("style");
    style.id = "kulms-urgency-colors";
    style.textContent =
      ":root {" +
      "--kulms-color-danger: " + (s.colorDanger || "#e85555") + ";" +
      "--kulms-color-warning: " + (s.colorWarning || "#d7aa57") + ";" +
      "--kulms-color-success: " + (s.colorSuccess || "#62b665") + ";" +
      "--kulms-color-other: " + (s.colorOther || "#777777") + ";" +
      "}";
    document.head.appendChild(style);
  }

  // コースごとの最も緊急な課題の緊急度を計算
  function computeCourseUrgency(assignments) {
    var courseUrgency = {};
    var priority = {
      "urgency-overdue": 0, "urgency-danger": 1,
      "urgency-warning": 2, "urgency-success": 3, "urgency-other": 4
    };

    assignments.forEach(function (a) {
      if (isExplicitlyActive(a)) { /* 再提出可能: 色付け対象 */ }
      else if (isSubmitted(a.status) || isAssignmentChecked(a)) return;
      var u = getUrgencyClass(a.deadline);
      var existing = courseUrgency[a.courseId];
      if (!existing || (priority[u] || 99) < (priority[existing] || 99)) {
        courseUrgency[a.courseId] = u;
      }
    });

    return courseUrgency;
  }

  // --- メインロジック ---

  var isLoading = false;

  async function loadAssignments(forceRefresh) {
    if (isLoading) return;
    isLoading = true;

    try {
      if (!forceRefresh) {
        var cached = await loadCache();
        if (cached) {
          publishAssignments(cached.assignments);
          isLoading = false;
          return;
        }
      }

      if (!isLoggedInDOM()) {
        throw LoggedOutError();
      }

      var assignments = await fetchAllAssignments();

      // kulms-extension と同様に「既存状態を壊さない」方針を優先する。
      // 内部的な一時失敗で 0 件になる場合は、既存キャッシュを維持する。
      if (assignments.length === 0) {
        var staleForEmpty = await loadStaleCache();
        if (staleForEmpty && staleForEmpty.assignments && staleForEmpty.assignments.length > 0) {
          console.warn("[Comfortable KULMS] empty fetch result; preserving existing cache state");
          publishAssignments(staleForEmpty.assignments);
          isLoading = false;
          return;
        }

        if (lastAssignments && lastAssignments.length > 0) {
          console.warn("[Comfortable KULMS] empty fetch result; preserving in-memory assignments");
          publishAssignments(lastAssignments);
          isLoading = false;
          return;
        }
      }

      if (shouldPreserveOnLargeDrop(assignments)) {
        console.warn(
          "[Comfortable KULMS] suspicious assignment count drop detected; preserving previous state",
          lastAssignments.length,
          "->",
          assignments.length
        );
        publishAssignments(lastAssignments);
        isLoading = false;
        return;
      }

      saveCache(assignments);
      publishAssignments(assignments);
    } catch (e) {
      var stale = await loadStaleCache();
      if (e && e.loggedOut) {
        console.warn("[Comfortable KULMS] session expired; preserving cache");
      } else {
        console.error("[Comfortable KULMS] assignment fetch error:", e);
      }

      if (stale && stale.assignments && stale.assignments.length > 0) {
        publishAssignments(stale.assignments);
      } else if (lastAssignments && lastAssignments.length > 0) {
        publishAssignments(lastAssignments);
      } else {
        publishAssignments([]);
      }
    } finally {
      isLoading = false;
    }
  }

  // --- 初期化 ---

  async function init() {
    if (window !== window.top) return;
    await window.__kulmsSettingsReady;
    await loadCheckedState();
    injectUrgencyColors(window.__kulmsSettings || {});

    // 初回ロード
    loadAssignments(false);

    // タブ復帰で自動更新
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;

      var submittedAt = sessionStorage.getItem("kulms-submitted");
      if (submittedAt) {
        sessionStorage.removeItem("kulms-submitted");
        loadCheckedState().then(function () {
          loadAssignments(true);
        });
        return;
      }

      loadAssignments(true);
    });

    // 定期フェッチ
    var intervalMs = getFetchIntervalMs();
    if (intervalMs > 0) {
      setInterval(function () {
        if (document.visibilityState !== "visible") return;
        loadAssignments(true);
      }, intervalMs);
    }
  }

  // window にAPI公開（timetable.jsから使用）
  window.__kulmsAssignmentAPI = {
    getUrgencyClass: getUrgencyClass,
    isSubmitted: isSubmitted,
    isAssignmentChecked: isAssignmentChecked,
    isExplicitlyActive: isExplicitlyActive,
    toggleChecked: toggleChecked,
    computeCourseUrgency: computeCourseUrgency,
    loadAssignments: loadAssignments,
  };

  // --- ポップアップからの更新リクエスト (top frame のみ) ---
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg.type === "kulms-refresh-assignments") {
        if (window !== window.top) return false;
        loadAssignments(true).then(function () {
          try { sendResponse({ ok: true }); } catch (e) { /* context invalidated */ }
        }).catch(function () {
          try { sendResponse({ ok: false }); } catch (e) { /* context invalidated */ }
        });
        return true; // async sendResponse
      }
    });
  } catch (e) {
    // コンテキスト無効化時は無視
  }

  init();
})();
