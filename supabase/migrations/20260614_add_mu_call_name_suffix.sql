-- Mu がユーザーを呼ぶ名前・敬称設定
-- user_call_name は既存利用中のため、敬称関連だけを追加する。

alter table public.iros_user_profile
  add column if not exists user_call_suffix text;

alter table public.iros_user_profile
  add column if not exists user_call_suffix_text text;

alter table public.iros_user_profile
  add column if not exists user_call_name_source text;

alter table public.iros_user_profile
  add column if not exists user_call_name_confirmed_at timestamptz;

comment on column public.iros_user_profile.user_call_suffix is
  'Mu が呼ぶ敬称。san / chan / kun / sama / none / custom';

comment on column public.iros_user_profile.user_call_suffix_text is
  'user_call_suffix=custom のときに使う自由入力敬称';

comment on column public.iros_user_profile.user_call_name_source is
  '呼び名の登録元。profile_edit / first_screenshot_detected など';

comment on column public.iros_user_profile.user_call_name_confirmed_at is
  '初回診断などでユーザーが呼び名を確認した日時';
