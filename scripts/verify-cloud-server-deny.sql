-- =============================================================
-- みんなの出欠：クラウド開発DBでのサーバー側権限チェック（読み取り専用の結果のみ残す）
--
-- 実行：supabase db query --linked -f scripts/verify-cloud-server-deny.sql
--
-- 安全性：
--   * 全体が1つの DO ブロック。最後に必ず RAISE EXCEPTION で終わるため、
--     途中で作った検証用の子・招待・出欠変更はすべてロールバックされ、DBに何も残らない。
--   * ブラウザと同じ `authenticated` ロール＋利用者ID（JWT claims）に切り替えて RPC を呼ぶ。
--   * 招待トークンは変数内だけで使い、出力しない。
--   * 前提：テストFC に owner(A) と member(B) がいて、チーム外のユーザー(C)が auth.users に1人以上いる。
-- =============================================================
do $$
declare
  team uuid; ev uuid; taro uuid; jiro uuid;
  a uuid; b uuid; c uuid;
  tok text; v jsonb; n int; out text := '';
begin
  -- 準備（postgres として ID だけ取得）
  select id into team from public.teams where name = 'テストFC';
  select user_id into a from public.team_members where team_id = team and role = 'owner';
  select user_id into b from public.team_members where team_id = team and role = 'member' order by joined_at limit 1;
  select u.id into c from auth.users u where not exists (select 1 from public.team_members m where m.team_id = team and m.user_id = u.id) limit 1;
  select id into ev from public.events where team_id = team order by starts_at limit 1;
  select id into taro from public.players where team_id = team order by created_at limit 1;
  if team is null or a is null or b is null or c is null or ev is null or taro is null then
    raise exception 'PRECONDITION_FAILED team=% a=% b=% c=% ev=% taro=%', team is not null, a is not null, b is not null, c is not null, ev is not null, taro is not null;
  end if;

  perform set_config('role', 'authenticated', true);

  -- ---- A: 検証用の子（架空）を登録（ロールバックで消える）
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  v := public.register_player(team, '検証用 じろう', null, true);
  jiro := (v ->> 'player_id')::uuid;
  out := out || E'\n[A] 検証用の子を登録: ' || (v ->> 'status');

  -- ---- B: A の子（招待前）を編集できないこと
  perform set_config('request.jwt.claim.sub', b::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  begin
    perform public.set_attendance(ev, jiro, 'absent', null);
    out := out || E'\n[B] 他家庭の子の出欠変更RPC: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 他家庭の子の出欠変更RPC: 拒否 (' || sqlerrm || ')'; end;
  begin
    perform public.set_attendance(ev, jiro, 'unanswered', null);
    out := out || E'\n[B] 他家庭の子を未回答に戻すRPC: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 他家庭の子を未回答に戻すRPC: 拒否 (' || sqlerrm || ')'; end;
  begin
    update public.attendance set status = 'absent' where player_id = taro;
    out := out || E'\n[B] attendance テーブル直接更新: ★許可されてしまった';
  exception when others then out := out || E'\n[B] attendance テーブル直接更新: 拒否 (' || sqlerrm || ')'; end;
  begin
    insert into public.player_guardians (player_id, team_id, user_id, added_via) values (jiro, team, b, 'registrant');
    out := out || E'\n[B] 保護者リンクの直接追加: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 保護者リンクの直接追加: 拒否 (' || sqlerrm || ')'; end;
  begin
    perform public.create_guardian_invitation(jiro);
    out := out || E'\n[B] 他家庭の子の招待リンク作成: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 他家庭の子の招待リンク作成: 拒否 (' || sqlerrm || ')'; end;
  begin
    perform public.set_member_role(team, b, 'admin');
    out := out || E'\n[B] 自分を管理者にする: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 自分を管理者にする: 拒否 (' || sqlerrm || ')'; end;
  begin
    perform public.create_event(team, 'x', now());
    out := out || E'\n[B] 予定の作成（メンバー）: ★許可されてしまった';
  exception when others then out := out || E'\n[B] 予定の作成（メンバー）: 拒否 (' || sqlerrm || ')'; end;

  -- ---- C: チーム外の人は見えず、編集もできないこと
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  select count(*) into n from public.players where team_id = team;
  out := out || E'\n[C] チーム外から見える子どもの数: ' || n || case when n = 0 then '（見えない）' else ' ★見えてしまった' end;
  begin
    perform public.set_attendance(ev, taro, 'absent', null);
    out := out || E'\n[C] チーム外から出欠変更RPC: ★許可されてしまった';
  exception when others then out := out || E'\n[C] チーム外から出欠変更RPC: 拒否 (' || sqlerrm || ')'; end;

  -- ---- 家族招待：A が作成 → B が受け取る → C の再利用は拒否
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  v := public.create_guardian_invitation(jiro);
  tok := v ->> 'token';  -- never printed
  out := out || E'\n[A] 招待リンク作成: OK（有効期限まで約 '
    || round(extract(epoch from ((v ->> 'expires_at')::timestamptz - now())) / 3600) || ' 時間）';

  perform set_config('request.jwt.claim.sub', b::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  v := public.accept_guardian_invitation(tok, 'test2');
  out := out || E'\n[B] 招待を受け取る: OK';
  begin
    perform public.set_attendance(ev, jiro, 'attend', null);
    out := out || E'\n[B] 招待後の出欠変更: OK（編集できる）';
  exception when others then out := out || E'\n[B] 招待後の出欠変更: ★拒否された (' || sqlerrm || ')'; end;

  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  begin
    perform public.accept_guardian_invitation(tok, 'x');
    out := out || E'\n[C] 使用済み招待リンクの再利用: ★受け取れてしまった';
  exception when others then out := out || E'\n[C] 使用済み招待リンクの再利用: 拒否 (' || sqlerrm || ')'; end;
  begin
    perform public.accept_guardian_invitation(repeat('0', 64), 'x');
    out := out || E'\n[C] でたらめな招待トークン: ★受け取れてしまった';
  exception when others then out := out || E'\n[C] でたらめな招待トークン: 拒否 (' || sqlerrm || ')'; end;

  -- 必ずロールバックさせる（上の検証用データはすべて消える）
  raise exception 'VERIFY_RESULT（全てロールバック済み）%', out;
end
$$;
