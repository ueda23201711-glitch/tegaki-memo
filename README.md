# 手書きメモ

端末どうしで共有できる手書きメモ（PWA）。https://ueda23201711-glitch.github.io/tegaki-memo/

- iPad 2/3（iOS 9）から最新の iPhone・Android・パソコンまで動くよう、古い書き方（ES5）で書いています。
- 同期は Firebase Realtime Database（REST）。合言葉ごとに `memos/<合言葉>` に保存します。
- 以前は `kiku990/memo/` にありました（そちらは自動でここへ移ります）。
- PDF の読み込み（各ページを画像にしてメモの背景に）には pdf.js 3.11.174 legacy build（Apache-2.0, `vendor/pdfjs/`）を使っています。読み込みは新しい端末のみ。
- PDF の書き出しは、各ページを JPEG にして貼った PDF を自前で組み立てています（古い端末でも動きます）。
- 英文リーダーの辞書は EJDict-hand（パブリックドメイン / CC0, `vendor/ejdict/`）。熟語リスト（`vendor/ejdict/phrases.json` の前半）はこのアプリ用に作成したものです。
- 英文の日本語訳は、利用者自身の Google Apps Script（LanguageApp）を JSONP で呼び出します。
