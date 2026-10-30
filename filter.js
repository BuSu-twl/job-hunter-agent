// ============ 自动筛选 / 推荐引擎（filter.js） ============
// 能力：
//   1) 偏好配置：从 data/短期记忆/preferences.json 读写；首次缺失时基于历史投递记录推断默认值。
//   2) 打分：scoreJob(job, prefs) -> { pass, score, reasons, flags }，命中黑名单/风险词/排除岗位/薪资/城市则硬性淘汰。
//   3) 写入推荐名单：applyFilterToState(state, prefs) 把通过筛选的岗位自动加入 state.recommendedJobs（待投递名单），
//      未通过的记入 state.filterRejected 供用户复查，不静默丢弃。
// 安全：只做“筛选 + 生成名单”，不触碰任何投递动作；投递由 server 的确认接口单独执行。
const fs = require("fs");
const path = require("path");

const dataRoot = path.resolve(process.env.CAREER_DATA_DIR || path.join(__dirname, "data"));
const PREFS_PATH = path.join(dataRoot, "短期记忆", "preferences.json");

// 风险/不合适岗位的常见词（疑似诈骗、灰产、明显不匹配）。用户可在配置里增删。
const DEFAULT_EXCLUDE_KEYWORDS = [
  "培训贷", "套路贷", "押金", "保证金", "先交钱", "入职前缴费", "刷单", "返利",
  "博彩", "彩票", "微商", "直销", "保险代理", "无责高薪", "轻松日结", "在家兼职",
  "手工活", "打字员", "陪玩", "夜场", "KTV", "商务伴游"
];

const DEFAULT_PREFERENCES = {
  version: 1,
  cities: [],            // 期望城市；空 = 不限
  onlyListedCities: false, // true=只接受 listed 城市；false=地点缺失时不因城市淘汰
  rolesInclude: [],      // 岗位关键词（命中加分）
  rolesExclude: [],      // 岗位排除词（命中淘汰）
  minSalaryK: 0,         // 月薪下限（千元），0 = 不限
  companyBlacklist: [],  // 公司/关键词黑名单（命中淘汰）
  companyWhitelist: [],  // 白名单（命中直接通过并加权）
  excludeKeywords: DEFAULT_EXCLUDE_KEYWORDS,
  channelsPriority: { "邮箱": 1, "BOSS直聘": 2, "智联招聘": 1, "智联校园": 1, "官网": 2, "校招网申": 2, "Nowclaw": 1, "LinkedIn": 2, "双选会": 2 },
  minScore: 50,          // 通过阈值
  dailyLimit: 15,        // 确认后每日自动投递上限（保护账号，防被识别为机器人）
  autoSubmit: false,     // 确认后是否真代点提交（默认关，需显式开启；当前无浏览器自动化引擎，开启后仍需手动完成最终提交）
  updatedAt: ""
};

// 常见城市/地区词典（仅用于偏好推断时过滤噪声；不在词典内则不作为城市种子）
const CITY_SET = new Set([
  "北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "武汉", "西安", "苏州", "天津", "重庆", "青岛", "宁波", "东莞", "无锡", "佛山", "合肥", "长沙", "郑州", "福州", "济南", "南昌", "昆明", "厦门", "哈尔滨", "沈阳", "大连", "珠海", "常州", "南通", "温州", "泉州", "绍兴", "嘉兴", "中山", "惠州", "保定", "石家庄", "太原", "兰州", "贵阳", "南宁", "海口", "三亚", "烟台", "潍坊", "洛阳", "徐州", "常州", "金华东阳", "义乌", "昆山", "常熟", "张家港", "太仓", "远程", "全国", "多地", "海外"
]);

// ---------- 偏好读写 ----------
function readPreferences() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    // 合并默认值，保证缺字段时不会崩溃
    return { ...DEFAULT_PREFERENCES, ...raw, excludeKeywords: raw.excludeKeywords && raw.excludeKeywords.length ? raw.excludeKeywords : DEFAULT_EXCLUDE_KEYWORDS };
  } catch {
    return null;
  }
}
function writePreferences(prefs) {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  const backup = `${PREFS_PATH}.bak`;
  if (fs.existsSync(PREFS_PATH)) try { fs.copyFileSync(PREFS_PATH, backup); } catch {}
  const out = { ...DEFAULT_PREFERENCES, ...prefs, updatedAt: new Date().toISOString().slice(0, 19) };
  fs.writeFileSync(PREFS_PATH, JSON.stringify(out, null, 2), "utf8");
  return out;
}
// 首次缺失时，从已有投递记录推断默认偏好（仅作起点，用户需校正）
function inferPreferences(state) {
  const jobs = (state && state.jobs) || [];
  const positive = jobs.filter((j) => ["已投递", "沟通中", "一面", "二面", "HR面", "Offer", "已签约"].includes(j.status));
  const splitTokens = (s) => String(s || "").split(/[、,，/\\|·•・]/).map((t) => t.trim()).filter(Boolean);
  const cityCount = {};
  const roleCount = {};
  for (const j of positive) {
    // 城市：仅接受命中城市词典、且为纯中文短串（过滤酒店/会场/地址噪声）
    for (const c of splitTokens(j.location)) {
      const clean = c.replace(/[（(].*$/, "").trim();
      if (CITY_SET.has(clean)) cityCount[clean] = (cityCount[clean] || 0) + 1;
    }
    for (const r of splitTokens(j.role)) {
      // 过滤岗位代码（纯字母数字、含数字短串如 J12457、JD123）与过长/过短噪声
      if (r.length < 2 || r.length > 12) continue;
      if (/^[A-Za-z0-9\-]+$/.test(r)) continue;          // 纯字母数字=代码，跳过
      if (/[0-9]/.test(r) && r.length <= 6) continue;     // 含数字且短=编号，跳过
      roleCount[r] = (roleCount[r] || 0) + 1;
    }
  }
  const cities = Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
  const rolesInclude = Object.entries(roleCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r]) => r);
  const prefs = { ...DEFAULT_PREFERENCES, cities, rolesInclude, updatedAt: new Date().toISOString().slice(0, 19) };
  return prefs;
}
// 读取偏好：存在则用之；不存在则推断并落盘（便于用户直接打开修改）
function ensurePreferences(state) {
  const existing = readPreferences();
  if (existing) return existing;
  const inferred = inferPreferences(state || {});
  writePreferences(inferred);
  return inferred;
}

