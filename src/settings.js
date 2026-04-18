// Comfortable KULMS - 設定初期化 + i18nヘルパー
// kulms-extension の settings.js をベースに簡素化

// iframe 内では最小限のスタブのみ設定（他スクリプトのエラー防止）
if (window !== window.top) {
  window.__kulmsSettings = {};
  window.__kulmsSettingsReady = Promise.resolve({});
  window.__kulmsSafeStorage = {
    get: function (keys, cb) { if (cb) cb({}); },
    set: function () {}
  };
  // t() は settings.js の IIFE 外で定義されるグローバル関数なので、
  // iframe 用のスタブも同様にグローバルに定義
  if (typeof t !== "function") {
    window.t = function (key) { return key; };
  }
} else {

console.log("[Comfortable KULMS] loaded on:", window.location.href);

// === コンテキスト無効化対策 ===

window.__kulmsAlive = function () {
  try { return !!chrome.runtime.id; } catch (e) { return false; }
};

window.__kulmsShowReloadBanner = function () {
  if (window.__kulmsReloadBannerShown) return;
  if (window.__kulmsAlive()) return;
  window.__kulmsReloadBannerShown = true;
  var banner = document.createElement("div");
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a73e8;color:#fff;font-size:14px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  var msg = document.createElement("span");
  msg.textContent = "Comfortable KULMS が更新されました。ページを再読み込みしてください。";
  var btns = document.createElement("span");
  btns.style.cssText = "display:flex;gap:8px;align-items:center;flex-shrink:0";
  var reloadBtn = document.createElement("button");
  reloadBtn.textContent = "再読み込み";
  reloadBtn.style.cssText = "background:#fff;color:#1a73e8;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold";
  reloadBtn.addEventListener("click", function () { location.reload(); });
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "\u00D7";
  closeBtn.style.cssText = "background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;line-height:1";
  closeBtn.addEventListener("click", function () { banner.remove(); });
  btns.appendChild(reloadBtn);
  btns.appendChild(closeBtn);
  banner.appendChild(msg);
  banner.appendChild(btns);
  document.body.appendChild(banner);
};

window.__kulmsSafeStorage = {
  get: function (keys, callback) {
    if (!window.__kulmsAlive()) {
      window.__kulmsShowReloadBanner();
      if (callback) callback({});
      return;
    }
    chrome.storage.local.get(keys, callback);
  },
  set: function (items) {
    if (!window.__kulmsAlive()) {
      window.__kulmsShowReloadBanner();
      return;
    }
    chrome.storage.local.set(items);
  }
};

// === 設定読み込み ===

window.__kulmsDefaults = {
  // 時間割関連
  tabColoring: true,
  tabColorStyle: "background",
  timetableEnabled: true,

  // 課題更新間隔
  fetchInterval: 120,

  // 緊急度閾値
  dangerHours: 24,
  warningDays: 5,
  successDays: 14,

  // カスタムカラー
  colorDanger: "#e85555",
  colorWarning: "#d7aa57",
  colorSuccess: "#62b665",
  colorOther: "#777777",

  // 継承機能
  courseNameCleanup: true,
  pinSort: true,
  courseRowClick: false,
  toolVisibility: true,
  sidebarResize: true,
  autoComplete: true,
  folderExpand: false,
  autoExpandAll: false,

  // 言語設定
  language: "auto"
};

window.__kulmsSettingsReady = new Promise(function (resolve) {
  var DEFAULTS = window.__kulmsDefaults;
  window.__kulmsSafeStorage.get("kulms-settings", function (result) {
    var saved = result["kulms-settings"] || {};
    window.__kulmsSettings = Object.assign({}, DEFAULTS, saved);
    loadOverrideMessages(window.__kulmsSettings.language).then(function () {
      resolve(window.__kulmsSettings);
    });
  });
});

// === i18n ヘルパー ===
var __kulmsOverrideMessages = null;

function t(key, substitutions) {
  // 言語上書きが有効な場合、ローカル辞書から取得
  if (__kulmsOverrideMessages && __kulmsOverrideMessages[key]) {
    var entry = __kulmsOverrideMessages[key];
    var msg = entry.message;
    if (substitutions && entry.placeholders) {
      var subs = Array.isArray(substitutions) ? substitutions : [substitutions];
      Object.keys(entry.placeholders).forEach(function (name) {
        var idx = parseInt(entry.placeholders[name].content.replace(/\$/g, "")) - 1;
        if (idx >= 0 && idx < subs.length) {
          msg = msg.replace(new RegExp("\\$" + name.toUpperCase() + "\\$", "g"), subs[idx]);
        }
      });
    }
    return msg;
  }
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function loadOverrideMessages(lang) {
  var resolvedLang = lang;
  if (!resolvedLang || resolvedLang === "auto") {
    var uiLang = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || "en";
    resolvedLang = uiLang.toLowerCase().indexOf("ja") === 0 ? "ja" : "en";
  }
  var url = chrome.runtime.getURL("_locales/" + resolvedLang + "/messages.json");
  return fetch(url).then(function (res) { return res.json(); })
    .then(function (data) { __kulmsOverrideMessages = data; })
    .catch(function (e) { console.warn("[Comfortable KULMS] loadOverrideMessages failed:", e); __kulmsOverrideMessages = null; });
}

} // end of else (top-frame only)
