# Comfortable KULMS Pre-Release Notes (2026-04-18)

## 対象バージョン

- Manifest version: `1.0.0`
- 対象リリース: プレリリース（内部配布・限定公開想定）

## 今回の主な変更（リファクタリング）

`Refactoring Comfortable KULMS Codebase.md` で定義した Task 1〜6 を反映。

### 1. popup.js の提出済み判定を修正

- `isSubmitted()` の判定語彙を拡張
- 追加対応: `再提出 / resubmitted / 返却 / returned` など
- 目的: popup 側の完了判定と content script 側の判定差を解消

### 2. settings.js の iframe 実行を抑制

- `window !== window.top` の場合はスタブのみ設定
- top frame でのみ本処理（storage 読み込み・i18n 読み込み）を実行
- 目的: iframe での不要処理を防ぎ、安定性と負荷を改善

### 3. 時間割ドロップダウン参照の安定化

- サイドバーの `.site-page-list` を `cloneNode(true)` で保持
- ドロップダウン生成時は `course.toolListClone` を優先利用
- 目的: Phase 2 再描画後でもツールメニュー参照が壊れないようにする

### 4. i18n 対応の補完

- `timetableHeading` を `ja/en` に追加
- 時間割見出しを `t("timetableHeading")` へ変更
- 追加で「その他」見出しも `t("sectionOther")` を利用
- 目的: 表示文言のハードコード排除と言語切替の整合性向上

### 5. Phase 2 再描画を差分更新化

- `updateTimetableGrid()` を追加
- Phase 2 では時間割テーブルと「その他」だけを更新
- 課題パネル（DOM・スクロール位置）は保持
- 目的: 再描画時の UI 破壊を回避し、操作感を安定化

### 6. 可読性リファクタ

- 変数・関数名の明確化（挙動変更なし）
- 例:
  - `toHalfWidth` → `parseFullWidthNumber`
  - `dd` → `dropdown`
  - `a` → `itemLink` / `link`
  - `s` → `normalizedStatus`
  - `d` → `deadlineDate`
  - ループ変数 `i` / `s` → `slotIndex` / `spanOffset`

## 変更ファイル（リファクタ関連）

- `popup.js`
- `src/settings.js`
- `src/timetable.js`
- `src/timetable-dropdown.js`
- `_locales/ja/messages.json`
- `_locales/en/messages.json`

## 期待される改善点

- popup での完了判定の誤表示減少
- iframe 上での不要初期化減少
- 時間割再描画時のドロップダウン不整合低減
- i18n 適用範囲の拡張
- 将来改修時の可読性・保守性向上

## プレリリース確認項目（最小）

1. popup で再提出済み課題が適切に完了扱いになる
2. 時間割見出しが言語設定に応じて切り替わる
3. 科目名クリックでツールドロップダウンが開く
4. Phase 2 再描画後もドロップダウンが機能する
5. 時間割下部課題パネルが再描画で消えない

## 既知の注意点

- ダークモードの見た目最適化は未完了（今後対応候補）
- 実環境での KULASIS 応答揺れに対する追加監視は今後の改善余地あり

