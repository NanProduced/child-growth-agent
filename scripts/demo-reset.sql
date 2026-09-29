-- 演示数据校正与重置（幂等，可重复执行）
-- 用途：
--   1) 把历史演示数据中不符合五大领域（健康、语言、社会、科学、艺术）的旧标签统一；
--   2) 把「待确认」演示观察恢复为 ai_organized，供反复演示 AI 整理 → 教师确认。
-- 执行位置：项目的 Supabase Postgres（开发库/生产库均可，平台 SQL 通道或 psql 连接串）。
-- 安全约束：只处理 is_demo = true 的合成数据，不删除、不修改任何非演示数据。

begin;

-- 1) AI 草稿领域校正：社会与情感 -> 社会；认知与探究 -> 科学
update observations
set ai_draft = jsonb_set(
      ai_draft,
      '{domain}',
      to_jsonb(case ai_draft->>'domain'
        when '社会与情感' then '社会'
        when '认知与探究' then '科学'
        else ai_draft->>'domain' end)
    ),
    updated_at = now()
where is_demo = true
  and ai_draft->>'domain' in ('社会与情感', '认知与探究');

-- 1) 教师确认稿领域同步校正
update observations
set confirmed_content = jsonb_set(
      confirmed_content,
      '{domain}',
      to_jsonb(case confirmed_content->>'domain'
        when '社会与情感' then '社会'
        when '认知与探究' then '科学'
        else confirmed_content->>'domain' end)
    ),
    updated_at = now()
where is_demo = true
  and confirmed_content->>'domain' in ('社会与情感', '认知与探究');

-- 2) 重置待确认演示观察（朵朵 · 晨间谈话，b2c2…003）：
--    保留原文与 AI 草稿，仅清除确认结果、回到「待确认」状态。
update observations
set status = 'ai_organized',
    agent_context = null,
    confirmed_content = null,
    confirmed_at = null,
    updated_at = now()
where id = 'b2c20000-0000-4000-8000-000000000003'
  and is_demo = true
  and status <> 'ai_organized';

-- 3) 清空演示幼儿的成长档案，让下一次确认重新演示 P1-D 更新链路。
update children
set growth_profile = null,
    updated_at = now()
where is_demo = true;

commit;

-- 4) 演示数据集自检：期望 demo_children >= 3、confirmed >= 1、pending >= 1
select
  (select count(*) from children where is_demo) as demo_children,
  (select count(*) from observations where is_demo and status = 'confirmed') as confirmed_observations,
  (select count(*) from observations where is_demo and status = 'ai_organized') as pending_observations;
