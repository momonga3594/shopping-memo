# チラシ画像プロキシ（Cloudflare Worker）

ブラウザから直接取得できない（CORS）チラシ画像URLを、サーバー側で取得して返す小さなプロキシです。  
イオン／ウオロク／クラシル／原信のチラシ**ビューア・店舗URL**から画像一覧を解決するモードもあります。  
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
- ビューア／店舗 resolve: `GET {proxy}/?resolve={encodeURIComponent(viewerUrl)}`  
  （イオン店舗・ビューア / ウオロク店舗チラシ / クラシル / 原信店舗）  
経由で取得します。

## API

### `GET /?url=<image-url>`

成功時: 画像バイト + `Content-Type: image/...` + CORS ヘッダ

### `GET /?resolve=<viewer-url>`

対応 URL を解析し、画像URL一覧を JSON で返します。

| 種別 | 例 |
|------|----|
| イオン ビューア | `https://chirashi.otoku.aeonsquare.net/viewer/index.html?...&s_id=...&f_id=...` |
| イオン店舗ページ | `https://www.aeon.com/store/イオン/イオンとやの店/`（HTML の `data-flyer-id` を店舗IDにし、掲載中のチラシ画像を返す） |
| ウオロク店舗チラシ | `https://www.uoroku.co.jp/shop/flyer/kandoji.html`（ページ内のクラシル iframe を辿る） |
| クラシルウィジェット | `https://chirashi.kurashiru.com/widgets/{uuid}/leaflets` |
| クラシル店舗 | `https://chirashi.kurashiru.com/stores/{uuid}` または `/stores/{uuid}/limit_excursion?...` |
| 原信店舗 | `https://www.harashinnarus.jp/shops/kurosaki/`（ページ内のチラシ JPEG を抽出。`source` は `harashin`） |

成功例（イオン）:

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

成功例（クラシル／ウオロク）:

```json
{
  "source": "kurashiru",
  "title": "秋御膳",
  "shopName": "ウオロク　神道寺店のチラシ情報",
  "images": [
    {
      "url": "https://video.kurashiru.com/production/chirashiru_leaflet/image/3115121/....jpg",
      "thumbUrl": "https://video.kurashiru.com/.../thumbnail_....jpg",
      "label": "秋御膳"
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
- resolve の JSON 取得（イオン）は allowlist ホスト＋`/viewer/json/{7桁}.json` のみ
- resolve の HTML 取得は allowlist のみ: `www.uoroku.co.jp` / `uoroku.co.jp`（`/shop/flyer/`）、`www.aeon.com` / `aeon.com`（`/store/…`）、`www.harashinnarus.jp` / `harashinnarus.jp`（`/shops/{slug}`）、`chirashi.kurashiru.com`（`/widgets/{uuid}/leaflets` または `/stores/{uuid}`）
- クラシル画像は `thumbnail_` / `compressed_` を外したフル JPEG を `url` に、縮小版を `thumbUrl` に載せる
- ブラウザ風 `User-Agent` を付与

## ローカル確認

```bash
npx wrangler dev
curl -i "http://127.0.0.1:8787/?url=https%3A%2F%2Fhttpbin.org%2Fimage%2Fjpeg"
curl -i "http://127.0.0.1:8787/?resolve=https%3A%2F%2Fchirashi.otoku.aeonsquare.net%2Fviewer%2Findex.html%3Fd%3Dsp%26s_id%3D0000021780%26f_id%3Df176358"
curl -i "http://127.0.0.1:8787/?resolve=https%3A%2F%2Fwww.uoroku.co.jp%2Fshop%2Fflyer%2Fkandoji.html"
curl -i "http://127.0.0.1:8787/?resolve=https%3A%2F%2Fwww.harashinnarus.jp%2Fshops%2Fkurosaki%2F"
```
