# Comfortable KULMS

Comfortable KULMS は、京都大学 LMS（KULMS / Sakai）のサイドバーを **時間割グリッド表示** に置き換え、課題締切の緊急度に応じて科目セルを色分けする Chrome 拡張機能です。

## 主な機能

- ピン留め科目を曜日×時限の時間割として表示
- 締切に応じた科目セルの色分け（緊急/注意/余裕/その他）
- 時間割セルから各科目ツールへのドロップダウンアクセス
- KULASIS 公開シラバス検索を用いた曜時限補完（キャッシュ付き）

## インストール（開発者モード）

1. このディレクトリを取得（clone またはダウンロード）
2. Chrome で `chrome://extensions/` を開く
3. 「デベロッパー モード」を有効化
4. 「パッケージ化されていない拡張機能を読み込む」で `comfortable_kulms` ディレクトリを選択

## 対応サイト

- `https://lms.gakusei.kyoto-u.ac.jp/*`
- `https://www.k.kyoto-u.ac.jp/*`

## 参照元（kulms-extension）

本プロジェクトは以下を参照して作成しています。

- Repository: `Radian0523/kulms-extension`
- URL: https://github.com/Radian0523/kulms-extension
- License: MIT License

`kulms-extension` の著作権およびライセンス条件は、同リポジトリの記載に従います。

## ライセンス

このプロジェクトは **MIT License** です。詳細は [LICENSE](./LICENSE) を参照してください。

## 免責

本拡張機能は非公式です。京都大学および KULMS の公式サポート対象ではありません。
