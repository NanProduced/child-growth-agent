-- 扣子编程托管 PostgreSQL 初始化（幂等）
-- 只创建本项目所需表、索引和合成演示数据；不删除数据。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS health_check (
  id serial NOT NULL,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS children (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(50) NOT NULL,
  gender varchar(10) NOT NULL,
  birth_date date NOT NULL,
  class_name varchar(50) NOT NULL DEFAULT '向日葵班',
  avatar_emoji varchar(16),
  note text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS observations (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id varchar(36) NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  observed_at date NOT NULL,
  context varchar(200),
  raw_text text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft',
  agent_context jsonb,
  ai_draft jsonb,
  ai_model varchar(80),
  ai_organized_at timestamptz,
  confirmed_content jsonb,
  confirmed_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS children_class_name_idx ON children(class_name);
CREATE INDEX IF NOT EXISTS children_created_at_idx ON children(created_at);
CREATE INDEX IF NOT EXISTS observations_child_id_idx ON observations(child_id);
CREATE INDEX IF NOT EXISTS observations_status_idx ON observations(status);
CREATE INDEX IF NOT EXISTS observations_created_at_idx ON observations(created_at);
CREATE INDEX IF NOT EXISTS observations_child_observed_idx ON observations(child_id, observed_at);

INSERT INTO children (id, name, gender, birth_date, class_name, avatar_emoji, note, is_demo, created_at)
VALUES
  ('a1c10000-0000-4000-8000-000000000001', '糖糖', '女', '2022-05-18', '向日葵班', '🍬', '慢热细腻，观察力强；由外婆接送，喜欢在娃娃家给"宝宝"讲故事。', true, '2026-09-25T08:00:00+08:00'),
  ('a1c10000-0000-4000-8000-000000000002', '果果', '男', '2022-11-18', '向日葵班', '🍎', '精力充沛，大动作发展快；喜欢车和积木，语言正处于短句快速发展阶段。', true, '2026-09-25T08:00:00+08:00'),
  ('a1c10000-0000-4000-8000-000000000003', '朵朵', '女', '2022-01-18', '向日葵班', '🌸', '乐于助人，是小组里的"小姐姐"；对新事物好奇，总有很多问题。', true, '2026-09-25T08:00:00+08:00'),
  ('a1c10000-0000-4000-8000-000000000004', '乐乐', '男', '2022-03-18', '向日葵班', '🚗', '专注力持续较久，搭积木时能独自玩很久；情绪平稳，规则意识在建立中。', true, '2026-09-25T08:00:00+08:00'),
  ('a1c10000-0000-4000-8000-000000000005', '悠悠', '女', '2023-01-18', '彩虹班', '🎀', '九月刚升入彩虹班，分离焦虑已缓解；喜欢涂鸦和唱歌，节奏感好。', true, '2026-09-25T08:00:00+08:00'),
  ('a1c10000-0000-4000-8000-000000000006', '石头', '男', '2021-09-18', '彩虹班', '🦖', '恐龙知识丰富，常在分享时间做"小讲解员"；正在学习与同伴协商角色。', true, '2026-09-25T08:00:00+08:00')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  gender = EXCLUDED.gender,
  birth_date = EXCLUDED.birth_date,
  class_name = EXCLUDED.class_name,
  avatar_emoji = EXCLUDED.avatar_emoji,
  note = EXCLUDED.note,
  is_demo = EXCLUDED.is_demo
WHERE children.is_demo = true;

INSERT INTO observations (id, child_id, observed_at, context, raw_text, status, ai_draft, ai_model, ai_organized_at, confirmed_content, confirmed_at, is_demo, created_at)
VALUES
  (
    'b2c20000-0000-4000-8000-000000000001',
    'a1c10000-0000-4000-8000-000000000001',
    '2026-09-25',
    '娃娃家游戏（上午区域活动）',
    '今天娃娃家里，糖糖抱着布娃娃，先给它盖好小毯子，然后拿起玩具体温计放在娃娃额头上看了一会儿，转头对我说：「宝宝发烧了，要休息，不能吃冰激凌。」之后她轻轻拍着娃娃的背，小声哼着摇篮曲，持续了大约十分钟。中途小雨想加入，糖糖把第二块小毯子递给她说：「你当姐姐，一起照顾她吧。」',
    'confirmed',
    $$ {"domain":"社会","sub_domain":"同伴交往与关爱","objective_description":"幼儿在角色游戏中表现出照顾他人、理解角色和邀请同伴参与的社会性发展线索。","highlights":["主动为布娃娃盖毯子并用玩具体温计照顾它","用拍背和哼唱摇篮曲表达持续的关心","把第二块小毯子递给同伴并邀请同伴共同游戏"],"support_suggestions":["继续提供角色游戏材料，支持幼儿表达照顾与合作","鼓励幼儿和同伴协商角色与任务","关注她在真实生活中主动关心同伴的时刻"],"highlight_quote":"你当姐姐，一起照顾她吧。"} $$::jsonb,
    'doubao-seed-2-0-lite-260215',
    '2026-09-25T11:00:00+08:00',
    $$ {"domain":"社会","sub_domain":"同伴交往与关爱","objective_description":"幼儿在角色游戏中表现出照顾他人、理解角色和邀请同伴参与的社会性发展线索。","highlights":["主动为布娃娃盖毯子并用玩具体温计照顾它","用拍背和哼唱摇篮曲表达持续的关心","把第二块小毯子递给同伴并邀请同伴共同游戏"],"support_suggestions":["继续提供角色游戏材料，支持幼儿表达照顾与合作","鼓励幼儿和同伴协商角色与任务","关注她在真实生活中主动关心同伴的时刻"],"highlight_quote":"你当姐姐，一起照顾她吧。"} $$::jsonb,
    '2026-09-25T11:05:00+08:00', true, '2026-09-25T11:00:00+08:00'
  ),
  (
    'b2c20000-0000-4000-8000-000000000002',
    'a1c10000-0000-4000-8000-000000000002',
    '2026-09-26',
    '建构区搭桥（下午自由游戏）',
    '果果用长条积木在两把小椅子之间搭「桥」。第一次桥面塌了，他看了看积木，把两把椅子挪近了一点再搭。第二次中间还是往下凹，他跑去找了两块方形积木垫在中间当「桥墩」。第三次放上小车时桥面歪了，他把小车放在正中间，第四次成功后举着小车说：「这次桥不会塌了。」',
    'confirmed',
    $$ {"domain":"科学","sub_domain":"探究与解决问题","objective_description":"幼儿在反复尝试中观察结构变化，主动调整材料和位置，表现出初步的问题解决与探究意识。","highlights":["发现桥面塌下后主动缩短两把椅子的距离","寻找方形积木作为桥墩支撑桥面","根据小车位置调整搭建方法并总结经验"],"support_suggestions":["提供不同长度和形状的积木支持继续搭建","鼓励幼儿说出每次调整的原因","引导幼儿比较不同支撑方式的效果"],"highlight_quote":"这次桥不会塌了。"} $$::jsonb,
    'doubao-seed-2-0-lite-260215',
    '2026-09-26T16:00:00+08:00',
    $$ {"domain":"科学","sub_domain":"探究与解决问题","objective_description":"幼儿在反复尝试中观察结构变化，主动调整材料和位置，表现出初步的问题解决与探究意识。","highlights":["发现桥面塌下后主动缩短两把椅子的距离","寻找方形积木作为桥墩支撑桥面","根据小车位置调整搭建方法并总结经验"],"support_suggestions":["提供不同长度和形状的积木支持继续搭建","鼓励幼儿说出每次调整的原因","引导幼儿比较不同支撑方式的效果"],"highlight_quote":"这次桥不会塌了。"} $$::jsonb,
    '2026-09-26T16:05:00+08:00', true, '2026-09-26T16:00:00+08:00'
  ),
  (
    'b2c20000-0000-4000-8000-000000000003',
    'a1c10000-0000-4000-8000-000000000003',
    '2026-09-27',
    '晨间谈话（户外散步途中）',
    '散步时朵朵蹲在树下捡起一片黄叶，仰头问我：「叶子为什么变黄呀？是它生病了吗？」我没直接回答，她又说：「旁边那棵树还是绿的，是不是那棵树身体好？」回教室路上她一共捡了五种不一样的叶子，说要把它们「排队」贴在窗台上，还提醒同伴「轻一点，叶子会破」。',
    'ai_organized',
    $$ {"domain":"科学","sub_domain":"科学观察与提问","objective_description":"幼儿围绕自然现象主动提问、比较与猜想，反映出科学探究兴趣与持续观察意识。","highlights":["连续提出关于叶片颜色和树木差异的问题","提出叶子可能生病的解释性猜想","收集不同叶子并计划进行排序展示"],"support_suggestions":["在科学角提供放大镜和叶脉观察材料","邀请幼儿分享对叶片变化的猜想","继续关注她是否持续观察植物变化"],"highlight_quote":"旁边那棵树还是绿的，是不是那棵树身体好？"} $$::jsonb,
    'doubao-seed-2-0-lite-260215',
    '2026-09-27T10:00:00+08:00', null, null, true, '2026-09-27T10:00:00+08:00'
  )
ON CONFLICT (id) DO UPDATE SET
  child_id = EXCLUDED.child_id,
  observed_at = EXCLUDED.observed_at,
  context = EXCLUDED.context,
  status = EXCLUDED.status,
  ai_draft = EXCLUDED.ai_draft,
  ai_model = EXCLUDED.ai_model,
  ai_organized_at = EXCLUDED.ai_organized_at,
  confirmed_content = EXCLUDED.confirmed_content,
  confirmed_at = EXCLUDED.confirmed_at,
  is_demo = EXCLUDED.is_demo
WHERE observations.is_demo = true;
