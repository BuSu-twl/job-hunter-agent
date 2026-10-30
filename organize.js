// ============ 自动整理模块（organize.js） ============
// 能力：1) 存量记录自动核对修正（去重合并、状态/标签统一、双标规范、占位岗位名修正）
//       2) 新邮件自动建档归类（替代手动“写入流程”）
//       3) 自动状态流转（超 20 天无进展自动标“已淘汰”，改动前自动备份）
//       4) 自动汇总统计（写入 state.summary，供前端展示）
// 安全：每次实际改动前自动备份 state.json；提供 dryRun 模式先行预览。
const fs = require("fs");
const path = require("path");
const filter = require("./filter");

const STATE_PATH = path.join(__dirname, "data", "长期记忆", "state.json");
const BACKUP_DIR = path.join(__dirname, "data", "长期记忆");

const HANGUP_DAYS = 20; // 与前端 isHangup 一致
const FLOW_STATUSES = ["已投递", "沟通中", "待确认", "测评", "笔试", "一面", "二面", "HR面"];

// ---------- 基础工具 ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch (e) { return {}; }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function backupState(reason) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dst = path.join(BACKUP_DIR, `state_backup_${ts}_${reason}.json`);
  fs.copyFileSync(STATE_PATH, dst);
  return dst;
}
function daysSince(dateStr) {
  const t = new Date(dateStr || "").getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 864e5);
}
function normCompany(name) {
  const n = String(name || "").trim();
  const branded = n.replace(/^[A-Za-z0-9\-]+海能达/, "海能达");
  return branded.replace(/\s+/g, "").toLowerCase();
}
// 岗位名归一化：去空白、全角半角、括号后缀（如“（北京·J12457）”“（合伙人）”）用于跨记录去重
function normRole(role) {
  return String(role || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[　\s]/g, "")
    .replace(/^本公司职位|待确认岗位|待确认$/, "")
    .toLowerCase();
}
function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

// 已知公司名修正映射（人工核对沉淀的规则，可继续扩充）
const COMPANY_FIX = {
  "SÜD": "TÜV SÜD",
  "Süd": "TÜV SÜD",
  "CCQ": "奥特斯科技（重庆）有限公司",
  "线上兼职": "",
  "360集团": "三六零安全科技股份有限公司",
  "三六零": "三六零安全科技股份有限公司",
  "Hytera 海能达": "海能达",
  "Anker黑客松主办方": "Anker"
};
// 岗位名占位符：无法从邮件提取到明确岗位时保留原样进报告，不强行删除
const PLACEHOLDER_ROLES = ["待确认岗位", "本公司职位", "待确认", ""];

// ---------- 1) 存量记录核对修正 ----------
function auditJobs(state, changes) {
  const jobs = state.jobs || [];
  const add = (msg) => changes.push(msg);

  // 1.1 公司名修正
  for (const job of jobs) {
    const fix = COMPANY_FIX[job.company];
    if (fix !== undefined && job.company !== fix) {
      add({ type: "company_fix", id: job.id, from: job.company, to: fix, done: true });
      if (fix) job.company = fix;
    }
  }

  // 1.2 岗位名占位：从 archivedMail 重新提取（仅当邮件里能拿到明确岗位）
  const mails = state.archivedMail || [];
  for (const job of jobs) {
    if (!PLACEHOLDER_ROLES.includes(job.role || "")) continue;
    const mail = mails.find((m) => normCompany(m.company) === normCompany(job.company));
    if (mail && mail.role && !PLACEHOLDER_ROLES.includes(mail.role)) {
      add({ type: "role_fix", id: job.id, from: job.role, to: mail.role, source: `archivedMail uid=${mail.uid}`, done: true });
      job.role = mail.role;
    }
  }

  // 1.3 重复检测与合并（同公司+同岗位，跨渠道；不投递与已标 duplicateOf 的跳过）
  const groups = new Map();
  for (const job of jobs) {
    if (job.status === "不投递" || job.duplicateOf) continue;
    const key = normCompany(job.company) + "|" + normRole(job.role);
    if (!key.includes("|") || normRole(job.role) === "") continue; // 岗位不明不合并
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const main = list[0];
    const dups = list.slice(1);
    for (const dup of dups) {
      if (dup.duplicateOf) continue;
      add({ type: "merge", id: dup.id, from: `${dup.company}·${dup.role}`, into: main.id, done: true });
      dup.duplicateOf = main.id;
      dup.status = main.status; // 副条状态跟随主条
    }
  }

  // 1.4 状态与标签一致性（status=待确认 但 labels 有唯一明确状态词 → 用标签覆盖）
  const STATE_WORDS = ["已投递", "沟通中", "已拒绝", "已淘汰", "Offer", "已签约", "测评", "笔试", "一面", "二面"];
  for (const job of jobs) {
    if (job.status !== "待确认") continue;
    const hit = (job.labels || []).filter((l) => STATE_WORDS.includes(l));
    if (hit.length === 1 && hit[0] !== job.status) {
      add({ type: "status_unify", id: job.id, from: job.status, to: hit[0], by: `labels=${hit[0]}`, done: true });
      job.status = hit[0];
    }
  }

  // 1.5 双标规范：投递成功 + 简历完善邀请 组合规范化（去掉多余的“邀请投递”杂质）
  for (const job of jobs) {
    const labels = job.labels || [];
    if (labels.includes("投递成功") && labels.includes("简历完善邀请") && labels.includes("邀请投递")) {
      add({ type: "double_tag", id: job.id, from: labels.join("、"), to: labels.filter((l) => l !== "邀请投递").join("、"), done: true });
      job.labels = labels.filter((l) => l !== "邀请投递");
    }
  }
  return changes;
}

