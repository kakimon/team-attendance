# みんなの出欠 — MVP 設計（Phase 1 更新）

コンセプト：**調整さん並みに簡単に出欠を入れられる。でも、他の家庭の子は誰も編集できない。**

対象：少年野球・サッカーなどのスポーツ、文化系クラブ、習い事、地域活動。

## 1. 基本方針

| 項目 | 方針 |
|---|---|
| 入口 | チームごとに 1 つの共有 URL `/t/<share_token>`（LINE グループ等で共有） |
| ログイン | Supabase Auth + Google。セッションは localStorage に保持（通常はログインしたまま） |
| 子ども登録 | 保護者が自分で登録。家族コード・管理者承認なし |
| 編集権限 | 子どもを登録した保護者＋その保護者が招待した家族だけ |
| 管理者 | チーム作成者が owner。admin は owner が付与。自己申告では不可 |
| 初版でやらない | LINE bot、課金、複雑な端末管理 |

## 2. 画面一覧

| パス | 画面 | 誰が使う |
|---|---|---|
| `/` | ログイン（Google）／参加チーム一覧。LINE 内ブラウザなら「ブラウザで開く」案内 | 全員 |
| `/auth/callback` | OAuth コールバック（PKCE） | 全員 |
| `/teams/new` | **チーム作成**＋共有 URL 発行 | 代表者 |
| `/t/[token]` | 未参加なら「参加する」（チーム名のみ表示）／参加済みなら**出欠一覧**（予定ごと／一覧表） | チームメンバー |
| `/t/[token]/answer` | **出欠入力**（うちの子だけ。出席/欠席/未定、再タップで未回答） | 保護者 |
| `/t/[token]/children` | うちの子一覧 | 保護者 |
| `/t/[token]/children/[playerId]` | **家族招待**（招待リンク作成・コピー・共有） | その子の保護者 |
| `/t/[token]/children/new` | **子ども登録**（似た名前は警告） | 保護者 |
| `/t/[token]/admin` | 予定作成・出欠集計・共有 URL | owner / admin |
| `/invite/[token]` | 家族招待の受け取り | 招待された家族 |

メンバー権限変更画面は未実装（RPC `set_member_role` はあり）。

## 3. DB 設計

すべてのテーブルに `team_id` を持たせ（直接 or 複合 FK）、チーム間でデータが混ざらないようにする。

```
teams ─┬─ team_members (team_id, user_id, role: owner|admin|member)
       ├─ players (id, team_id, name, normalized_name, note)
       │     ├─ player_guardians (player_id, team_id, user_id, added_via: registrant|invitation)
       │     └─ guardian_invitations (player_id, team_id, token_hash, expires_at, used_at, revoked_at)
       └─ events (id, team_id, title, starts_at, location, note)
             └─ attendance (event_id, player_id, team_id, status: attend|absent|undecided, comment)
```

- `attendance` の `(event_id, team_id)` と `(player_id, team_id)` は複合 FK。別チームの予定と子どもを組み合わせられない。
- **未回答 = attendance 行が無い状態**。`status` に `unanswered` は保存できない（CHECK 制約）。欠席とは別物。
- `normalized_name`：NFKC・小文字・空白除去・カタカナ→ひらがな。似た名前の判定に使う。
- 招待トークンは SHA-256 ハッシュのみ保存。ブラウザから `token_hash` 列は SELECT 不可。

### 書き込み経路（すべて SECURITY DEFINER RPC、明示チェックあり）

