# チラシ画像プロキシ（Cloudflare Worker）

ブラウザから直接取得できない（CORS）チラシ画像URLを、サーバー側で取得して返す小さなプロキシです。  
イオンのチラシ**ビューアURL**から画像一覧を解決するモードもあります。  
**Gemini API キーは扱いません。** 画像バイトの中継とビューア解決のみです。

## デプロイ

```bash
cd workers/flyer-proxy
npm install
npx wrangler login   # 初回のみ
npx wrangler deploy
```

成功すると `https://shopping-memo-flyer-proxy.<あなたのサブドメイン>.workers.dev` のような URL が表示されます。

**本番（このリポジトリ所有者向け）:** `https://shopping-memo-flyer-proxy.momonga3594.workers.dev`

任意の共有シークレット（推奨・Worker URL が公開のとき）:

```bash
npx wrangler secret put PROXY_SECRET
# 値を入力（例: 長いランダム文字列）
```

未設定（空）のままでも認証なしで動作します。現状の本番は未設定です。

## アプリ側の設定

1. 買い物メモ → ⚙️設定
2. 「チラシ画像プロキシ URL」に Worker のベース URL を貼る（末尾スラッシュなしで可）  
   本番例: `https://shopping-memo-flyer-proxy.momonga3594.workers.dev`
3. 「プロキシ用シークレット」: Worker に `PROXY_SECRET` を付けたときだけ同じ値を保存。空 = 認証なし
4. 「保存」

チラシタブの「URLから読み込み」は、プロキシが設定されていれば  
- 画像直リンク: `GET {proxy}/?url={encodeURIComponent(imageUrl)}`
- イオンビューア: `GET {proxy}/?resolve={encodeURIComponent(viewerUrl)}`  
経由で取得します。

## API

### `GET /?url=<image-url>`

成功時: 画像バイト + `Content-Type: image/...` + CORS ヘッダ

### `GET /?resolve=<viewer-url>`

対応ビューア（現状: イオン `chirashi.otoku.aeonsquare.net`）を解析し、画像URL一覧を JSON で返します。

成功例:

```json
{
  "source": "aeon",
  "title": "9/25〜9/27",
  "shopName": "イオントヤの店",
  "images": [
    {
      "url": "https://chirashi.otoku.aeonsquare.net/viewer/images/....jpg",
      "thumbUrl": "https://.../viewer/images/....t.jpg",
      "label": "1枚目"
    }
  ]
}
```

### `POST /` （JSON）

```json
{ "url": "https://example.com/flyer.jpg" }
```

または

```json
{ "resolve": "https://chirashi.otoku.aeonsquare.net/viewer/index.html?d=sp&s_id=0000021780&f_id=f176358" }
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
- 応答サイズ上限 約 8MB（画像）／約 2MB（JSON）、タイムアウト約 15 秒
- 画像: `Content-Type: image/*` またはマジックバイトで画像判定
- resolve の JSON 取得は allowlist ホスト＋`/viewer/json/{7桁}.json` のみ
- ブラウザ風 `User-Agent` を付与

## ローカル確認

```bash
npx wrangler dev
curl -i "http://127.0.0.1:8787/?url=https%3A%2F%2Fhttpbin.org%2Fimage%2Fjpeg"
curl -i "http://127.0.0.1:8787/?resolve=https%3A%2F%2Fchirashi.otoku.aeonsquare.net%2Fviewer%2Findex.html%3Fd%3Dsp%26s_id%3D0000021780%26f_id%3Df176358"
```