// ---------- 3) 自动状态流转（超时自动已淘汰） ----------
function autoStatusFlow(state, changes) {
  const jobs = state.jobs || [];
  const today = todayStr();
  for (const job of jobs) {
    if (job.duplicateOf) continue; // 副条跟随主条
    if (!FLOW_STATUSES.includes(job.status)) continue;
    if (job.followup && job.followup >= today) continue; // 有未到期跟进约定，不挂
    const days = daysSince(job.updated || job.submitted);
    if (days === null || days <= HANGUP_DAYS) continue;
    const from = job.status;
    job.status = "已淘汰";
    pushUnique(job.labels || (job.labels = []), "已淘汰");
    // notes 字段只追加（历史数据可能存在字符串型 notes，不能当数组 push）
    if (Array.isArray(job.notes)) {
      pushUnique(job.notes, `超 ${HANGUP_DAYS} 天无进展（${from}），自动标已淘汰`);
    }
    changes.push({ type: "hangup", id: job.id, from, days, done: true });
  }
  return changes;
}

// ---------- 4) 自动汇总统计 ----------
function buildSummary(state, changes) {
  const jobs = state.jobs || [];
  const tests = state.tests || [];
  const byStatus = {};
  const byChannel = {};
  const byCompany = {};
  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    const ch = job.channel || "未填写";
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    const key = normCompany(job.company);
    byCompany[key] = (byCompany[key] || 0) + 1;
  }
  const topCompanies = Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const followupsDue = jobs
    .filter((j) => j.followup && j.followup <= todayStr() && j.status !== "已淘汰" && !j.duplicateOf)
    .map((j) => `${j.company}·${j.role || ""}（${j.followup}）`);
  const duplicates = jobs.filter((j) => j.duplicateOf).length;
  const stateSummary = {
    updated: todayStr(),
    totals: {
      jobs: jobs.length,
      tests: tests.length,
      inbox: (state.inbox || []).length,
      recommended: (state.recommendedJobs || []).length
    },
    byStatus,
    byChannel,
    topCompanies,
    hangupCount: jobs.filter((j) => j.status === "已淘汰").length,
    duplicateCount: duplicates,
    followupsDue,
    lastChanges: changes.filter((c) => c.done).length
  };
  state.summary = stateSummary;
  return stateSummary;
}

