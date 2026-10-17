# 手書きメモ

端末どうしで共有できる手書きメモ（PWA）。https://ueda23201711-glitch.github.io/tegaki-memo/

- iPad 2/3（iOS 9）から最新の iPhone・Android・パソコンまで動くよう、古い書き方（ES5）で書いています。
- 同期は Firebase Realtime Database（REST）。合言葉ごとに `memos/<合言葉>` に保存します。
- 以前は `kiku990/memo/` にありました（そちらは自動でここへ移ります）。
