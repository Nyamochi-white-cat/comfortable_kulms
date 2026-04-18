# Comfortable KULMS - 開発ドキュメント

## 概要

**Comfortable KULMS** は、京都大学の学習支援システム KULMS (Sakai LMS) のサイドバーの「ピン留め」セクションを **曜日×時限の時間割グリッド** に置換し、各セルに **課題の提出期限の緊急度に応じた色分け** を行う Chrome 拡張機能です。

**ベースプロジェクト**: [kulms-extension (KULMS+)](../kulms-extension/) をフォークし、パネルUI・教科書・ポップアップ等を削除して時間割表示に特化させました。

---

## 対象サイト

- **KULMS**: `https://lms.gakusei.kyoto-u.ac.jp/*`
- **KULASIS (シラバス検索)**: `https://www.k.kyoto-u.ac.jp/external/open_syllabus/*`

---

## ファイル構成

```
comfortable_kulms/
├── manifest.json                  # Chrome拡張マニフェスト (Manifest V3)
├── background.js                  # Service Worker: KULASIS シラバス検索
├── styles.css                     # 全スタイル: 時間割テーブル, ドロップダウン, 色分け等
├── src/
│   ├── settings.js                # 設定読み込み + i18n + storage安全ラッパー
│   ├── assignments.js             # 課題取得 (Sakai Direct API) + 緊急度計算
│   ├── timetable.js               # ★メイン: 時間割グリッド生成 + rowspan + 色分け
│   ├── timetable-dropdown.js      # 科目名クリックメニュー（ツールリスト表示）
│   ├── course-name.js             # [継承] 科目名短縮 + ピン留めソート + NOW/NEXTバッジ
│   ├── course-click.js            # [継承] 行クリック展開
│   ├── tool-visibility.js         # [継承] ツール表示/非表示管理
│   ├── submit-detect.js           # [継承] 課題提出検出 (色消し用)
│   ├── tree-view.js               # [継承] 授業資料ツリービュー
│   └── sidebar-resize.js          # サイドバーリサイズ (デフォルト450px)
├── _locales/
│   ├── ja/messages.json           # 日本語メッセージ
│   └── en/messages.json           # 英語メッセージ
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── DEVELOPMENT.md                 # ← このファイル
```

---

## アーキテクチャ

### 実行順序

```
1. settings.js     → chrome.storage.local から設定読み込み、i18n初期化
                      → window.__kulmsSettingsReady (Promise) を公開
2. assignments.js  → 設定完了を待って Sakai Direct API で課題取得
                      → window.__kulmsAssignments, window.__kulmsCourseUrgency に公開
                      → window.__kulmsOnAssignmentsUpdated() コールバックで通知
3. course-name.js  → サイドバー科目名を [2026前期月３]→[月３] に短縮、ピン留めソート
4. timetable.js    → ピン留めセクションを時間割テーブルに置換
                      → background.js にKULASIS検索を依頼して連続コマ判定
                      → 課題データから色分け適用
                      → 時間割下部に課題パネルを表示
5. timetable-dropdown.js → セルの科目名クリック時にツールメニューを表示
```

### データフロー

```
                  ┌──────────────────────┐
                  │  KULMS サイドバー DOM │
                  │  (#pinned-site-list) │
                  └──────────┬───────────┘
                             │ 科目名・siteId・ツールリスト抽出
                             ▼
                  ┌──────────────────────┐
                  │    timetable.js      │
                  │  parseCourse() で    │
                  │  曜日・時限を解析     │
                  └──────┬────┬──────────┘
                         │    │
         ┌───────────────┘    └───────────────┐
         ▼                                    ▼
┌────────────────────┐              ┌──────────────────────┐
│  background.js     │              │  assignments.js      │
│  KULASIS検索       │              │  Sakai Direct API    │
│  → 曜時限取得      │              │  → 課題データ取得     │
│  (火3 火4 → 2コマ) │              │  → 緊急度計算        │
└────────┬───────────┘              └──────────┬───────────┘
         │ spans情報                            │ courseUrgency
         ▼                                     ▼
┌────────────────────────────────────────────────────────────┐
│              時間割テーブル (HTML <table>)                  │
│  ┌───┬───┬───┬───┬───┐                                    │
│  │月 │火 │水 │木 │金 │  ← 曜日ヘッダー                    │
│  ├───┼───┼───┼───┼───┤                                    │
│  │1限│   │   │   │   │  ← 各セルの科目名クリックでメニュー表示 │
│  │2限│   │   │   │   │  ← 背景色 = 課題の緊急度           │
│  │3限│===│   │   │   │  ← rowspan=2 で2コマ連続表示       │
│  │4限│===│   │   │   │                                    │
│  │5限│   │   │   │   │                                    │
│  └───┴───┴───┴───┴───┘                                    │
│  [その他] 時限情報がない科目をリスト表示                     │
└────────────────────────────────────────────────────────────┘
```