// ---------- 2) 新邮件自动建档归类（替代手动写入流程） ----------
function ingestMailMessages(state, messages) {
  const changes = [];
  const add = (msg) => changes.push(msg);
  const jobs = state.jobs || (state.jobs = []);
  const tests = state.tests || (state.tests = []);
  const events = state.events || (state.events = []);
  const mailList = state.mail || (state.mail = []);
  const today = todayStr();

  for (const msg of messages) {
    const kind = msg.kind || "招聘邮件";
    // 营销/系统/普通邮件：不建档
    if (kind === "营销推送" || kind === "系统通知" || kind === "普通邮件") {
      msg.status = "已写入"; msg.skipJob = true;
      add({ type: "skip", uid: msg.uid, kind, reason: "非求职建档类型" });
      continue;
    }
    // 完善简历邀请 = 已投递（隐含），打双标
    let status = msg.status || "待确认";
    const labels = [...(msg.labels || [])];
    if (kind === "简历完善邀请") {
      status = "已投递";
      pushUnique(labels, "投递成功");
      pushUnique(labels, "简历完善邀请");
    }
    if (kind === "投递回执") {
      status = "已投递";
      pushUnique(labels, "投递成功");
    }
    // 找已有岗位：① 同邮件(mailUid) → ② 公司(包含匹配)+岗位 → ③ 公司匹配+占位符 → ④ 公司在库唯一则直接合并
    const msgCompanyNorm = normCompany(COMPANY_FIX[msg.company] ?? msg.company);
    const msgRoleNorm = normRole(msg.role);
    const jc = (j) => normCompany(COMPANY_FIX[j.company] ?? j.company);
    const companyHit = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.length >= 2 && b.length >= 2) return a.includes(b) || b.includes(a);
      return false;
    };
    let job = jobs.find((j) => j.mailUid === msg.uid);
    if (!job) job = jobs.find((j) => companyHit(jc(j), msgCompanyNorm) && normRole(j.role) === msgRoleNorm);
    if (!job && msgCompanyNorm) job = jobs.find((j) => companyHit(jc(j), msgCompanyNorm) && (PLACEHOLDER_ROLES.includes(j.role || "") || PLACEHOLDER_ROLES.includes(msg.role || "")));
    if (!job && msgCompanyNorm) {
      const same = jobs.filter((j) => companyHit(jc(j), msgCompanyNorm));
      if (same.length === 1) job = same[0];
    }
    if (job) {
      const oldStatus = job.status;
      // 邮件状态只前推不后退：明确流程状态覆盖，但不会把 Offer/已淘汰 降级
      const RANK = { "待确认": 0, "已投递": 1, "测评": 1, "笔试": 1, "沟通中": 2, "一面": 3, "二面": 4, "HR面": 4, "Offer": 5, "已签约": 6, "已拒绝": 7, "已淘汰": 8, "流程结束": 8 };
      if (status !== "待确认" && (RANK[status] || 0) >= (RANK[job.status] || 0)) job.status = status;
      // updated 只前推不后退：防止老邮件（如 09-25 的投递回执）覆盖用户近期确认的新日期导致误挂
      const mailDate = (msg.date || today).slice(0, 10);
      if (!job.updated || mailDate > job.updated) job.updated = mailDate;
      for (const l of labels) {
        if (!Array.isArray(job.labels)) job.labels = [];
        pushUnique(job.labels, l);
      }
      if (job.status !== oldStatus) add({ type: "update", uid: msg.uid, job: `${job.company}·${job.role}`, from: oldStatus, to: job.status, done: true });
    } else {
      job = {
        id: `JOB-${Date.now()}-${msg.uid}`,
        company: COMPANY_FIX[msg.company] ?? (msg.company || "待确认公司"),
        role: msg.role || "待确认岗位",
        channel: "邮箱",
        status,
        location: "",
        priority: "中",
        updated: (msg.date || today).slice(0, 10),
        next: kind === "笔试/测评" ? "完成笔试并手动更新结果" : "查看邮件并确认下一步",
        attachments: [],
        labels,
        mailUid: msg.uid
      };
      jobs.unshift(job);
      add({ type: "create", uid: msg.uid, job: `${job.company}·${job.role}`, status, labels: labels.join("、"), done: true });
    }
    // 笔试/测评 → tests 记录
    if (kind === "笔试/测评" && !tests.some((t) => t.mailUid === msg.uid)) {
      tests.unshift({
        id: `TEST-${Date.now()}-${msg.uid}`, mailUid: msg.uid, jobId: job.id,
        company: msg.company || "待确认公司", role: msg.role || "",
        received: (msg.date || today).slice(0, 10), deadline: msg.deadline || "",
        subject: msg.subject || "", sender: msg.from || "", link: msg.link || "",
        status: "未完成", note: msg.preview || ""
      });
    }
    events.unshift({
      date: (msg.date || today).slice(0, 10), type: "邮件", title: msg.subject || "招聘邮件",
      detail: `自动建档【${kind}${labels.length ? ` ${labels.join("、")}` : ""}】：${(msg.preview || "").slice(0, 120)}`,
      jobId: job.id, material: kind, source: "mail-auto"
    });
    msg.status = "已写入";
  }
  // 去重保留最近 100 封
  const byUid = new Map(mailList.map((m) => [`${m.uid}-${m.account || ""}`, m]));
  for (const msg of messages) byUid.set(`${msg.uid}-${msg.account || ""}`, msg);
  state.mail = [...byUid.values()].slice(0, 100);
  return changes;
}

// ---------- 主入口 ----------
// state：可选，外部已读入（如邮件同步流程中已做 ingest）；ingestMessages：待自动建档的新邮件列表
function runOrganize({ dryRun = false, state = null, ingestMessages = null } = {}) {
  const st = state || readState();
  const backupPath = dryRun ? null : backupState("自动整理前");
  const changes = [];
  if (ingestMessages) ingestMailMessages(st, ingestMessages);
  auditJobs(st, changes);
  autoStatusFlow(st, changes);
  buildSummary(st, changes);
  // 自动筛选：基于偏好把通过门槛的岗位写入待投递名单（recommendedJobs），未通过的记入 filterRejected 供复查
  try {
    const prefs = filter.ensurePreferences(st);
    const fr = filter.applyFilterToState(st, prefs, { dryRun });
    changes.push({ type: "filter", recommended: fr.recommended, added: fr.added, updated: fr.updated, rejected: fr.rejected, done: !dryRun });
  } catch (e) {
    changes.push({ type: "filter", error: e.message, done: false });
  }
  if (!dryRun) {
    writeState(st);
  }
  const done = changes.filter((c) => c.done);
  const report = {
    dryRun,
    backup: backupPath,
    changed: done.length,
    changes: done,
    summary: st.summary
  };
  return report;
}

module.exports = { readState, writeState, backupState, runOrganize, auditJobs, autoStatusFlow, buildSummary, ingestMailMessages, normCompany, normRole, HANGUP_DAYS };
