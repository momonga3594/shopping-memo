# 買い物メモ

スマートフォン縦画面を最優先にした、シンプルな買い物リスト Web アプリです。ログイン不要・サーバー不要で、ブラウザの `localStorage` に保存します。下部タブで「メモ」（買い物リスト）と「チラシ」（画像から商品追加）を切り替えます。音声入力（Web Speech API）、Google Gemini による AI 整理にも対応。購入先（店舗）ごとにリストをグループ表示できます。

公開 URL: https://momonga3594.github.io/shopping-memo/

実機確認用チェックリスト: [docs/smoke-test.md](docs/smoke-test.md)

## 機能

- テキストで買い物アイテムを追加（名前＋任意の数量・購入先）
- **購入先でグループ表示**: 「イオン」「原信」など店舗ごとにセクション分け（未設定は最後）
- **AIで整理**: 雑な日本語テキストや音声認識結果から買い物アイテムを抽出してリストへ追加（店名が文中で明確なときは購入先も抽出）
- **下部タブ**: 「メモ」「チラシ」を切り替え（最後に開いたタブを記憶）
- **チラシタブ**: チラシ写真／ギャラリー画像（または公開画像URL）を Gemini で解析し、商品を選んでリストへ追加
- 完了／未完了の切り替え
- アイテム削除・購入先のあとから変更（タップで編集）
- 完了済みをまとめて削除
- ページ再読み込み後も内容を保持（localStorage）
- マイクボタンで日本語の音声入力（`ja-JP`）
- **モバイルファースト UI**: 下部タブ＋メモ時は追加／AI／マイク操作、大きなタップ領域、ノッチ・ホームインジケータ対応
- ホーム画面追加向け（Web App Manifest / テーマカラー / apple-touch-icon）

## ホーム画面に追加（おすすめ）

アプリのように全画面で使うと片手操作しやすいです。

- **iPhone / iPad (Safari)**: 共有 → 「ホーム画面に追加」
- **Android (Chrome)**: メニュー（⋮）→ 「ホーム画面に追加」または「アプリをインストール」

## AIで整理（Gemini）の使い方

1. 画面右上の ⚙️（設定）を開く
2. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを取得し、入力して「保存」
3. 入力欄に例のような文を貼る／タイプする、またはマイクで話す  
   例: `牛乳と卵、あと豆腐二つ。洗剤も忘れずに`  
   例（購入先つき）: `イオンで牛乳と卵、原信で豆腐`
4. 「AIで整理」を押す → 抽出されたアイテムがリストに追加されます

キーは **このブラウザの localStorage にだけ** 保存されます。リポジトリやサーバーには送信・コミットしません。

## チラシタブの使い方

1. 設定で Gemini API キーを保存しておく
2. 下部タブの「チラシ」を開く
3. 「写真・ギャラリー」でチラシを撮影／選択する（公開されている画像の直リンクURLでも可）
4. 解析結果を確認し、チェックを付けた商品だけ「選択したものを追加」→ メモタブに切り替わりリストへ反映

多くのネットチラシは画像の直URLを取れない（または CORS でブラウザから取得できない）ため、その場合はスクショや保存した画像を「写真・ギャラリー」から選んでください。

### チラシ画像プロキシ（任意・推奨）

CORS で直接取得できない画像URL向けに、Cloudflare Worker の小さなプロキシを同梱しています（`workers/flyer-proxy/`）。

**本番デプロイ済み URL:** `https://shopping-memo-flyer-proxy.momonga3594.workers.dev`

#### アプリ設定

1. ⚙️設定を開く
2. 「チラシ画像プロキシ URL」に上記 URL をそのまま貼る（末尾スラッシュなし）
3. 「プロキシ用シークレット」（プロキシシークレット）:
   - **空のまま** = 認証なし（**現状の本番はこの状態**）
   - Worker に `PROXY_SECRET` を設定した場合は、**同じ値**をここに保存する
4. 「保存」

#### Worker 側でシークレットを付ける（推奨・任意）

Worker URL が公開されている場合は設定を推奨します。未設定でも動作します。

```bash
cd workers/flyer-proxy
npx wrangler secret put PROXY_SECRET
# プロンプトで長いランダム文字列を入力
```

アプリ設定の「プロキシ用シークレット」にも同じ文字列を保存してください。片方だけだと画像取得が 401 になります。

新規デプロイや再デプロイ: `workers/flyer-proxy` で `npx wrangler deploy`（詳細は同ディレクトリの README）。

プロキシ URL 未設定時は従来どおりブラウザ直接取得にフォールバックします（失敗しやすいです）。  
**公開の第三者 CORS プロキシは使わないでください。**

### セキュリティ上の注意（クライアント側 API キー）

このアプリは GitHub Pages の静的サイトのため、Gemini API を **ブラウザから直接** 呼び出します。API キーは端末にアクセスできる人なら DevTools 等で見られる可能性があります。可能であれば Google AI Studio 側でキーの利用制限（HTTP リファラ制限など）を設定してください。共有端末では使い終わったら設定から「クリア」してください。

利用モデル（優先順）: `gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-2.0-flash`

## 必要な環境

- Node.js 18 以降（開発・ビルド用）
- モダンブラウザ（Chrome / Safari 推奨）
- AI整理を使う場合は Gemini API キー

## セットアップと起動

```bash
npm install
npm run dev
```

ブラウザで表示された URL（通常は http://localhost:5173）を開きます。

本番用ビルド:

```bash
npm run build
npm run preview
```

`dist/` に静的ファイルが出力されます。

## 公開・デプロイ（GitHub Pages）

本番は **`gh-pages` ブランチ** から配信します（Vite `base: '/shopping-memo/'`）。

### 自動デプロイ（推奨・一本化）

予定: `main` への push（または Actions の `workflow_dispatch`）で  
`.github/workflows/deploy-pages.yml` が `npm ci` → `npm run build` → `dist` を `gh-pages` へ配信します。

- `.nojekyll` と SPA 用 `404.html`（`index.html` のコピー）は workflow 側で付与します
- **Actions 導入後は手動で `gh-pages` を触らないでください**（並走すると上書き事故の原因になります）

**現状ブロッカー:** workflow ファイルの追加には GitHub OAuth／PAT の **`workflow` スコープ** が必要です。付与されるまで下記の手動デプロイを使います（草案は `docs/examples/deploy-pages.yml`（付与後に `.github/workflows/deploy-pages.yml` へコピー））。

### 手動デプロイ（現状の本番更新手段／Actions 不可時の逃げ道）

Actions がリポジトリに入るまでのあいだ、または Actions 障害時:

```bash
npm ci
npm run build
touch dist/.nojekyll
cp dist/index.html dist/404.html
npx gh-pages -d dist
```

自動デプロイが動くようになったら、この手動手順は使わず Actions に一本化してください。

## 音声入力について

- **HTTPS または localhost** でのみマイクが使えます（ブラウザのセキュリティ要件）。
- **Chrome** と **Safari** で動作確認しやすいです。対応していないブラウザではマイクボタンを隠し、短い案内を表示します。
- 初回はマイク権限の許可が必要です。拒否した場合は日本語のエラーメッセージを表示します。
- 音声認識結果は入力欄に入ります。内容を確認してから「追加」または「AIで整理」を押してください（自動では AI 呼び出ししません）。

## 技術スタック

- Vite
- バニラ HTML / CSS / JavaScript（依存は Vite のみ）
- Google Gemini API（`generativelanguage.googleapis.com`、ブラウザから REST 呼び出し）
- 任意: Cloudflare Worker（チラシ画像取得プロキシ、`workers/flyer-proxy`）

## ライセンス

MIT
