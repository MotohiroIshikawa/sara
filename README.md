# PM2 運用手順（sara-stg / HTTPS:3000）

このリポジトリを **本番モード**（`next build` + `server.mjs`）で PM2 常駐させるためのチートシートです。

- 作業ユーザ: `azureuser`
- 作業ディレクトリ: `/home/azureuser/sara`
- 起動コマンド: `node server.mjs`（PM2 から起動）
- ポート: `3000`（TLS 終端は `server.mjs` で実装）
- 代表ログ: `~/.pm2/logs/sara-stg-out.log`, `~/.pm2/logs/sara-stg-error.log`

> **備考**: systemd 連携による自動起動は `pm2 startup` + `pm2 save` 済みを想定。

---

## 初回
```bash
pm2 start ecosystem.config.cjs
```
> `ecosystem.config.cjs` では `node server.mjs` を **fork/1 インスタンス**で起動する設定になっています。

---

## 一時停止
```bash
pm2 stop sara-stg
```

---

## 再開
```bash
pm2 start sara-stg
# もしくは
pm2 restart sara-stg
```

---

## 設定ごと再読込（ゼロダウンタイム）
```bash
# 例: デプロイ更新時
# git pull
# npm run stg:build
pm2 reload sara-stg
```

---

## 完全に消す（自動復活対象からも外す）
```bash
pm2 delete sara-stg && pm2 save
```

---

## いまの登録を保存（再起動後も復元）
```bash
pm2 save
```

---

## PM2 自体を止める（全部止まる）
```bash
pm2 kill
```

---

## ログ
```bash
# 両面ライブ表示
pm2 logs sara-stg

# 直接ファイルを見る（デフォルト）
tail -f /home/azureuser/.pm2/logs/sara-stg-out.log
tail -f /home/azureuser/.pm2/logs/sara-stg-error.log
```

---

## ヘルスチェック（任意）
```bash
# ポート 3000 で待受中か
ss -tlnp | grep :3000

# HTTPS 応答確認（自己署名等は -k で無視）
curl -vk https://127.0.0.1:3000/
```

---

## 参考（構成メモ）
- `server.mjs` が `https.createServer` で証明書（`./certificates/*.pem`）を読み、Next を `dev:false` で準備して公開。
- `ecosystem.config.cjs` は CommonJS 形式（`"type":"module"` 環境でも PM2 が読めるように）。
- 本番ビルドは `npm run stg:build`（= `next build`）。