// ---------- 工具 ----------
function normStr(v) { return String(v || "").toLowerCase(); }
function containsAny(haystack, needles) {
  const h = normStr(haystack);
  return needles.filter((n) => n && normStr(n) && h.includes(normStr(n)));
}
function parseSalaryK(text) {
  const s = String(text || "");
  // 匹配「数字 + 万/k/K/千」或「数字-数字k」
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:[万wWkK]|千)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (/万|w|W/.test(m[0])) v = v * 10; // 万/月 ≈ 10k
  return v;
}
function cityMatch(location, cities) {
  if (!cities || !cities.length) return false;
  const loc = normStr(location);
  return cities.some((c) => c && normStr(c) && loc.includes(normStr(c)));
}

// ---------- 打分 ----------
// job 字段：{ company, role, location, channel, status, salary, note, summary, link, applyUrl, labels }
function scoreJob(job, prefs) {
  prefs = prefs || DEFAULT_PREFERENCES;
  const reasons = [];
  const flags = [];
  const blob = [job.company, job.role, job.location, job.note, job.summary, (job.labels || []).join(" ")].join(" ");

  // 1) 风险词硬淘汰
  const risk = containsAny(blob, prefs.excludeKeywords || []);
  if (risk.length) return { pass: false, score: 0, reasons: [`命中风险/不合适词「${risk.join("、")}」，已排除`], flags: risk.map((r) => `风险词:${r}`) };

  // 2) 公司黑名单硬淘汰
  const black = containsAny(job.company, prefs.companyBlacklist || []);
  if (black.length) return { pass: false, score: 0, reasons: [`命中黑名单公司「${black.join("、")}」，已排除`], flags: black.map((b) => `黑名单:${b}`) };

  // 3) 岗位排除词硬淘汰
  const exRole = containsAny(job.role, prefs.rolesExclude || []);
  if (exRole.length) return { pass: false, score: 0, reasons: [`岗位命中排除词「${exRole.join("、")}」，已排除`], flags: exRole.map((e) => `排除岗位:${e}`) };

  // 4) 薪资下限
  if (prefs.minSalaryK && prefs.minSalaryK > 0) {
    const sal = parseSalaryK(blob);
    if (sal !== null && sal < prefs.minSalaryK) {
      return { pass: false, score: 0, reasons: [`薪资约 ${sal}k，低于下限 ${prefs.minSalaryK}k`], flags: [`薪资不足:${sal}k`] };
    }
  }

  // 5) 城市（仅当开启 onlyListedCities 且地点已知时硬淘汰）
  if (prefs.onlyListedCities && (prefs.cities || []).length && job.location && !cityMatch(job.location, prefs.cities)) {
    return { pass: false, score: 0, reasons: [`地点「${job.location}」不在期望城市 ${prefs.cities.join("/")}`], flags: ["城市不符"] };
  }

  // ---- 通过硬门槛，开始加分 ----
  let score = 50;
  reasons.push("通过基础门槛");

  const inc = containsAny(job.role, prefs.rolesInclude || []);
  if (inc.length) { score += Math.min(30, inc.length * 15); reasons.push(`岗位匹配关键词「${inc.join("、")}」+${Math.min(30, inc.length * 15)}`); }

  const white = containsAny(job.company, prefs.companyWhitelist || []);
  if (white.length) { score += 25; reasons.push(`白名单公司「${white.join("、")}」+25`); }

  const chPri = (prefs.channelsPriority || {})[job.channel] || 0;
  if (chPri) { const add = Math.min(10, chPri * 3); score += add; reasons.push(`渠道 ${job.channel} +${add}`); }

  if (job.link || job.applyUrl) { score += 5; reasons.push("有投递链接 +5"); }

  if ((prefs.cities || []).length && job.location && cityMatch(job.location, prefs.cities)) { score += 10; reasons.push("地点符合期望 +10"); }
  else if ((prefs.cities || []).length && job.location) { score -= 5; reasons.push("地点未匹配期望城市 -5"); }

  const FLOW = ["待确认", "已投递", "沟通中", "测评", "笔试", "一面", "二面", "HR面"];
  if (FLOW.includes(job.status)) { score += 10; reasons.push("已在流程中 +10"); }

  score = Math.round(score);
  const pass = score >= (prefs.minScore || 50);
  if (!pass) reasons.push(`总分 ${score} 低于通过阈值 ${prefs.minScore || 50}`);
  return { pass, score, reasons, flags };
}

