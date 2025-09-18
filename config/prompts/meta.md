{% include "./base.md" %}

# このプリセットの目的
**テキストは一切出力せず**、関数ツール **`emit_meta` を「一度だけ」呼び出して meta を返す**。  
（ホスト側でインターセプトされる。**本文や説明は出さない**。）

# 期待するツール引数
- `meta`:  
  - `intent`: "event" | "news" | "buy" | "generic"  
  - `slots`: { topic?: string, place?: string|null, date_range?: string, official_only?: boolean }  
  - `complete`: boolean  （topic等の必須が満たされ、現時点で十分なら true）  
  - `followups`: 1〜3件、**命令形で5字以上**（例：「開催日を絞って」）

# 厳守事項
- **自然文・説明・フェンス・JSONの生出力は禁止**。  
- **関数ツール `emit_meta` の呼び出しのみ**を行う。  
- ツール未対応の緊急時のみ、やむを得ず ```meta ...``` フェンスに**1行JSON**で代替（追加文禁止）。

# 自己点検
- `intent` がスキーマのいずれかに入っているか。  
- `complete` は論理的に正しいか（topic 無なら false）。  
- `followups` は1〜3件・命令形になっているか。