| RPC | 誰が | チェック |
|---|---|---|
| `create_team(name, display_name)` | ログインユーザー | 作成者を owner にする（新チームのみ） |
| `get_team_by_share_token(share_token)` | ログインユーザー | チーム名と自分の参加状況のみ返す（参加前のプレビュー） |
| `join_team(share_token, display_name)` | ログインユーザー | 常に `member`。既存ロールは変更しない |
| `set_member_role(team, user, role)` | owner のみ | `admin`/`member` のみ。owner は付与不可 |
| `find_similar_players(team, name)` | メンバー | 読み取りのみ |
| `register_player(team, name, note, confirm_similar)` | メンバー | 似た名前があれば作成せず候補を返す。確認後も **新しい別の子** を作るだけ |
| `create_event(team, …)` | owner/admin | |
| `set_attendance(event, player, status, comment)` | その子の保護者のみ | 同一チーム確認。`unanswered` は行削除 |
| `event_attendance_summary(event)` | メンバー | 未回答を別カウント |
| `health_check()` | **anon 可**（死活監視用） | SECURITY INVOKER。テーブルの行を読まず、スキーマの存在と DB 時刻だけ返す。書き込みなし（`20261109000000_health_check.sql`、未適用） |
| `create_guardian_invitation(player)` | その子の保護者 | 24 時間・未使用の有効招待は 1 人 5 件まで |
| `revoke_guardian_invitation(id)` | その子の保護者 | |
| `accept_guardian_invitation(token, display_name)` | ログインユーザー | 1 回の UPDATE で消費（使用済・期限切れ・取消は不可） |

### RLS（読み取り）

| テーブル | SELECT できる人 |
|---|---|
| teams / team_members / players / events / attendance | 同じチームのメンバー |
| player_guardians | 自分の行、またはチームの owner/admin |
| guardian_invitations | その子の保護者（`token_hash` 列は除外） |

ブラウザロール（anon / authenticated）に INSERT / UPDATE / DELETE 権限は一切与えない。anon は何も読めない。

## 4. フロント構成

- Nuxt 3（SPA, `ssr: false`）／TypeScript／Tailwind CSS v4 + daisyUI 5
- `app/plugins/data.client.ts`：起動モードを決めて `Repo` を 1 つ用意
- `app/repo/supabaseRepo.ts`：**実データ層**。読み取り＝テーブル SELECT（RLS で絞り込み）、書き込み＝RPC のみ
- `app/repo/mockRepo.ts` / `mockData.ts`：デモ専用（開発サーバーでのみ動的 import）
- `app/composables/useAuth.ts`：Google ログイン（PKCE・セッション保持）／ログアウト
- `app/components/TeamShell.vue`：チーム画面共通（読込・未参加なら参加フォーム・ナビ）

### 起動モード（`app/utils/appMode.ts`）

| 条件 | モード |
|---|---|
| `nuxt dev` かつ `NUXT_PUBLIC_DEMO_MODE=true` | demo（上部に「デモモード」帯） |
| Supabase URL と anon key がある | supabase |
| それ以外 | misconfigured（設定エラー画面。**デモにはならない**） |

本番ビルド（`npm run generate`）はデモフラグを無視し、デモ用コード・データはバンドルに含まれない（確認済み）。

## 5. UI デザイン（2026-11 刷新）

- スマホファースト。ブルー→パープルのグラデーション（`bg-brand` / `btn-brand`）、オフホワイト背景（`base-200 #f6f7fb`）、角丸カード（`rounded-box` 1.25rem）と控えめな影（`shadow-soft`）
- daisyUI カスタムテーマ `minna`（`app/assets/css/main.css`）。フォントは Hiragino / Noto Sans JP 系のシステムフォント
- アイコンは Lucide（人物・カレンダー・チェックなど汎用のもののみ）。**特定の競技を連想させる絵柄は使わない**
- ナビゲーション：スマホは画面下部のタブバー、PC（md 以上）はヘッダー内のタブ。管理タブは owner/admin のみ
- 共通コンポーネント（`app/components/ui/`）：`AppHeader` `AppCard` `TeamAvatar` `StatusPill` `StatusPicker` `SummaryBar` `EmptyState` `CopyField` `FormField` `StatusMark`
- チーム画面共通：`TeamShell`（読込・参加・ヘッダー・タブ）、`TeamTabs`、`EventInfo` / `EventDate`
