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

# 🧩 Agents Instructions 構造図

```mermaid
flowchart TD

%% ========== Reply Agent ==========
subgraph Reply_Agent["🟢 Reply Agent（回答生成）"]
    direction TB
    A1["BASE.md\n（文体・安全・禁止事項）"]
    A2["＋ REPLY.md\n（本文生成ルール / URL / フォローアップ）"]
    A3["または instpackFromBinding\n（ユーザ保存ルール）"]
    A1 --> A2
    A2 -->|"bindingあり"| A3

    subgraph Result_R1["出力: ユーザ向け本文"]
        R1["Bing Grounding に基づく短文回答\n＋必要に応じて確認質問1行"]
    end
end

%% ========== Meta Agent ==========
subgraph Meta_Agent["🟡 Meta Agent（構造情報抽出）"]
    direction TB
    B1["BASE.md"]
    B2["＋ META.md\n(intent / slots / complete / followups)"]
    B1 --> B2

    subgraph Result_R2["出力: emit_meta"]
        R2["meta = { intent, slots, complete, followups }"]
    end
end

%% ========== Instpack Agent ==========
subgraph Instpack_Agent["🔵 Instpack Agent（差分ルール生成）"]
    direction TB
    C1["INSTPACK.md\n（差分ロジック指示のみ）"]

    subgraph Result_R3["出力: emit_instpack"]
        R3["instpack = '<保存・再利用する差分指示>'"]
    end
end

%% ========== Flow ==========
Reply_Agent -->|"ユーザ質問\n(reply結果を基に)"| Meta_Agent
Meta_Agent -->|"metaがcomplete\nかつ保存条件を満たす"| Instpack_Agent

style Reply_Agent fill:#e8ffe8,stroke:#00a000,stroke-width:1.5px
style Meta_Agent fill:#fff9d9,stroke:#c0a000,stroke-width:1.5px
style Instpack_Agent fill:#e8f0ff,stroke:#0040a0,stroke-width:1.5px

| Agent | 主な責務 | 使用ファイル |
|--------|-----------|---------------|
| 🟢 Reply Agent | Bing Groundingを利用してユーザー向け本文を生成 | `base.md + reply.md`（または + instpackFromBinding） |
| 🟡 Meta Agent | intent / slots / complete / followups の抽出 | `base.md + meta.md` |
| 🔵 Instpack Agent | 差分ルール（再利用用最終指示）の生成 | `instpack.md` |