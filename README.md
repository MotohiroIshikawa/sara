## Getting Started
1. LINE Developersにアカウントを作成し、プロバイダーとチャネルを作成する
- MessagingAPIのチャネルよりチャネルアクセストークンとチャネルシークレットを取得
- LINEログインのチャネルにてLIFFアプリを作成し、LIFF IDを取得

2. プロジェクトフォルダ(sara)直下に.envファイルを作成する
```
LINE_CHANNEL_ACCESS_TOKEN='xxxxxxxx'
# チャネルアクセストークンを記載
LINE_CHANNEL_SECRET='xxxxxxxx'
# チャネルシークレットを記載
NEXT_PUBLIC_LIFF_ID_FULL='xxxxxxxx'
# LIFF IDを記載
```
3. プロジェクトフォルダ(sara)直下にcertificateフォルダを作成し、証明書を導入する
- messagingAPIのエンドポイントにはhttpsで接続できることが必須なため
- 証明書は中間証明書とサーバ証明書を連結する
- packages.jsonを編集する
```bash
  "scripts": {
    "dev": "next dev --turbopack",
    "stg": "next dev --experimental-https --experimental-https-key ./certificates/<秘密鍵ファイル名> --experimental-https-cert ./certificates/<中間証明書とサーバ証明書を連結したファイル名>",
```

4. サーバを起動する
```bash
npm install
npm run dev
# HTTPSでのアクセス用途 (オレオレ認証)
# https://localhost:3000
npm run stg
# HTTPSでのアクセス用途
# https://your.domain:3000
```
- LINE messagingApiのエンドポイント
[https://localhost:3000/linebot](http://localhost:3000/linebot)
- Endpoint of LIFF (FULL)
[https://localhost:3000/liff](http://localhost:3000/liff)

5. LINE Developersにエンドポイントを設定する
- LINE DevelopersのMessagingAPIチャネル->MessagingAPI設定->Webhook設定
- 「検証」で成功すること
- 失敗する場合はブラウザ等で https://your.domain:3000/linebot にアクセスする