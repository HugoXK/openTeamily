"""Work-context onboarding (industry and role).

Self-written for OpenTeamily; no upstream or Teamily prompt source. The 2026-11-18
real-account walk captured the four onboarding steps (work context, app
connectors, automation picks, Personal Agent look). This slice implements only
the captured work-context step and stores it for later recommendations.
Connectors are intentionally out of scope (Birfy/Bot Social territory); the
automation and avatar steps remain pending.
"""
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_onboarding (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 industry TEXT NOT NULL,
 role TEXT NOT NULL,
 completed INTEGER NOT NULL CHECK(completed IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
'''

INDUSTRIES = {
    '科技与软件': ['软件工程师', '产品经理', 'AI 工程师', '数据分析师 / 工程师', '产品设计师', '创始人 / CEO', 'QA / 测试工程师', '安全工程师', '学生', '其他'],
    '广告与营销': ['增长营销师', '内容创作者', '文案', 'SEO 专员', '品牌策略师', '平面设计师', '公关专员', '市场分析师', '活动策划', '代理公司老板', '学生'],
    '媒体与娱乐': ['内容创作者', '主播', '设计师', '音乐人', '艺术家', '作家', '学生', '内容制作', '记者', '编辑'],
    '金融服务': ['财务分析师', '投资分析师', '会计师', '财务顾问', '风险与合规分析师', '产品经理', '交易员', '保险代理人'],
    '教育': ['老师', '大学教授', '研究员', '学生', '学校辅导员', '学校管理者', '学术顾问', '教学设计师', '教育机构创办人', '教育顾问', '项目协调员'],
    '电子商务与零售': ['店主', '电商运营', '增长营销师', '买手', '商品企划', '产品经理', '供应链分析师', '数据分析师'],
    '咨询与专业服务': ['管理顾问', '战略顾问', '业务分析师', '科技顾问', '运营顾问', '项目经理', '客户服务专员', '法律专业人士'],
    '游戏': ['电竞选手', '游戏制作人', '主播', '内容创作者', '游戏设计师', '动画师', '独立开发者', 'QA 测试员'],
    '旅游与酒店': ['旅行顾问', '活动统筹', '营收分析师', '宾客体验专员', '市场专员', '餐饮专员', '旅游业经营者', '酒店专业人士'],
    '医疗健康': ['医生', '护士', '心理学家', '医学生', '药剂师', '治疗师', '牙医', '放射科医生', '营养师', '照护者', '医学检验科学家'],
    '时尚与服装': ['时装设计师', '商品企划', '买手', '产品开发', '精品店店主', '市场专员'],
    '房地产与租赁': ['房产经纪人', '物业经理', '评估师', '房贷经纪人', '房产投资人', '房产营销师'],
    '农业与种养': ['农夫', '牧场主', '农场经理', '农业工人', '农场主'],
    '运输与物流': ['个体司机 / 司机', '车队经理', '仓库经理', '物流协调员', '供应链分析师', '运输规划师', '货运经纪人', '运输业经营者'],
    '建筑与家居服务': ['总承包商', '技工', '家庭服务专业人员', '建筑项目经理', '建筑师', '建筑 / 家居服务业经营者', '机械 / 电气工程师'],
    '其他': []
}

OTHER = '其他'
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
ROLE_MAX = 40


def valid_industry(value):
    return value == '' or (isinstance(value, str) and len(value.strip()) <= 40
                           and not CONTROL.search(value))


def valid_role(value):
    return value == '' or (isinstance(value, str) and len(value.strip()) <= ROLE_MAX
                           and not CONTROL.search(value))


def view(row):
    return {
        'industry': row['industry'],
        'role': row['role'],
        'completed': bool(row['completed']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


def industries_view():
    return [{'name': name, 'roles': list(roles)} for name, roles in INDUSTRIES.items()]


def load(db, user_id):
    return db.execute('SELECT * FROM user_onboarding WHERE user_id=?', (user_id,)).fetchone()