---

## 各ファイル詳細

### manifest.json

- Manifest V3
- `host_permissions`: KULMS + KULASIS (シラバス検索用)
- ツールバーポップアップあり (`action.default_popup = popup.html`)
- コンテンツスクリプトは `document_idle` + `all_frames: true`

### background.js (308行)

**KULASIS シラバス検索** を行い、科目の曜時限情報を返す Service Worker。

- **Shift_JIS エンコード**: KULASIS の検索フォームが Shift_JIS を要求するため、`buildSjisEncodeTable()` で変換テーブルを構築
- **`fetchAndDecode(url)`**: Shift_JIS / EUC-JP 対応のHTML取得（15秒タイムアウト付き）
- **`searchSchedule(keyword)`**: KULASIS の `/search` エンドポイントを叩き、結果テーブルから科目名と曜時限を抽出
- **`lookupSchedule(courseName, courseDay, coursePeriod)`**: 科目名をクリーンアップして検索し、完全一致→部分一致→先頭結果の順でマッチ。フォールバック時は元の曜日との矛盾を検証
- **`parseScheduleSlots(scheduleStr)`**: `"火3 火4"` → `[{day:"火", period:3}, {day:"火", period:4}]` に変換
- **KULASISキャッシュ**: `chrome.storage.local` に検索結果をキャッシュ（1日有効）。2回目以降はキャッシュからロード
- **メッセージハンドラ**: `action: "lookupSchedules"` で複数科目を一括検索（5件ずつ並列、キャッシュ併用）

### src/settings.js (134行)

- **`window.__kulmsSafeStorage`**: chrome.storage.local のラッパー（コンテキスト無効化対策）
- **`window.__kulmsSettingsReady`**: 設定読み込み完了の Promise
- **`t(key)`**: i18n ヘルパー関数
- **デフォルト設定**: `tabColoring: true`, `tabColorStyle: "background"`, `timetableEnabled: true`, `dangerHours: 24`, `warningDays: 5`, `successDays: 14`

### src/assignments.js (582行)

kulms-extension の 2393行から **パネルUI・メモ・プレビュー・教科書を全削除** し、課題取得APIのみに特化。

**公開API** (`window.__kulmsAssignmentAPI`):
- `getUrgencyClass(deadline)` — 締切までの時間から緊急度クラスを返す
- `isSubmitted(status)` — 提出済みか判定
- `isAssignmentChecked(assignment)` — ユーザーが手動チェック済みか判定
- `computeCourseUrgency(assignments)` — コースごとの最高緊急度マップを計算
- `loadAssignments(forceRefresh)` — 課題データを取得/キャッシュから読み込み

**公開データ**:
- `window.__kulmsAssignments` — 最新の課題配列
- `window.__kulmsCourseUrgency` — `{courseId: "urgency-danger"}` 形式のマップ
- `window.__kulmsOnAssignmentsUpdated(assignments, courseUrgency)` — 更新通知コールバック

**Sakai Direct API エンドポイント**:
- `/direct/assignment/site/{siteId}.json` — 科目の課題一覧
- `/direct/assignment/item/{entityId}.json` — 課題詳細（提出状態含む）
- `/direct/sam_pub/context/{siteId}.json` — テスト・クイズ一覧
- `/direct/site.json?_limit=200` — 全サイト一覧（フォールバック）

### src/timetable.js (476行) ★メイン

**ピン留めセクションを時間割テーブルに置換するメインスクリプト**。

