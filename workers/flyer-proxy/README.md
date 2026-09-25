# チラシ画像プロキシ（Cloudflare Worker）

ブラウザから直接取得できない（CORS）チラシ画像URLを、サーバー側で取得して返す小さなプロキシです。  
**Gemini API キーは扱いません。** 画像バイトの中継のみです。

## デプロイ

```bash
cd workers/flyer-proxy
npm install
npx wrangler login   # 初回のみ
npx wrangler deploy
```

成功すると `https://shopping-memo-flyer-proxy.<あなたのサブドメイン>.workers.dev` のような URL が表示されます。

任意の共有シークレット（推奨）:

```bash
npx wrangler secret put PROXY_SECRET
# 値を入力（例: 長いランダム文字列）
```

## アプリ側の設定

1. 買い物メモ → ⚙️設定
2. 「チラシ画像プロキシ URL」に Worker のベース URL を貼る（末尾スラッシュなしで可）  
   例: `https://shopping-memo-flyer-proxy.example.workers.dev`
3. シークレットを設定した場合は「プロキシ用シークレット」にも同じ値を保存
4. 「保存」

チラシタブの「URLから読み込み」は、プロキシが設定されていれば  
`GET {proxy}/?url={encodeURIComponent(imageUrl)}` 経由で画像を取得します。

## API

### `GET /?url=<image-url>`

成功時: 画像バイト + `Content-Type: image/...` + CORS ヘッダ

### `POST /` （JSON）

```json
{ "url": "https://example.com/flyer.jpg" }
```

### CORS

許可 Origin（既定）:

- `https://momonga3594.github.io`
- `http://localhost:5173` / `http://127.0.0.1:5173`
- `http://localhost:4173` / `http://127.0.0.1:4173`（vite preview）

`OPTIONS` プリフライトに対応。任意ヘッダ `X-Proxy-Secret`。

### エラー JSON 例

```json
{ "error": "blocked_host", "message": "..." }
```

## SSRF / 安全対策（実装済み）

- `http:` / `https:` のみ
- ホスト名 `localhost` / `.local` / `.internal` などを拒否
- IP リテラルおよび DNS 解決後のアドレスがプライベート／ループバック／リンクローカル／メタデータ（例: `169.254.169.254`）なら拒否
- リダイレクトは手動フォロー（最大 5 hop）。各 hop で再検証
- 応答サイズ上限 約 8MB、タイムアウト約 15 秒
- `Content-Type: image/*` またはマジックバイトで画像判定
- ブラウザ風 `User-Agent` を付与

## ローカル確認

```bash
npx wrangler dev
curl -i "http://127.0.0.1:8787/?url=https%3A%2F%2Fhttpbin.org%2Fimage%2Fjpeg"
```
