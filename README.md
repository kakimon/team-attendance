# みんなの出欠（team-attendance）

少年野球・サッカーなどのスポーツ、文化系クラブ、習い事、地域活動向けのシンプルな出欠共有アプリ。
「調整さん並みに簡単、でも他の家庭の子は誰も編集できない」。

- 技術：Nuxt 3（静的 SPA）/ TypeScript / Tailwind CSS v4 + daisyUI 5 / Supabase（Auth: Google, Postgres + RLS）
- 公開：GitHub Pages（GitHub Actions でビルド・デプロイ）
- 権限：書き込みはすべてサーバー側（RLS と権限チェック付き RPC）で判定。詳細は [docs/DESIGN.md](docs/DESIGN.md)

## 開発

```
npm install
cp .env.example .env      # Supabase の URL と Publishable key を設定
npm run dev               # http://localhost:3000
NUXT_PUBLIC_DEMO_MODE=true npm run dev   # デモデータで画面確認（開発サーバーのみ）
npm test                  # RLS / RPC の許可・拒否テスト、データ層の通しテスト（PGlite、Docker 不要）
npm run typecheck
npm run generate          # 静的ビルド → .output/public
```

GitHub Pages と同じ配信規則でビルド結果を確認：

```
NUXT_APP_BASE_URL=/team-attendance/ npm run generate
node scripts/pages-preview.mjs /team-attendance/
```

## 運用

- `.github/workflows/deploy-pages.yml`：main への push でテスト → ビルド → GitHub Pages
- `.github/workflows/healthcheck.yml`：1 日 1 回、読み取り専用 RPC `health_check()` で DB の応答を確認（失敗時は Actions が失敗）
- 必要なリポジトリ変数（Actions → Variables）：`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`（公開前提の値。secret / service_role キーは使わない）
- ヘルスチェックは Supabase Free プランの自動停止を完全には防げません

## ドキュメント

- [docs/DESIGN.md](docs/DESIGN.md) — 画面・DB・権限の設計
- [docs/FAMILY_INVITATION_AND_TESTS.md](docs/FAMILY_INVITATION_AND_TESTS.md) — 家族招待の権限設計とテスト方針
