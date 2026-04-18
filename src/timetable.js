// === Comfortable KULMS - 時間割グリッド ===
// サイドバーの「ピン留め」セクションを曜日×時限の時間割テーブルに置換する
// 連続コマ (2-5コマ) の授業は rowspan で結合表示する
// 二段階レンダリング: 即時表示(spans=1) → KULASIS結果反映後に再描画

(function () {
  "use strict";

  if (window !== window.top) return;

  // 曜日の順序と表示名
  var DAYS = ["月", "火", "水", "木", "金"];
  var PERIODS = [1, 2, 3, 4, 5];

  // 科目名から曜日・時限を抽出する正規表現
  // course-name.js が先に実行されて [2026前期月３]→[月３] に変換済みの場合がある
  // 両方の形式に対応: [2026前期月３]科目名 or [月３]科目名
  var COURSE_FULL_RE = /^\s*\[(?:\d{4}[^\]]*?)?([月火水木金土日])\s*([０-９0-9]+)\s*\](.*)/;

  // 全角数字→半角変換
  function parseFullWidthNumber(text) {
    return parseInt(
      text.replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48);
      }),
      10
    );
  }

  // 科目名から曜日・時限・短縮名を抽出
  function parseCourse(fullName) {
    var match = fullName.match(COURSE_FULL_RE);
    if (!match) return null;
    return {
      day: match[1],
      period: parseFullWidthNumber(match[2]),
      shortName: match[3].trim(),
    };
  }

  // 緊急度クラス → セル用CSSクラス
  var URGENCY_TO_CELL_CLASS = {
    "urgency-overdue": "kulms-tt-urgency-danger",
    "urgency-danger": "kulms-tt-urgency-danger",
    "urgency-warning": "kulms-tt-urgency-warning",
    "urgency-success": "kulms-tt-urgency-success",
    "urgency-other": "kulms-tt-urgency-other"
  };

  // ============================================================
  // ピン留めセクションから科目データを収集
  // ============================================================
  function collectPinnedCourses() {
    var pinnedList = document.getElementById("pinned-site-list");
    if (!pinnedList) return [];

    var courses = [];
    pinnedList.querySelectorAll("li.site-list-item[data-type='pinned']").forEach(function (li) {
      var siteId = li.getAttribute("data-site") || "";
      var link = li.querySelector("a.sidebar-site-title");
      if (!link) return;

      var fullName = link.textContent.trim();
      var href = link.href;
      var parsed = parseCourse(fullName);

      // ツールリストの DOM をクローンとして保持する。
      // renderTimetable() で pinnedSection.innerHTML = "" すると
      // 元の li が DOM ツリーから外れるため、参照ではなくクローンが必要。
      var toolListEl = li.querySelector(".site-page-list");
      var toolListClone = toolListEl ? toolListEl.cloneNode(true) : null;

      courses.push({
        siteId: siteId,
        fullName: fullName,
        shortName: parsed ? parsed.shortName : fullName,
        day: parsed ? parsed.day : null,
        period: parsed ? parsed.period : null,
        href: href,
        toolListClone: toolListClone,
        // スケジュール情報（KULASIS から取得後に設定）
        spans: 1,          // 何コマ分か（デフォルト1）
        allSlots: null,    // KULASISから取得した全スロット
      });
    });

    return courses;
  }

  // ============================================================
  // KULASIS からスケジュール情報を取得して科目データにマージ
  // ============================================================
  function fetchSchedulesFromKULASIS(courses) {
    return new Promise(function (resolve) {
      // courses配列をbackground.jsに渡す形式に変換（曜日情報を含む）
      var courseInfos = [];
      var seen = {};
      courses.forEach(function (course) {
        if (course.fullName && !seen[course.fullName]) {
          seen[course.fullName] = true;
          courseInfos.push({
            name: course.fullName,
            day: course.day,
            period: course.period
          });
        }
      });

      if (courseInfos.length === 0) {
        resolve(courses);
        return;
      }

      // 10秒のタイムアウトを設定（KULASISが応答しない場合のフォールバック）
      var timedOut = false;
      var timeoutId = setTimeout(function () {
        timedOut = true;
        console.warn("[Comfortable KULMS] KULASIS schedule lookup timed out, using default spans");
        resolve(courses);
      }, 10000);

      try {
        chrome.runtime.sendMessage(
          { action: "lookupSchedules", courses: courseInfos },
          function (response) {
            if (timedOut) return; // タイムアウト済み
            clearTimeout(timeoutId);

            if (chrome.runtime.lastError) {
              console.warn("[Comfortable KULMS] Schedule lookup error:", chrome.runtime.lastError.message);
              resolve(courses);
              return;
            }

            if (!response || !response.schedules) {
              resolve(courses);
              return;
            }

            mergeScheduleData(courses, response.schedules);
            resolve(courses);
          }
        );
      } catch (e) {
        clearTimeout(timeoutId);
        console.warn("[Comfortable KULMS] Schedule lookup exception:", e);
        resolve(courses);
      }
    });
  }

  // スケジュールデータを科目にマージ
  function mergeScheduleData(courses, schedules) {
    courses.forEach(function (course) {
      var schedule = schedules[course.fullName];
      if (!schedule || !schedule.slots || schedule.slots.length === 0) return;

      course.allSlots = schedule.slots;

      // この科目が登録されている曜日で、連続する時限数を計算
      if (course.day) {
        var daySlots = schedule.slots
          .filter(function (slot) { return slot.day === course.day; })
          .map(function (slot) { return slot.period; })
          .sort(function (a, b) { return a - b; });

        if (daySlots.length > 1 && daySlots[0] === course.period) {
          // 連続しているか確認（5コマ連続まで対応）
          var span = 1;
          for (var slotIndex = 1; slotIndex < daySlots.length; slotIndex++) {
            if (daySlots[slotIndex] === daySlots[slotIndex - 1] + 1) {
              span++;
            } else {
              break;
            }
          }
          course.spans = span;
        }
      }
    });

    console.log("[Comfortable KULMS] Schedule info merged:",
      courses.filter(function (c) { return c.spans > 1; })
        .map(function (c) { return c.shortName + " (" + c.spans + "コマ)"; })
        .join(", ") || "連続コマなし"
    );
  }

  // ============================================================
  // 時間割テーブル構築（rowspan対応、5コマ連続まで）
  // ============================================================
  function buildTimetable(courses) {
    var grid = {};
    var otherCourses = [];

    DAYS.forEach(function (day) {
      grid[day] = {};
      PERIODS.forEach(function (p) {
        grid[day][p] = { courses: [], skip: false };
      });
    });

    courses.forEach(function (course) {
      if (course.day && course.period && grid[course.day] && grid[course.day][course.period]) {
        grid[course.day][course.period].courses.push(course);

        // 2コマ以上の場合、後続時限をスキップ対象にマーク
        if (course.spans > 1) {
          for (var spanOffset = 1; spanOffset < course.spans; spanOffset++) {
            var nextPeriod = course.period + spanOffset;
            if (nextPeriod <= 5 && grid[course.day][nextPeriod]) {
              grid[course.day][nextPeriod].skip = true;
            }
          }
        }
      } else {
        otherCourses.push(course);
      }
    });

    // テーブル構築
    var table = document.createElement("table");
    table.className = "kulms-timetable";
    table.setAttribute("role", "grid");

    // ヘッダー行
    var thead = document.createElement("thead");
    var headerRow = document.createElement("tr");
    var cornerTh = document.createElement("th");
    cornerTh.className = "kulms-tt-corner";
    headerRow.appendChild(cornerTh);

    DAYS.forEach(function (day) {
      var th = document.createElement("th");
      th.className = "kulms-tt-day-header";
      th.textContent = day;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // ボディ
    var tbody = document.createElement("tbody");
    PERIODS.forEach(function (period) {
      var tr = document.createElement("tr");

      var periodTh = document.createElement("th");
      periodTh.className = "kulms-tt-period-header";
      periodTh.textContent = period;
      tr.appendChild(periodTh);

      DAYS.forEach(function (day) {
        var cellInfo = grid[day][period];

        // スキップ（上のセルが rowspan で覆っている）
        if (cellInfo.skip) return;

        var td = document.createElement("td");
        td.className = "kulms-tt-cell";
        td.setAttribute("data-day", day);
        td.setAttribute("data-period", period);

        if (cellInfo.courses.length > 0) {
          var course = cellInfo.courses[0]; // 同じ枠の最初の科目

          // rowspan 設定（2コマ〜5コマ対応）
          if (course.spans > 1) {
            td.setAttribute("rowspan", course.spans);
            td.classList.add("kulms-tt-cell-multi");
            // 動的に高さを設定（spans数に応じて）
            // 1コマ = 60px + 1px border = 61px、n コマ = 60*n + (n-1) border + 1
            td.style.height = (60 * course.spans + (course.spans - 1)) + "px";
            td.style.minHeight = td.style.height;
          }

          var cellContent = createCellContent(course);
          td.appendChild(cellContent);
          td.setAttribute("data-site-id", course.siteId);
        }

        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    return { table: table, others: otherCourses };
  }

  // ============================================================
  // セル内コンテンツ作成
  // ============================================================
  function createCellContent(course) {
    var wrapper = document.createElement("div");
    wrapper.className = "kulms-tt-course";
    wrapper.setAttribute("data-site-id", course.siteId);

    var nameTrigger = document.createElement("button");
    nameTrigger.className = "kulms-tt-course-name";
    nameTrigger.type = "button";
    nameTrigger.textContent = course.shortName;
    nameTrigger.title = course.fullName;
    nameTrigger.setAttribute("data-site-id", course.siteId);
    nameTrigger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (window.__kulmsTimetableDropdown) {
        window.__kulmsTimetableDropdown.toggle(nameTrigger, course);
      }
    });

    wrapper.appendChild(nameTrigger);

    return wrapper;
  }

  // ============================================================
  // 「その他」セクション
  // ============================================================
  function buildOtherSection(others) {
    if (others.length === 0) return null;

    var container = document.createElement("div");
    container.className = "kulms-tt-other-section";

    var heading = document.createElement("h4");
    heading.className = "kulms-tt-other-heading";
    heading.textContent = t("sectionOther");
    container.appendChild(heading);

    var list = document.createElement("ul");
    list.className = "kulms-tt-other-list";

    others.forEach(function (course) {
      var li = document.createElement("li");
      li.className = "kulms-tt-other-item";
      li.setAttribute("data-site-id", course.siteId);
      li.appendChild(createCellContent(course));
      list.appendChild(li);
    });

    container.appendChild(list);
    return container;
  }

  // ============================================================
  // 時間割下部の課題パネル
  // ============================================================
  function formatPanelDeadline(ts) {
    if (!ts) return "-";
    var deadlineDate = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return deadlineDate.getFullYear() + "/" + pad(deadlineDate.getMonth() + 1) + "/" + pad(deadlineDate.getDate()) + " " + pad(deadlineDate.getHours()) + ":" + pad(deadlineDate.getMinutes());
  }

  function formatPanelRemaining(deadline) {
    if (!deadline) return "";
    var diff = deadline - Date.now();
    if (diff < 0) return t("expired");
    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return t("remainDaysHoursMins", [String(days), String(hours), String(mins)]);
    if (hours > 0) return t("remainHoursMins", [String(hours), String(mins)]);
    return t("remainMins", [String(mins)]);
  }

  function panelItemUrgency(item) {
    var api = window.__kulmsAssignmentAPI;
    if (!api || !api.getUrgencyClass) return "urgency-other";
    return api.getUrgencyClass(item.deadline);
  }

  function panelIsCompleted(item) {
    var api = window.__kulmsAssignmentAPI;
    if (!api) return false;
    if (api.isExplicitlyActive && api.isExplicitlyActive(item)) return false;
    return (
      (api.isAssignmentChecked && api.isAssignmentChecked(item)) ||
      (api.isSubmitted && api.isSubmitted(item.status))
    );
  }

  function panelIsActive(item) {
    var api = window.__kulmsAssignmentAPI;
    return !!(api && api.isExplicitlyActive && api.isExplicitlyActive(item));
  }

  function createAssignmentCard(item) {
    var urgency = panelItemUrgency(item);
    var isCompleted = panelIsCompleted(item);
    var isActive = panelIsActive(item);

    var card = document.createElement("div");
    card.className = "kulms-assign-card-lite " + urgency;
    if (isCompleted) card.classList.add("completed");
    if (isActive) card.classList.add("resubmit-active");

    var main = document.createElement("div");
    main.className = "kulms-assign-main-lite";

    var checkbox = document.createElement("button");
    checkbox.type = "button";
    checkbox.className = "kulms-assign-checkbox-lite" + (isCompleted ? " checked" : "") + (isActive ? " active" : "");
    checkbox.setAttribute("aria-label", item.name || "assignment");
    checkbox.title = t("sectionCompleted");
    checkbox.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var api = window.__kulmsAssignmentAPI;
      if (api && api.toggleChecked) {
        api.toggleChecked(item);
      }
    });
    main.appendChild(checkbox);

    var content = document.createElement("div");
    content.className = "kulms-assign-content-lite";

    var badgeRow = document.createElement("div");
    badgeRow.className = "kulms-assign-badge-row-lite";

    var pill = document.createElement("span");
    pill.className = "kulms-assign-course-pill-lite " + urgency;
    pill.textContent = item.courseName || "";
    badgeRow.appendChild(pill);

    if (item.type === "quiz") {
      var qBadge = document.createElement("span");
      qBadge.className = "kulms-assign-type-badge-lite";
      qBadge.textContent = t("badgeQuiz");
      badgeRow.appendChild(qBadge);
    }

    if (isActive) {
      var activeBadge = document.createElement("span");
      activeBadge.className = "kulms-assign-resubmit-badge-lite";
      activeBadge.textContent = t("badgeResubmit");
      badgeRow.appendChild(activeBadge);
    }

    var title = document.createElement("div");
    title.className = "kulms-assign-name-lite";
    if (item.url) {
      var link = document.createElement("a");
      link.href = item.url;
      link.textContent = item.name;
      title.appendChild(link);
    } else {
      title.textContent = item.name;
    }

    var meta = document.createElement("div");
    meta.className = "kulms-assign-meta-lite";

    var deadlineText = document.createElement("span");
    deadlineText.textContent = formatPanelDeadline(item.deadline);
    meta.appendChild(deadlineText);

    var remaining = formatPanelRemaining(item.deadline);
    if (remaining) {
      var rem = document.createElement("span");
      rem.className = "kulms-assign-remain-lite";
      if (remaining === t("expired")) rem.classList.add("overdue");
      rem.textContent = remaining;
      meta.appendChild(rem);
    }

    content.appendChild(badgeRow);
    content.appendChild(title);
    content.appendChild(meta);
    main.appendChild(content);
    card.appendChild(main);
    return card;
  }

  function createAssignmentSection(label, type, items) {
    var section = document.createElement("div");
    section.className = "kulms-assign-section-lite";

    var header = document.createElement("div");
    header.className = "kulms-assign-section-header-lite kulms-assign-section-" + type;
    header.textContent = label + " (" + items.length + ")";
    section.appendChild(header);

    var list = document.createElement("div");
    list.className = "kulms-assign-section-items-lite";
    items.forEach(function (item) {
      list.appendChild(createAssignmentCard(item));
    });
    section.appendChild(list);
    return section;
  }

  function renderAssignmentsPanel(assignments) {
    var panel = document.querySelector(".kulms-timetable-assign-panel");
    if (!panel) return;

    var body = panel.querySelector(".kulms-timetable-assign-body");
    var cacheInfo = panel.querySelector(".kulms-timetable-assign-cache");
    if (!body || !cacheInfo) return;

    body.innerHTML = "";

    if (!assignments || assignments.length === 0) {
      var empty = document.createElement("div");
      empty.className = "kulms-assign-empty-lite";
      empty.textContent = t("noAssignments");
      body.appendChild(empty);
      cacheInfo.textContent = "";
      return;
    }

    window.__kulmsSafeStorage.get("kulms-assignments", function (result) {
      var cached = result["kulms-assignments"];
      if (!cached || !cached.timestamp) {
        cacheInfo.textContent = "";
        return;
      }
      var mins = Math.floor((Date.now() - cached.timestamp) / 60000);
      cacheInfo.textContent = mins < 1 ? t("lastUpdatedNow") : t("lastUpdatedMins", [String(mins)]);
    });

    var now = Date.now();

    var active = assignments.filter(function (item) {
      return !panelIsCompleted(item);
    });
    var completed = assignments.filter(function (item) {
      return panelIsCompleted(item) && (!item.deadline || item.deadline >= now);
    });

    active.sort(function (a, b) {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    var overdue = active.filter(function (a) { return panelItemUrgency(a) === "urgency-overdue"; });
    var danger = active.filter(function (a) { return panelItemUrgency(a) === "urgency-danger"; });
    var warning = active.filter(function (a) { return panelItemUrgency(a) === "urgency-warning"; });
    var success = active.filter(function (a) { return panelItemUrgency(a) === "urgency-success"; });
    var other = active.filter(function (a) { return panelItemUrgency(a) === "urgency-other"; });

    var settings = window.__kulmsSettings || {};
    var dangerLabel = t("sectionDanger", [String(settings.dangerHours || 24)]);
    var warningLabel = t("sectionWarning", [String(settings.warningDays || 5)]);
    var successLabel = t("sectionSuccess", [String(settings.successDays || 14)]);

    if (overdue.length > 0) body.appendChild(createAssignmentSection(t("sectionOverdue"), "overdue", overdue));
    if (danger.length > 0) body.appendChild(createAssignmentSection(dangerLabel, "danger", danger));
    if (warning.length > 0) body.appendChild(createAssignmentSection(warningLabel, "warning", warning));
    if (success.length > 0) body.appendChild(createAssignmentSection(successLabel, "success", success));
    if (other.length > 0) body.appendChild(createAssignmentSection(t("sectionOther"), "other", other));

    if (completed.length > 0) {
      completed.sort(function (a, b) {
        if (a.deadline && b.deadline) return b.deadline - a.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      body.appendChild(createAssignmentSection(t("sectionCompleted"), "completed", completed));
    }

    if (active.length === 0 && completed.length === 0) {
      var emptyAll = document.createElement("div");
      emptyAll.className = "kulms-assign-empty-lite";
      emptyAll.textContent = t("noAssignments");
      body.appendChild(emptyAll);
    }
  }

  function buildAssignmentsPanel() {
    var panel = document.createElement("div");
    panel.className = "kulms-timetable-assign-panel";

    var header = document.createElement("div");
    header.className = "kulms-timetable-assign-header";

    var title = document.createElement("h4");
    title.className = "kulms-timetable-assign-title";
    title.textContent = t("tabAssignments");
    header.appendChild(title);

    var right = document.createElement("div");
    right.className = "kulms-timetable-assign-header-right";

    var cache = document.createElement("span");
    cache.className = "kulms-timetable-assign-cache";
    right.appendChild(cache);

    var refreshBtn = document.createElement("button");
    refreshBtn.className = "kulms-timetable-assign-refresh";
    refreshBtn.type = "button";
    refreshBtn.textContent = "\u21BB";
    refreshBtn.title = t("refresh");
    refreshBtn.addEventListener("click", function () {
      if (window.__kulmsAssignmentAPI && window.__kulmsAssignmentAPI.loadAssignments) {
        window.__kulmsAssignmentAPI.loadAssignments(true);
      }
    });
    right.appendChild(refreshBtn);

    header.appendChild(right);
    panel.appendChild(header);

    var body = document.createElement("div");
    body.className = "kulms-timetable-assign-body";
    panel.appendChild(body);

    return panel;
  }

  // ============================================================
  // 色分け適用
  // ============================================================
  function applyUrgencyColors(courseUrgency) {
    if (!courseUrgency) return;

    document.querySelectorAll(".kulms-tt-course").forEach(function (el) {
      el.classList.remove(
        "kulms-tt-urgency-danger",
        "kulms-tt-urgency-warning",
        "kulms-tt-urgency-success",
        "kulms-tt-urgency-other"
      );

      var siteId = el.getAttribute("data-site-id");
      var urgency = courseUrgency[siteId];
      if (urgency && URGENCY_TO_CELL_CLASS[urgency]) {
        el.classList.add(URGENCY_TO_CELL_CLASS[urgency]);
      }
    });
  }

  // ============================================================
  // 時間割テーブルのレンダリング（初回フルレンダー）
  // ============================================================
  function renderTimetable(pinnedSection, courses) {
    var result = buildTimetable(courses);

    // ピン留めセクションの中身を置換
    pinnedSection.innerHTML = "";

    var heading = document.createElement("h3");
    heading.className = "sites-section-heading";
    heading.textContent = t("timetableHeading");
    pinnedSection.appendChild(heading);

    var timetableWrapper = document.createElement("div");
    timetableWrapper.className = "kulms-timetable-wrapper";
    timetableWrapper.appendChild(result.table);
    pinnedSection.appendChild(timetableWrapper);

    var otherSection = buildOtherSection(result.others);
    if (otherSection) {
      pinnedSection.appendChild(otherSection);
    }

    var assignmentsPanel = buildAssignmentsPanel();
    pinnedSection.appendChild(assignmentsPanel);

    if (window.__kulmsCourseUrgency) {
      applyUrgencyColors(window.__kulmsCourseUrgency);
    }

    if (window.__kulmsAssignments) {
      renderAssignmentsPanel(window.__kulmsAssignments);
    }

    return result;
  }

  // ============================================================
  // 時間割テーブルのみ差分更新（Phase 2 用）
  // 課題パネルのスクロール位置やDOMを破壊しない
  // ============================================================
  function updateTimetableGrid(pinnedSection, courses) {
    var result = buildTimetable(courses);

    // 既存の時間割テーブルと「その他」セクションを差し替え
    var oldWrapper = pinnedSection.querySelector(".kulms-timetable-wrapper");
    var oldOther = pinnedSection.querySelector(".kulms-tt-other-section");

    if (oldWrapper) {
      var newWrapper = document.createElement("div");
      newWrapper.className = "kulms-timetable-wrapper";
      newWrapper.appendChild(result.table);
      oldWrapper.replaceWith(newWrapper);
    }

    if (oldOther) {
      var newOther = buildOtherSection(result.others);
      if (newOther) {
        oldOther.replaceWith(newOther);
      } else {
        oldOther.remove();
      }
    } else {
      var newOther = buildOtherSection(result.others);
      if (newOther) {
        // 課題パネルの前に挿入
        var assignPanel = pinnedSection.querySelector(".kulms-timetable-assign-panel");
        if (assignPanel) {
          pinnedSection.insertBefore(newOther, assignPanel);
        } else {
          pinnedSection.appendChild(newOther);
        }
      }
    }

    if (window.__kulmsCourseUrgency) {
      applyUrgencyColors(window.__kulmsCourseUrgency);
    }

    return result;
  }

  // ============================================================
  // ピン留めセクションを時間割に置換（二段階レンダリング）
  // ============================================================
  var timetableInserted = false;

  async function insertTimetable() {
    if (timetableInserted) return;

    var pinnedSection = document.querySelector(".pinned-site-section");
    if (!pinnedSection) return;

    var courses = collectPinnedCourses();
    if (courses.length === 0) return;

    timetableInserted = true;

    // ★ Phase 1: 即座に時間割を表示（spans=1、連続コマ情報なし）
    renderTimetable(pinnedSection, courses);

    console.log("[Comfortable KULMS] Phase 1: 時間割を即時表示 (" + courses.length + " 科目)");

    // ★ Phase 2: KULASIS からスケジュール情報を取得し、連続コマがあれば再描画
    try {
      courses = await fetchSchedulesFromKULASIS(courses);

      var hasMultiSpan = courses.some(function (c) { return c.spans > 1; });
      if (hasMultiSpan) {
        // 連続コマが見つかったので時間割テーブルのみ差分更新（課題パネル保持）
        updateTimetableGrid(pinnedSection, courses);
        console.log("[Comfortable KULMS] Phase 2: 連続コマ反映で再描画 (" +
          courses.filter(function (c) { return c.spans > 1; }).length + " 連続コマ)");
      } else {
        console.log("[Comfortable KULMS] Phase 2: 連続コマなし、再描画スキップ");
      }
    } catch (e) {
      console.warn("[Comfortable KULMS] Phase 2 failed, using Phase 1 display:", e);
    }
  }

  // ============================================================
  // 課題データ更新コールバック
  // ============================================================
  window.__kulmsOnAssignmentsUpdated = function (assignments, courseUrgency) {
    applyUrgencyColors(courseUrgency);
    renderAssignmentsPanel(assignments);
  };

  // ============================================================
  // 初期化
  // ============================================================
  window.__kulmsSettingsReady.then(function (s) {
    if (s.timetableEnabled === false) return;

    function tryInsert() {
      if (document.querySelector(".pinned-site-section")) {
        insertTimetable();
      } else {
        setTimeout(tryInsert, 200);
      }
    }

    setTimeout(tryInsert, 500);

    var mo = new MutationObserver(function () {
      if (!timetableInserted && document.querySelector(".pinned-site-section")) {
        insertTimetable();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
})();
