// === Comfortable KULMS - 時間割ツールメニュー ===
// 時間割セルの科目名をクリックした時にツールリストを表示

(function () {
  "use strict";

  if (window !== window.top) return;

  var dropdownEl = null;
  var currentAnchor = null;

  // サイドバーから該当科目のツールリストを検索
  function findToolList(siteId) {
    // ピン留めサイドバー
    var pinned = document.getElementById("site-list-pinned-item-" + siteId);
    if (pinned) {
      var ul = pinned.querySelector(".site-page-list");
      if (ul) return ul;
    }
    // 通常サイドバー
    var main = document.getElementById("site-list-item-" + siteId);
    if (main) {
      var ul2 = main.querySelector(".site-page-list");
      if (ul2) return ul2;
    }
    return null;
  }

  // ドロップダウンメニューを構築
  // course オブジェクトから保持済みのサイドバー要素を優先的に使う
  function buildDropdown(siteId, toolListSource, syllabusUrl) {
    // ★ 保持済みDOM → 現在のDOM検索の順でフォールバック
    var source = toolListSource || findToolList(siteId);
    var navItems = source ? Array.from(source.querySelectorAll(":scope > .nav-item")) : [];
    // kulms-extension が追加した補助要素は除外
    navItems = navItems.filter(function (li) {
      return !li.classList.contains("kulms-other-toggle");
    });
    if (navItems.length === 0 && !syllabusUrl) return null;

    var dropdown = document.createElement("div");
    dropdown.className = "kulms-tt-dropdown";
    dropdown.setAttribute("role", "menu");

    navItems.forEach(function (navItem) {
      var srcLink = navItem.querySelector("a");
      if (!srcLink || !srcLink.href) return;
      var span = navItem.querySelector("span");
      var name = span ? (span.textContent || "").trim() : "";

      var itemLink = document.createElement("a");
      itemLink.className = "kulms-tt-dropdown-item";
      itemLink.href = srcLink.href;
      itemLink.setAttribute("role", "menuitem");

      // アイコン
      var icon = navItem.querySelector("i");
      if (icon) {
        var iconClone = icon.cloneNode(true);
        itemLink.appendChild(iconClone);
      }

      // ラベル
      var label = document.createElement("span");
      label.className = "kulms-tt-dropdown-label";
      label.textContent = name;
      itemLink.appendChild(label);

      dropdown.appendChild(itemLink);
    });

    if (syllabusUrl) {
      var syllabusLink = document.createElement("a");
      syllabusLink.className = "kulms-tt-dropdown-item";
      syllabusLink.href = syllabusUrl;
      syllabusLink.setAttribute("role", "menuitem");

      var syllabusIcon = document.createElement("i");
      syllabusIcon.className = "fa fa-book";
      syllabusLink.appendChild(syllabusIcon);

      var syllabusLabel = document.createElement("span");
      syllabusLabel.className = "kulms-tt-dropdown-label";
      syllabusLabel.textContent = t("timetableSyllabus");
      syllabusLink.appendChild(syllabusLabel);
      dropdown.appendChild(syllabusLink);
    }

    return dropdown;
  }

  // ドロップダウンの位置を調整
  function positionDropdown(dropdown, anchor) {
    var rect = anchor.getBoundingClientRect();
    var dropdownHeight = dropdown.offsetHeight;
    var dropdownWidth = dropdown.offsetWidth;

    // デフォルトは科目名の右側に表示
    var top = rect.top;
    var left = rect.right + 6;

    // 画面の右端にはみ出さないよう調整
    if (left + dropdownWidth > window.innerWidth - 8) {
      left = Math.max(8, rect.left - dropdownWidth - 6);
    }

    // 画面の上下にはみ出さないよう調整
    if (top < 8) top = 8;
    if (top + dropdownHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - dropdownHeight - 8);

    dropdown.style.top = top + "px";
    dropdown.style.left = left + "px";
  }

  // ドロップダウンを閉じる
  function closeDropdown() {
    if (currentAnchor) currentAnchor.classList.remove("is-open");
    if (dropdownEl) dropdownEl.remove();
    dropdownEl = null;
    currentAnchor = null;
  }

  // ドロップダウンを開く
  function openDropdown(anchor, course) {
    closeDropdown();

    var toolListSource = course.toolListClone || null;
    var dropdown = buildDropdown(course.siteId, toolListSource, course.syllabusUrl);
    if (!dropdown) return;

    dropdown.style.position = "fixed";
    dropdown.style.visibility = "hidden";
    document.body.appendChild(dropdown);
    positionDropdown(dropdown, anchor);
    dropdown.style.visibility = "";

    dropdownEl = dropdown;
    currentAnchor = anchor;
    anchor.classList.add("is-open");
  }

  // トグル
  function toggleDropdown(anchor, course) {
    if (currentAnchor === anchor) {
      closeDropdown();
    } else {
      openDropdown(anchor, course);
    }
  }

  // 外側クリックで閉じる
  document.addEventListener("click", function (e) {
    if (!dropdownEl) return;
    if (dropdownEl.contains(e.target)) return;
    if (currentAnchor && currentAnchor.contains(e.target)) return;
    closeDropdown();
  }, true);

  // Escで閉じる
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dropdownEl) closeDropdown();
  });

  // リサイズ時に位置追従
  window.addEventListener("resize", function () {
    if (dropdownEl && currentAnchor) {
      positionDropdown(dropdownEl, currentAnchor);
    }
  });

  // API公開
  window.__kulmsTimetableDropdown = {
    toggle: toggleDropdown,
    close: closeDropdown,
  };
})();