1. **`collectPinnedCourses()`**: `#pinned-site-list` の各 `<li>` から siteId, 科目名, URL を抽出。ツールリストは初回描画時にクローンせず、メニュー表示時に参照
2. **`parseCourse(fullName)`**: 正規表現 `^\s*\[(?:\d{4}[^\]]*?)?([月火水木金土日])\s*([０-９0-9]+)\s*\](.*)` で曜日・時限・短縮名を抽出
   - **重要**: `course-name.js` が先に `[2026前期月３]` → `[月３]` に変換するため、`(?:\d{4}[^\]]*?)?` でオプショナルにしている
3. **`fetchSchedulesFromKULASIS(courses)`**: background.js に `lookupSchedules` メッセージを送り、各科目の曜時限を取得 → `spans` プロパティに反映
   - 10秒タイムアウト: KULASIS が応答しない場合はデフォルト(1コマ)で表示
   - **曜日情報を含めて送信**: フォールバック時の矛盾検証に使用
4. **`buildTimetable(courses)`**: 5×5の `<table>` を構築。`spans > 1` の科目は `rowspan` で結合し、後続時限のセルをスキップ。**2-5コマ連続に対応**
5. **二段階レンダリング**: Phase 1で即時表示（spans=1）→ Phase 2でKULASIS結果反映後に再描画
6. **`applyUrgencyColors(courseUrgency)`**: `window.__kulmsCourseUrgency` に基づいて `.kulms-tt-urgency-*` クラスをセルに適用
7. **`buildAssignmentsPanel()` / `renderAssignmentsPanel(assignments)`**: 時間割下部に課題パネルを表示。緊急度セクション分け・更新ボタン付き

