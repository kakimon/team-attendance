# 家族招待の権限設計とテスト方針

## 1. 家族招待（2 人目以降の保護者）

父・母が別々の Google アカウントで、同じ子の出欠を入力できるようにする仕組み。

### 流れ

1. 子どもを登録した保護者（registrant）が「うちの子」画面で **招待リンクを作成**
2. リンク `/invite/<token>` を LINE 等で家族に送る
3. 家族が Google でログインしてリンクを開き、「招待を受け取る」
4. 家族はその子の保護者（`added_via = 'invitation'`）になり、チームにも `member` として参加

### ルール

| ルール | 実装 |
|---|---|
| 招待を作れるのはその子の保護者だけ | `create_guardian_invitation` で `is_guardian` チェック |
| 短期間のみ有効 | 有効期限 24 時間（`expires_at`） |
| 1 回だけ使える | `used_at IS NULL AND revoked_at IS NULL AND expires_at > now()` を条件にした 1 回の UPDATE で消費。同時アクセスでも 1 人しか成功しない |
| 使用後は再利用不可 | `used_at` が入った招待は永久に無効 |
| 取り消し可能 | `revoke_guardian_invitation` |
| トークン漏えい対策 | DB にはハッシュのみ保存。ブラウザは `token_hash` 列を読めない。244bit の乱数 |
| 乱発対策 | 未使用の有効招待は子ども 1 人につき 5 件まで |
| 招待で得られる権限 | **その子 1 人の出欠編集のみ**。admin にはならない（`member` 固定） |
| 招待された家族も招待できる | 保護者になれば同じ権限（祖父母追加など）。Phase 1 で「保護者を外す」機能を検討 |

### 似た名前の扱い（なりすまし対策）

- 子ども登録時に同じ／似た名前があれば **警告のみ**。「家族から招待リンクをもらってください」と案内。
- 「別の子なので登録する」を選んでも **新しい別の子** が作られるだけで、既存の子の編集権限は絶対に付かない。
- 既存の子の編集権限を得る方法は「その子の保護者からの招待」だけ。

### 管理者でも他家庭の子は編集できない

owner/admin も、自分が保護者でない子の出欠は変更不可（テスト済み）。代理入力が必要になったら Phase 1 以降で「管理者代理入力（履歴付き）」を別機能として検討する。

## 2. テスト方針

### DB（RLS / RPC）— 自動テスト

- `tests/db/rls.test.ts`：**PGlite**（プロセス内 Postgres）で本物のマイグレーション SQL を実行し、
  `authenticated` / `anon` ロール＋ `request.jwt.claim.sub` で利用者を切り替えて許可・拒否を検証。
- Docker も Supabase 本番も不要。`npm test` で約 1 秒。
- `tests/db/setup.ts` は Supabase の `auth.users` / `auth.uid()` / ロールの最小スタブ。

| 必須制約 | 主なテスト |
|---|---|
| 1. team_id で分離 | 他チームから teams/players/events が見えない、他チームの予定に回答不可、他チームに子ども登録不可 |
| 2. 登録者が最初の保護者 | `added_via = registrant`、登録者は回答可能 |
| 3. 他家庭の子は編集不可 | RPC が forbidden、admin でも不可、テーブル直接 INSERT/UPDATE/DELETE は permission denied |
| 4. 複数保護者 | 招待受け取り後に 2 人目が回答可能 |
| 5. 招待は短期・1 回のみ | 24h、使用済み・期限切れ・取消・不正トークンを拒否、token_hash 読み取り不可 |
| 6. 似た名前は警告のみ | カナ/空白違いを検出・作成しない、確認後も別の子を作成し既存の子は編集不可 |
| 7. 未回答 ≠ 欠席 | 集計で別カウント、`unanswered` 指定で行削除、status に保存不可 |
| 8. 全テーブル RLS | `pg_class.relrowsecurity` が全 public テーブルで true |
| 9. 管理者は自己申告不可 | join は member 固定、直接 UPDATE 不可、非 owner は付与不可、owner は付与不可、admin 付与後のみ予定作成可 |

### アプリ実データ層の通しテスト（Phase 1）

- `tests/db/flow.test.ts`：`app/repo/supabaseRepo.ts`（本番で使うコード）を、PGlite 上で supabase-js 互換に動く
  `tests/db/pgliteClient.ts` 経由で実行。利用者ごとに `authenticated` ロール＋ `auth.uid()` を切り替える。
  - チーム作成 → 共有 URL（参加前はチーム名だけ見える）→ 参加 → 子ども登録 → 出欠保存/変更/未回答に戻す → 他メンバーから見える
  - **URL を知っているだけの人**：一覧は見えるが、他家庭の子の出欠変更・未回答化・コメント・招待作成・予定作成はすべて拒否。再参加しても member のまま。同名登録は別の子になるだけ
  - 家族招待：受け取った家族が編集可能、同じリンクの再利用は拒否
- `tests/db/normalize.test.ts`：画面側の似た名前判定と SQL の正規化が一致すること
- `tests/unit/app.test.ts`：本番ビルドでデモモードにならないこと、リダイレクト先の検証、LINE 内ブラウザ判定

未カバー：PostgREST / Supabase Auth そのもの（ローカル Supabase 起動後に確認予定）。

### 追加ルール

- **新しいテーブル／RPC を追加したら、許可と拒否の両方のテストを必ず追加する。**
- Phase 1 で Supabase に接続したら、`supabase start`（ローカル）で同じシナリオを supabase-js 経由でも 1 本確認する（PostgREST 経由の権限・列権限の確認）。
- 本番 Supabase に対してテストを流さない。

### フロント

- Phase 0 はモック動作の手動確認（ログイン→一覧→入力→登録の警告→管理画面の拒否）。
- 権限の最終判断は常にサーバー（RPC/RLS）。画面での非表示は使いやすさのためで、セキュリティ境界ではない。