// ---------- 写入推荐名单 ----------
const CLOSED = ["已淘汰", "已拒绝", "流程结束", "已签约"];
const ENGAGED = ["已投递", "沟通中", "一面", "二面", "HR面", "Offer", "已签约"];
function normKey(company, role) {
  return `${String(company || "").trim().toLowerCase()}|${String(role || "").trim().toLowerCase()}`;
}
function applyFilterToState(state, prefs, { dryRun = false } = {}) {
  const jobs = state.jobs || [];
  const recs = state.recommendedJobs || (state.recommendedJobs = []);
  const rejected = state.filterRejected || (state.filterRejected = []);
  const existingKeys = new Map(recs.map((r) => [normKey(r.company, r.role), r]));
  const added = [];
  const updated = [];
  const rejectedNow = [];

  for (const job of jobs) {
    if (job.duplicateOf) continue;
    if (CLOSED.includes(job.status)) continue;
    if (ENGAGED.includes(job.status)) continue; // 已进入投递/沟通阶段，不再作为“待投递”
    const key = normKey(job.company, job.role);
    const result = scoreJob(job, prefs);
    if (result.pass) {
      const rec = existingKeys.get(key);
      const payload = {
        id: rec ? rec.id : `REC-${Date.now()}-${Math.abs(hashKey(key))}`,
        company: job.company, role: job.role, location: job.location || "",
        source: job.channel || "", link: job.link || job.applyUrl || "",
        reason: result.reasons.join("；"), score: result.score,
        applyStatus: rec ? (rec.applyStatus || "未投递") : "未投递",
        jobId: job.id || "", addedAt: new Date().toISOString().slice(0, 10)
      };
      if (rec) { Object.assign(rec, payload); updated.push(payload.id); }
      else { recs.unshift(payload); added.push(payload.id); existingKeys.set(key, payload); }
    } else {
      rejectedNow.push({ company: job.company, role: job.role, location: job.location || "", reason: result.reasons.join("；"), flags: result.flags, at: new Date().toISOString().slice(0, 19) });
    }
  }
  // 未通过的记录保留最近 100 条供复查
  state.filterRejected = [...rejectedNow, ...rejected].slice(0, 100);

  const report = {
    dryRun,
    total: jobs.length,
    recommended: recs.filter((r) => r.applyStatus !== "已投递").length,
    added: added.length,
    updated: updated.length,
    rejected: rejectedNow.length
  };
  if (!dryRun) {
    // 推荐名单持久化由调用方（organize/server）统一写盘
  }
  return report;
}
function hashKey(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// 确认投递时，确保主表存在对应岗位管线记录（status=已投递，标签“自动投递”）
function ensurePipelineJob(state, rec, { autoSubmit = false } = {}) {
  const jobs = state.jobs || (state.jobs = []);
  const key = normKey(rec.company, rec.role);
  let job = jobs.find((j) => !j.duplicateOf && normKey(j.company, j.role) === key);
  if (!job) {
    job = {
      id: `JOB-AUTO-${Date.now()}`,
      company: rec.company, role: rec.role, channel: rec.source || "自动投递",
      location: rec.location || "", status: "已投递", priority: "中",
      submitted: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
      next: "等待平台反馈（自动投递）", attachments: [],
      labels: ["自动投递"]
    };
    jobs.unshift(job);
  } else {
    job.status = "已投递";
    job.updated = new Date().toISOString().slice(0, 10);
    job.labels = Array.from(new Set([...(job.labels || []), "自动投递"]));
  }
  rec.applyStatus = "已投递";
  rec.appliedAt = new Date().toISOString().slice(0, 19);
  rec.autoSubmitted = Boolean(autoSubmit);
  (state.events || (state.events = [])).unshift({
    date: new Date().toISOString().slice(0, 10), type: "自动投递",
    title: `自动投递：${rec.company}·${rec.role}`,
    detail: autoSubmit ? "已按白名单/开关尝试代提交，请在平台确认最终状态" : "已标记投递并写入管线，请在打开的页面完成最终提交",
    jobId: job.id, material: "自动投递", source: "auto-apply"
  });
  return job;
}

module.exports = {
  DEFAULT_PREFERENCES, DEFAULT_EXCLUDE_KEYWORDS,
  readPreferences, writePreferences, inferPreferences, ensurePreferences,
  scoreJob, applyFilterToState, ensurePipelineJob, parseSalaryK, cityMatch, normKey
};