**緊急度 → CSSクラスのマッピング**:
| 緊急度 | CSSクラス | 色 |
|--------|-----------|-----|
| urgency-overdue | kulms-tt-urgency-danger | 赤 (#e85555) |
| urgency-danger | kulms-tt-urgency-danger | 赤 |
| urgency-warning | kulms-tt-urgency-warning | 黄 (#d7aa57) |
| urgency-success | kulms-tt-urgency-success | 緑 (#62b665) |
| urgency-other | kulms-tt-urgency-other | 灰 (#777777) |

### src/timetable-dropdown.js (162行)

セルの科目名クリック時に、該当科目のツールリストをメニュー表示。

- **`findToolList(siteId)`**: サイドバーの元の `<li>` から `.site-page-list` を検索（フォールバック用）
- **`buildDropdown(siteId, toolListSource)`**: ツール一覧をドロップダウン要素として構築。保持済みDOMを優先し、なければ検索でフォールバック
- **`positionDropdown(dd, anchor)`**: 科目名の右側に表示しつつ、画面端ではみ出さないよう補正
- **閉じる**: 外側クリック or Escキー

### src/sidebar-resize.js (98行)

- デフォルト幅: **450px** (時間割5列が入る幅)
- 最小幅: 200px、最大幅: 700px
- CSS Grid の `grid-template-columns` を動的に書き換え
- 幅は `localStorage` に保存

### styles.css (384行)

- **時間割テーブル**: `.kulms-timetable`, `.kulms-tt-cell`, `.kulms-tt-day-header`, `.kulms-tt-period-header`
- **セル内**: `.kulms-tt-course`, `.kulms-tt-course-name`
- **連続コマ**: `.kulms-tt-cell-multi` (rowspan=2以上のセル、高さはJSで動的計算)
- **緊急度色**: `.kulms-tt-urgency-danger/warning/success/other` (`color-mix()` で背景色生成)
- **ドロップダウン**: `.kulms-tt-dropdown`, `.kulms-tt-dropdown-item` (fadein アニメーション付き)
- **その他**: サイドバーリサイズハンドル、ツール表示管理、NOW/NEXTバッジ、時間割下部課題パネル

### 継承ファイル（kulms-extension からそのまま）

| ファイル | 行数 | 機能 |
|---------|------|------|
| course-name.js | 209 | 科目名短縮 `[2026前期月３]→[月３]`, ピン留めソート, NOW/NEXTバッジ |
| course-click.js | 29 | サイドバー行クリックで展開/折り畳み |
| tool-visibility.js | 163 | ツール表示/非表示管理 |
| submit-detect.js | 76 | 課題提出を検出して `sessionStorage` にフラグ設定 |
| tree-view.js | 193 | 授業資料のツリービュー表示 |

---

## kulms-extension から削除したファイル・機能

| 削除対象 | 理由 |
|---------|------|
| src/textbooks.js | 教科書パネル不要 |
| src/top-favbar.js | 上部ピン留めバー（時間割に置換されたため） |
| assignments.js のパネルUI部分 (~1800行) | createPanel, renderAssignments, メモ, プレビュー等 |
| background.js のシラバス詳細取得 (~300行) | 教科書情報不要（曜時限検索のみ残した） |
| styles.css のパネル/教科書/メモCSS (~1200行) | 時間割用CSS に差し替え |

---

## 既知の課題・今後の改善点

### 確認済みバグ
- [修正済] `course-name.js` が先に科目名を短縮するため、timetable.js の正規表現がマッチしない → 正規表現を両形式対応に修正
- [修正済] `cleanCourseName()` が `（数理）` 等の短い括弧を除去して検索精度が低下 → 短い括弧は残すように改善
- [修正済] `timetable.js` が `innerHTML = ""` でサイドバーDOMを破壊し、ドロップダウンのツールリストが見つからない → 保持済み`li`参照 + DOM検索フォールバックに修正
- [修正済] KULASIS検索結果のフォールバックが別科目のスケジュールを採用 → 元の曜日との矛盾検証を追加
- [修正済] KULASIS検索が遅く時間割の初期表示が遅延 → 二段階レンダリング + バッチサイズ5 + キャッシュ導入
- [修正済] 連続コマのCSS高さが2コマ固定 → 動的高さ計算（2-5コマ対応）

### 未検証項目
- [ ] KULASIS シラバス検索のレスポンス形式が正しく解析できるか実環境で確認
- [ ] 課題提出後の色消し（submit-detect.js → assignments.js 再取得 → timetable.js 色更新）
- [ ] サイドバー幅450pxでの科目名表示の可読性
- [ ] モバイル表示 (幅770px以下) での挙動
- [ ] 科目名クリックメニューの表示位置がサイドバー内で正しいか

### 検討中の機能
- [ ] 4コマ目以降の表示検討（現在5限まで、6限以降がある場合は「その他」に出る）
- [ ] 科目セルの右クリックメニュー対応
- [ ] 時間割のキャッシュ（毎回KULASIS問い合わせを避ける）
- [ ] 設定画面（ポップアップ or オプションページ）
- [ ] ダークモード対応

---

## 開発環境セットアップ

### 拡張機能の読み込み

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」
4. `/home/nyamochi/Projects/chrome/comfortable_kulms` を選択

### デバッグ

- **コンテンツスクリプト**: KULMSタブの DevTools → Console (ログは `[Comfortable KULMS]` プレフィックス)
- **Service Worker**: `chrome://extensions` → Comfortable KULMS → 「サービスワーカー」リンク
- **拡張機能のリロード**: `chrome://extensions` → 🔄 ボタン → KULMSタブもリロード

### 注意事項

> **KULMS+ (kulms-extension) との同時使用は不可**。同じ DOM を操作するため競合します。テスト時は KULMS+ を無効にしてください。

---

## API リファレンス

### Sakai Direct API (KULMS)

| エンドポイント | 用途 |
|---------------|------|
| `/direct/assignment/site/{siteId}.json` | 科目の課題一覧 |
| `/direct/assignment/item/{entityId}.json` | 課題詳細（提出状態） |
| `/direct/sam_pub/context/{siteId}.json` | テスト・クイズ一覧 |
| `/direct/site.json?_limit=200` | 全サイト一覧 |
| `/direct/site/{siteId}/pages.json` | サイトのページ・ツール一覧 |

### KULASIS シラバス検索

| エンドポイント | 用途 |
|---------------|------|
| `https://www.k.kyoto-u.ac.jp/external/open_syllabus/search?condition.keyword=...` | 科目名検索（Shift_JIS） |

検索結果テーブルの列構成:
`科目名 | 担当教員 | 学部/大学院 | 学科等 | 授業形態 | 使用言語 | 開講期 | 曜時限 | レベル | 学問分野 | 詳細`

`曜時限` 列の値例: `月3` (1コマ), `火3 火4` (2コマ連続)

### chrome.storage.local キー

| キー | 内容 |
|------|------|
| `kulms-settings` | ユーザー設定 |
| `kulms-assignments` | 課題キャッシュ (`{timestamp, assignments}`) |
| `kulms-checked-assignments` | ユーザーが手動チェックした課題 |
| `kulms-kulasis-cache` | KULASISシラバス検索結果キャッシュ (`{timestamp, schedules}`) TTL: 1日 |

### localStorage キー

| キー | 内容 |
|------|------|
| `kulms-sidebar-width` | サイドバー幅 (px) |
| `comfortable-kulms-sidebar-v1` | 初回リセット済みフラグ |

---

## KULMS サイドバー DOM 構造

```html
<aside id="portal-nav-sidebar">
  <nav id="toolMenu">
    <div class="sites-section">              <!-- Home セクション -->
      <ul>
        <li id="site-list-home-item-{userId}" class="site-list-item" data-type="home">
          ...
        </li>
      </ul>
    </div>
    <div class="sites-section pinned-site-section">  <!-- ★ ここを時間割に置換 -->
      <h3 class="sites-section-heading">ピン留め</h3>
      <ul id="pinned-site-list">
        <li id="site-list-pinned-item-{siteId}" class="site-list-item"
            data-type="pinned" data-site="{siteId}">
          <div class="site-list-item-head">
            <div class="site-link-block">
              <button> (展開ボタン) </button>
              <a class="sidebar-site-title"
                 href="https://lms.gakusei.kyoto-u.ac.jp/portal/site/{siteId}">
                [月３]プログラミング演習（数理）   ← course-name.js が短縮済み
              </a>
            </div>
            <button class="site-opt-pin"> (ピン留めボタン) </button>
          </div>
          <div class="site-list-item-collapse collapse">
            <ul class="site-page-list">       ← timetable-dropdown.js がここからメニュー生成
              <li class="nav-item"><a href="...">概要</a></li>
              <li class="nav-item"><a href="...">カレンダー</a></li>
              <li class="nav-item"><a href="...">お知らせ</a></li>
              <li class="nav-item"><a href="...">授業資料（リソース）</a></li>
              <li class="nav-item"><a href="...">課題</a></li>
              ...
            </ul>
          </div>
        </li>
      </ul>
    </div>
    <div class="sites-section d-none">       <!-- 最近セクション（非表示）-->
    </div>
  </nav>
  <div class="sticky-footer">               <!-- すべてのサイトを表示 ボタン -->
  </div>
</aside>
```

---

## ユーザーの時間割（2026年度前期）

この情報は homepage.html のサイドバーから抽出したもの。

| siteId | 科目名 | 曜日 | 時限 |
|--------|--------|------|------|
| 2026-888-H498-001 | 神経心理学Ｉ | 月 | 1 |
| 2026-888-N130-006 | 線形代数学続論 | 月 | 2 |
| 2026-110-9143-000 | プログラミング演習（数理） | 月 | 3 (3-4?) |
| 2026-110-9096-000 | 確率離散事象論 | 月 | 5 |
| 2026-110-9129-000 | 情報符号理論 | 火 | 1 |
| 2026-888-H486-002 | 心理学II | 火 | 2 |
| 2026-110-9090-000 | 基礎数理演習（数理） | 火 | 3 (3-4?) |
| 2026-888-N228-004 | 振動・波動論 | 火 | 5 |
| 2026-110-9130-000 | 電気電子回路入門 | 水 | 1 |
| 2026-110-9070-100 | 論理システム（数理） | 水 | 2 |
| 2026-110-9116-000 | 人工知能 | 水 | 3 |
| 2026-888-N131-003 | 確率論基礎 | 木 | 1 |
| 2026-110-9030-100 | グラフ理論（数理） | 木 | 2 |
| 2026-888-N124-010 | 微分積分学続論Ｉ−ベクトル解析 | 木 | 3 |
| 2026-888-H496-001 | 認知心理学Ｉ | 金 | 2 |
