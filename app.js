const STORAGE_KEY = "career-agent-state-v1";
const MATERIAL_TYPES = ["招聘截图", "岗位JD", "投递回执", "笔试/测评", "面试邀请", "HR沟通", "Offer/拒信", "其他"];
const statuses = ["待评估", "准备投递", "已投递", "沟通中", "测评", "笔试", "一面", "二面", "HR面", "Offer", "已签约", "已拒绝", "已淘汰", "流程结束", "暂缓"];
const channels = ["BOSS直聘", "牛客", "官网", "Moka", "北森", "邮箱", "微信", "内推", "猎聘", "智联", "前程无忧", "其他"];
const priorities = ["高", "中", "低", "观察"];
const testStatuses = ["未完成", "已完成", "待批改", "通过", "未通过", "未安排"];

const seed = {
  jobs: [
    { id: "OLD-001", company: "杭州银行衢州分行", role: "信息技术实习生", channel: "微信", status: "已投递", location: "衢州", priority: "高", submitted: "2026-05-15", updated: "2026-05-15", next: "等待反馈", attachments: [] },
    { id: "OLD-002", company: "杭州银行嘉兴分行", role: "信息技术实习生", channel: "微信", status: "已投递", location: "嘉兴", priority: "高", submitted: "2026-05-15", updated: "2026-05-15", next: "等待反馈", attachments: [] },
    { id: "OLD-003", company: "诚迈科技有限公司", role: "影像系统工程师", channel: "邮箱", status: "已投递", location: "重庆 vivo 产业园", priority: "中", submitted: "2026-05-15", updated: "2026-05-15", next: "整理入职材料", attachments: [] },
    { id: "OLD-004", company: "三一重能", role: "AI应用", channel: "牛客", status: "已投递", location: "北京", priority: "观察", submitted: "2026-05-21", updated: "2026-05-21", next: "等待反馈", attachments: [] },
    { id: "NC-001", company: "中兴通讯供应链2027届未来领军人才招聘", role: "AI算法工程师（实习生）", channel: "Moka", status: "准备投递", location: "上海 / 西安 / 成都等", priority: "高", submitted: "", updated: "2026-09-09", next: "确认简历版本并投递", attachments: [] },
    { id: "NC-002", company: "广立微", role: "AI应用工程师（27届）-杭州", channel: "Moka", status: "已投递", location: "杭州", priority: "高", submitted: "2026-09-09", updated: "2026-09-09", next: "关注邮件和站内信", attachments: [] },
    { id: "NC-003", company: "星网锐捷", role: "AI应用工程师", channel: "北森", status: "已投递", location: "福州", priority: "中", submitted: "2026-09-09", updated: "2026-09-09", next: "关注后续通知", attachments: [] },
    { id: "NC-004", company: "海艺互娱", role: "Agent开发工程师", channel: "Moka", status: "已投递", location: "成都·双流区", priority: "高", submitted: "2026-09-09", updated: "2026-09-09", next: "补录招聘平台沟通记录", attachments: [] }
  ],
  tests: [],
  practiceHistory: [],
  nowcoderRecords: [],
  inbox: [],
  events: [
    { date: "2026-09-09", type: "投递", title: "广立微 · AI应用工程师", detail: "通过 Moka 完成投递，等待后续通知。" },
    { date: "2026-09-09", type: "投递", title: "星网锐捷 · AI应用工程师", detail: "通过北森完成投递，地点为福州。" },
    { date: "2026-09-09", type: "投递", title: "海艺互娱 · Agent开发工程师", detail: "通过 Moka 完成投递，方向匹配 Agent 工程化。" },
    { date: "2026-09-09", type: "准备", title: "中兴通讯 · AI算法工程师", detail: "岗位快照已保存，下一步确认简历版本。" }
  ]
};

let state = loadState();
let serverReady = false;
let saveQueue = Promise.resolve();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizeState(data = {}) {
  const next = { ...structuredClone(seed), ...data };
  for (const key of ["jobs", "tests", "practiceHistory", "nowcoderRecords", "recommendedJobs", "filterRejected", "inbox", "mail", "events"]) {
    if (!Array.isArray(next[key])) next[key] = [];
  }
  return next;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return normalizeState(saved?.jobs ? saved : seed);
  } catch {
    return normalizeState(seed);
  }
}

function compactState(data) {
  const next = normalizeState(data);
  const hasInlinePreview = [...next.inbox, ...next.nowcoderRecords]
    .some((item) => typeof item.preview === "string" && item.preview.startsWith("data:"));
  if (hasInlinePreview) throw new Error("legacy image migration is pending");
  return next;
}

function saveState() {
  state = normalizeState(state);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    showToast("本地缓存空间不足，已改用服务端文件保存");
  }
  renderAll();
  if (!serverReady) return Promise.resolve();
  saveQueue = saveQueue
    .then(() => fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactState(state))
    }))
    .then((response) => {
      if (!response.ok) throw new Error(`state save ${response.status}`);
    })
    .catch((error) => console.error("State persistence failed:", error));
  return saveQueue;
}

async function bootstrapState() {
  try {
    const localSnapshot = localStorage.getItem(STORAGE_KEY);
    const hasLocalState = Boolean(localSnapshot);
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`state load ${response.status}`);
    const result = await response.json();
    if (result.hasData) {
      state = normalizeState(result.state);
    } else if (hasLocalState) {
      state = normalizeState(state);
    } else {
      state = normalizeState(seed);
    }
    await migrateLegacyPreviews(state);
    serverReady = true;
    await saveState();
  } catch (error) {
    console.error("State bootstrap failed:", error);
    state = normalizeState(state);
    renderAll();
    showToast("服务端存储暂不可用，当前使用浏览器缓存");
  } finally {
    $("#appShell").inert = false;
    $("#startupGate").hidden = true;
  }
}

async function migrateLegacyPreviews(data) {
  const records = [...data.inbox, ...data.nowcoderRecords];
  for (const item of records) {
    if (typeof item.preview !== "string" || !item.preview.startsWith("data:")) continue;
    const response = await fetch(item.preview);
    const blob = await response.blob();
    const file = new File([blob], item.title || `${item.id}.png`, { type: blob.type || "image/png" });
    const uploaded = await uploadCapture(file);
    const shouldArchive = item.storage === "long-term" || item.status === "已归档" || data.nowcoderRecords.includes(item);
    const promoted = shouldArchive ? await promoteCapture(uploaded.captureId) : null;
    item.captureId = uploaded.captureId;
    item.preview = promoted?.url || uploaded.previewUrl;
    if (shouldArchive) item.storage = "long-term";
  }
}
function cleanTestRecords() {
  const before = {
    jobs: state.jobs.length,
    tests: state.tests.length,
    inbox: state.inbox.length,
    mail: (state.mail || []).length,
    events: state.events.length
  };
  const isTemp = (id = "") => /^(LOCAL|SHOT|CAP|TEST|MAIL)-/.test(id);
  state.jobs = state.jobs.filter((job) => !isTemp(job.id));
  state.tests = state.tests.filter((test) => !isTemp(test.id));
  state.inbox = state.inbox.filter((item) => !isTemp(item.id));
  state.mail = (state.mail || []).filter((mail) => !isTemp(mail.id));
  state.events = state.events.filter((event) => !/测试|识别失败|OCR|待确认招聘记录|ca899dbb90d54776bab0b873aef115a1\.jpg|67a9a7ab3847ce7e934a65e236e76397\.jpg/.test(`${event.title} ${event.detail}`));
  saveState();
  showToast(`已清理测试记录：岗位 ${before.jobs - state.jobs.length} 条，笔试 ${before.tests - state.tests.length} 条`);
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}
function denoiseCjkSpaces(value = "") {
  // tesseract 中文识别常在汉字之间插入空格（如“笔 试”），去掉汉字间的空格以恢复关键词可匹配
  return String(value).replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1").replace(/([\u4e00-\u9fa5])\s+([:：])\s*(?=[\u4e00-\u9fa5A-Za-z])/g, "$1$2");
}
function safeCaptureUrl(value = "") {
  return /^\/api\/captures\/[A-Za-z0-9_-]+$/.test(String(value)) ? value : "";
}
function today() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2300);
}
function statusClass(status) {
  if (["准备投递", "笔试", "测评", "沟通中"].includes(status)) return "warn";
  if (["已拒绝", "已淘汰", "流程结束"].includes(status)) return "coral";
  return "";
}
function statusPill(status) { return `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>`; }

const DAY_MS = 24 * 60 * 60 * 1000;
function daysBetween(fromDate, toDate) {
  const a = new Date(`${String(fromDate || "").slice(0, 10)}T00:00:00`);
  const b = new Date(`${toDate || today()}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / DAY_MS);
}
function daysSince(dateValue) { return daysBetween(dateValue, today()); }
function daysUntil(dateValue) { return daysBetween(today(), dateValue); }
function renderTodayLabel() {
  const node = $("#todayLabel");
  if (!node) return;
  node.textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function computeImportantMessages() {
  const items = [];
  const todayStr = today();
  state.tests.filter((test) => test.status === "未完成" && test.deadline).forEach((test) => {
    const days = daysUntil(test.deadline);
    if (days !== null && days >= -1 && days <= 2) items.push(`笔试截止：${test.company || "待关联岗位"} ${formatDate(test.deadline)}（${days <= 0 ? "今天/已到期" : `还有 ${days} 天`}）`);
  });
  state.jobs.filter((job) => job.status === "已投递" && !isHangup(job)).forEach((job) => {
    const days = daysSince(job.updated || job.submitted);
    if (days !== null && days > 7) items.push(`跟进提醒：${job.company} 已投递 ${days} 天无反馈`);
  });
  const pending = state.inbox.filter((item) => item.status === "待确认").length;
  if (pending > 0) items.push(`截图待确认：收件箱有 ${pending} 条记录`);
  state.jobs.filter((job) => job.followup && job.followup <= todayStr).forEach((job) => items.push(`今天该跟进：${job.company} · ${job.role}`));
  return items;
}

function checkDesktopNotify() {
  const items = computeImportantMessages();
  const badge = items.length ? `●${items.length} ` : "";
  document.title = badge + "求职智能体";
  if (!("Notification" in window) || Notification.permission !== "granted" || !items.length) return;
  const fp = JSON.stringify(items);
  let last = "";
  try { last = localStorage.getItem("career_notify_fp") || ""; } catch (error) {}
  if (fp === last) return;
  try { new Notification("求职智能体 · 重要提醒", { body: items.slice(0, 3).join("\n"), icon: "/favicon.ico" }); } catch (error) {}
  try { localStorage.setItem("career_notify_fp", fp); } catch (error) {}
}

function renderAll() {
  renderMetrics();
  renderOrganize();
  renderUrgent();
  renderPriority();
  renderDistribution();
  renderRecent();
  renderRecommended();
  renderApply();
  renderJobs();
  renderInbox();
  renderTests();
  renderMail();
  renderTimeline();
  renderPractice();
  updatePet();
  checkDesktopNotify();
}

function renderOrganize() {
  const el = $("#organizeReport");
  if (!el) return;
  const summary = state.summary;
  if (!summary) {
    el.innerHTML = `<div class="empty-state">尚未运行过自动整理。点「运行自动整理」立即执行，或邮件同步后会自动整理。</div>`;
    return;
  }
  const rows = [
    ["岗位总数", summary.totals?.jobs ?? "-"],
    ["已投递", summary.byStatus?.["已投递"] ?? 0],
    ["沟通中", summary.byStatus?.["沟通中"] ?? 0],
    ["已淘汰", summary.byStatus?.["已淘汰"] ?? 0],
    ["重复合并", summary.duplicateCount ?? 0],
    ["推荐岗位", summary.totals?.recommended ?? 0]
  ];
  const due = (summary.followupsDue || []).slice(0, 3).map(escapeHtml).join("；");
  el.innerHTML = `<div class="organize-meta">上次整理：${escapeHtml(summary.updated)} · 本次改动 ${summary.lastChanges ?? 0} 项</div>
    <div class="organize-grid">${rows.map(([k, v]) => `<div class="organize-cell"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`).join("")}</div>
    ${due ? `<div class="organize-note">待跟进：${due}</div>` : ""}`;
}

async function runOrganizeNow() {
  const btn = $("#organizeButton");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "整理中…";
  try {
    const response = await fetch("/api/organize", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "整理失败");
    const sr = await fetch("/api/state");
    const sj = await sr.json();
    if (sj.hasData) state = normalizeState(sj.state);
    renderAll();
    const changed = result.report?.changed ?? 0;
    showToast(`自动整理完成：${changed} 项改动${result.report?.backup ? "（已备份）" : ""}`);
  } catch (error) {
    showToast(`自动整理失败：${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "运行自动整理";
  }
}

function formatDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 公司名归一化：去掉品牌前缀（Hytera 海能达 → 海能达）、空白，用于跨记录去重
function normCompany(name) {
  const n = String(name || "").trim();
  const branded = n.replace(/^[A-Za-z0-9\-]+海能达/, "海能达");
  return branded.replace(/\s+/g, "").toLowerCase();
}

// 按 key 去重（保留第一条）
function dedupeBy(list, keyFn) {
  const seen = new Set();
  return list.filter((it) => {
    const key = keyFn(it);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 超过20天无进度的已投递岗位按「挂了（已淘汰）」处理
function isHangup(job) {
  if (!job || job.status !== "已投递" || job.duplicateOf) return false;
  const d = daysSince(job.updated || job.submitted);
  return d !== null && d > 20;
}
function displayStatus(job) {
  return isHangup(job) ? "已淘汰" : job.status;
}

function renderUrgent() {
  const now = Date.now();
  const items = [];
  (state.jobs || []).filter((job) => job.interviewAt && !job.duplicateOf).forEach((job) => {
    const t = new Date(job.interviewAt).getTime();
    if (!isNaN(t) && t > now && t - now <= 72 * 3600 * 1000) {
      const h = Math.ceil((t - now) / 3600000);
      items.push({ time: t, company: job.company, role: job.role || "", label: h <= 24 ? `${h}小时后 · 面试` : `${Math.ceil(h / 24)}天后 · 面试`, at: formatDateTime(job.interviewAt) });
    }
  });
  (state.tests || []).filter((test) => test.status === "未完成" && test.deadline).forEach((test) => {
    const t = new Date(test.deadline).getTime();
    if (!isNaN(t) && t > now && t - now <= 48 * 3600 * 1000) {
      const h = Math.ceil((t - now) / 3600000);
      items.push({ time: t, company: test.company || "待关联岗位", role: test.role || "笔试/测评", label: `${h}小时后 · 截止`, at: formatDateTime(test.deadline) });
    }
  });
  const deduped = dedupeBy(items, (it) => normCompany(it.company) + "|" + it.time);
  deduped.sort((a, b) => a.time - b.time);
  const el = document.getElementById("urgentList");
  if (!el) return;
  el.innerHTML = items.length ? items.map((it) => `<div class="task-item urgent-item"><span class="task-marker"></span><div><strong>${escapeHtml(it.company)} · ${escapeHtml(it.role)}</strong><small>${escapeHtml(it.label)} · ${escapeHtml(it.at)}</small></div></div>`).join("") : `<div class="empty-state">暂无紧急事项，保持节奏即可。</div>`;
}

function renderMetrics() {
  const hangupCount = state.jobs.filter(isHangup).length;
  const counts = Object.fromEntries(statuses.map((s) => [s, state.jobs.filter((job) => job.status === s).length]));
  const items = [
    ["岗位总数", state.jobs.length, "全部岗位记录", "jobs"],
    ["进行中", counts["沟通中"] + counts["测评"] + counts["笔试"] + counts["一面"] + counts["二面"] + counts["HR面"], "沟通、笔试与面试", "jobs"],
    ["已投递", counts["已投递"] - hangupCount, "投递后静默（超20天按已淘汰）", "jobs"],
    ["未完成笔试", state.tests.filter((test) => test.status === "未完成").length, "需要手动更新结果", "tests"]
  ];
  $("#metricGrid").innerHTML = items.map(([label, value, note, view]) => `<article class="metric-card" data-go="${view}" role="button" title="点击查看详情"><span class="metric-label">${label}</span><strong>${value}</strong><span class="metric-note">${note}</span></article>`).join("");
  $$("#metricGrid .metric-card").forEach((card) => card.addEventListener("click", () => switchView(card.dataset.go)));
  const done = Math.min(8, counts["已投递"] + counts["沟通中"] + counts["笔试"] + counts["一面"] + counts["二面"] + counts["HR面"] + counts["Offer"]);
  $("#weeklyProgressText").textContent = `${done} / 8`;
  $("#weeklyProgressBar").style.width = `${Math.min(100, done / 8 * 100)}%`;
}

function renderPriority() {
  const items = [];
  const todayStr = today();
  // 0) 面试临近（未来 3 天内）最优先（跳过重复记录，同公司同时段只保留一条）
  const seenInterview = new Set();
  (state.jobs || []).filter((job) => job.interviewAt && !job.duplicateOf).forEach((job) => {
    const t = new Date(job.interviewAt).getTime();
    const diff = t - Date.now();
    if (!isNaN(t) && diff > 0 && diff <= 72 * 3600 * 1000) {
      const key = normCompany(job.company) + "|" + t;
      if (seenInterview.has(key)) return;
      seenInterview.add(key);
      items.push({ title: `面试：${job.company}`, sub: `${formatDateTime(job.interviewAt)} · ${job.role || ""}` });
    }
  });
  // 1) 临近截止的笔试/测评（未来 2 天内）最优先
  state.tests
    .filter((test) => test.status === "未完成" && test.deadline)
    .map((test) => ({ test, days: daysUntil(test.deadline) }))
    .filter(({ days }) => days !== null && days >= -1 && days <= 2)
    .sort((a, b) => a.days - b.days)
    .slice(0, 3)
    .forEach(({ test, days }) => items.push({
      title: `完成笔试：${test.company || "待关联岗位"}`,
      sub: `截止 ${formatDate(test.deadline)}${days <= 0 ? "（今天/已到期）" : `（还有 ${days} 天）`}`
    }));
  // 2) 超过 7 天无反馈的已投递岗位 → 跟进/复盘
  state.jobs
    .filter((job) => job.status === "已投递" && !isHangup(job))
    .map((job) => ({ job, days: daysSince(job.updated || job.submitted) }))
    .filter(({ days }) => days !== null && days > 7)
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .forEach(({ job, days }) => items.push({
      title: `跟进/复盘：${job.company}`,
      sub: `${job.role} · 已投递 ${days} 天无反馈，主动询问进度`
    }));
  // 3) 今天或已过期的下次跟进日期
  state.jobs
    .filter((job) => job.followup && job.followup <= todayStr)
    .slice(0, 2)
    .forEach((job) => items.push({
      title: `今天该跟进：${job.company}`,
      sub: `约定跟进日期 ${formatDate(job.followup)}${job.next ? ` · ${job.next}` : ""}`
    }));
  // 4) 常规：准备投递、沟通中
  state.jobs.filter((job) => ["准备投递", "沟通中"].includes(job.status)).slice(0, 3).forEach((job) => items.push({ title: job.next || `跟进 ${job.company}`, sub: `${job.company} · ${job.role}` }));
  // 5) 其余未完成笔试
  state.tests.filter((test) => test.status === "未完成" && !test.deadline).slice(0, 2).forEach((test) => items.push({ title: `完成笔试：${test.company || "待关联岗位"}`, sub: "来自邮件，状态未完成" }));
  $("#priorityList").innerHTML = items.length ? items.slice(0, 5).map((item) => `<div class="task-item"><span class="task-marker"></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.sub)}</small></div></div>`).join("") : `<div class="empty-state">目前没有紧急事项，给自己留一点缓冲。</div>`;
}

function renderDistribution() {
  const rows = [
    ["已投递", state.jobs.filter((job) => job.status === "已投递" && !isHangup(job)).length],
    ["沟通中", state.jobs.filter((job) => job.status === "沟通中").length],
    ["笔试", (state.tests || []).length],
    ["测评", state.jobs.filter((job) => job.status === "测评").length],
    ["面试", state.jobs.filter((job) => ["一面", "二面", "HR面"].includes(job.status)).length],
    ["Offer", state.jobs.filter((job) => job.status === "Offer").length],
    ["挂了", state.jobs.filter((job) => job.status === "已淘汰" || isHangup(job)).length]
  ];
  const max = Math.max(1, ...rows.map(([, count]) => count));
  $("#distribution").innerHTML = rows.map(([label, count]) => `<div class="distribution-row"><span>${label}</span><div class="distribution-track"><span style="width:${count / max * 100}%"></span></div><strong>${count}</strong></div>`).join("");
}

function renderRecent() {
  const events = [...state.events].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  $("#activityCount").textContent = `${state.events.length} 条记录`;
  $("#recentActivity").innerHTML = events.length ? events.map((event) => `<div class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.type)} · ${escapeHtml(event.detail)}</small>${event.attachments?.length ? `<div class="activity-attachments">${event.attachments.map((attachment) => `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noreferrer">${escapeHtml(attachment.kind || "查看附件")}</a>`).join("")}</div>` : ""}</div><time>${formatDate(event.date)}</time></div>`).join("") : `<div class="empty-state">还没有活动记录。</div>`;
}

function renderRecommended() {
  const el = $("#recommendedList");
  if (!el) return;
  const list = state.recommendedJobs || [];
  el.innerHTML = list.length ? list.map((rec) => `
    <article class="recommend-card">
      <div class="recommend-main">
        <strong>${escapeHtml(rec.company)} · ${escapeHtml(rec.role)}</strong>
        <small>${escapeHtml(rec.location || "未填地点")} · 截止 ${escapeHtml(rec.deadline || "待定")} · 来源 ${escapeHtml(rec.source || "")}</small>
        <p class="recommend-reason">${escapeHtml(rec.reason || "")}</p>
        ${rec.note ? `<p class="recommend-note">${escapeHtml(rec.note)}</p>` : ""}
      </div>
      <div class="recommend-side">
        ${rec.link ? `<a class="small-button" href="${escapeHtml(rec.link)}" target="_blank" rel="noreferrer">查看岗位 ↗</a>` : ""}
        <span class="status-pill">${escapeHtml(rec.applyStatus || "未投递")}</span>
        <button class="small-button done-recommend" data-id="${escapeHtml(rec.id)}" ${rec.applyStatus === "已投递" ? "disabled" : ""}>${rec.applyStatus === "已投递" ? "已投" : "标记已投"}</button>
      </div>
    </article>`).join("")
    : `<div class="empty-state">暂无推荐岗位。抓取 BOSS直聘 / 腾讯文档内推后会出现在这里。</div>`;
  $$(".done-recommend").forEach((button) => button.addEventListener("click", () => {
    const rec = list.find((item) => item.id === button.dataset.id);
    if (rec) { rec.applyStatus = "已投递"; saveState(); showToast("已标记为投递"); }
  }));
}

// ---------- 待投递名单 / 自动筛选 ----------
function csvToArray(s) {
  return String(s || "").split(/[,，]/).map((t) => t.trim()).filter(Boolean);
}
function arrayToCsv(a) {
  return (a || []).join(", ");
}
function renderApply() {
  const el = $("#applyList");
  if (!el) return;
  const recs = (state.recommendedJobs || [])
    .filter((r) => r.applyStatus !== "已投递" && r.applyStatus !== "已忽略")
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  el.innerHTML = recs.length ? recs.map((rec) => `
    <article class="recommend-card ${(rec.applyStatus === "已投递") ? "is-applied" : ""}">
      <div class="recommend-main">
        <strong>${escapeHtml(rec.company)} · ${escapeHtml(rec.role)}</strong>
        <small>${escapeHtml(rec.location || "未填地点")} · 来源 ${escapeHtml(rec.source || "")} · 评分 ${rec.score ?? "—"}</small>
        <p class="recommend-reason">${escapeHtml(rec.reason || "")}</p>
      </div>
      <div class="recommend-side">
        ${rec.link ? `<a class="small-button" href="${escapeHtml(rec.link)}" target="_blank" rel="noreferrer">查看岗位 ↗</a>` : ""}
        <span class="status-pill">${escapeHtml(rec.applyStatus || "未投递")}</span>
        <button class="small-button apply-one" data-id="${escapeHtml(rec.id)}" ${rec.applyStatus === "已投递" ? "disabled" : ""}>确认投递</button>
        <button class="small-button ghost ignore-one" data-id="${escapeHtml(rec.id)}">忽略</button>
      </div>
    </article>`).join("")
    : `<div class="empty-state">暂无待投递岗位。先去「邮件中心」同步、或点「重新筛选」生成名单。</div>`;
  $$(".apply-one").forEach((b) => b.addEventListener("click", () => applyRecommended([b.dataset.id])));
  $$(".ignore-one").forEach((b) => b.addEventListener("click", () => ignoreRecommended(b.dataset.id)));

  const rej = $("#rejectedList");
  if (rej) {
    const rejected = (state.filterRejected || []).slice(0, 40);
    rej.innerHTML = rejected.length ? rejected.map((r) => `
      <article class="recommend-card is-rejected">
        <div class="recommend-main">
          <strong>${escapeHtml(r.company)} · ${escapeHtml(r.role)}</strong>
          <small>${escapeHtml(r.location || "")}</small>
          <p class="recommend-reason">${escapeHtml(r.reason || "")}</p>
        </div>
      </article>`).join("") : `<div class="empty-state">没有因筛选被排除的岗位。</div>`;
  }
  const sum = $("#applySummary");
  if (sum) {
    const total = (state.recommendedJobs || []).length;
    const pending = recs.length;
    sum.innerHTML = `<span class="pill">待投递 <strong>${pending}</strong></span><span class="pill">已投递 <strong>${total - pending}</strong></span><span class="pill">被排除 <strong>${(state.filterRejected || []).length}</strong></span>`;
  }
}
function ignoreRecommended(id) {
  const rec = (state.recommendedJobs || []).find((r) => r.id === id);
  if (!rec) return;
  if (!window.confirm(`将「${rec.company} · ${rec.role}」移出待投递名单（本次会话生效，下次筛选可能再次进入）？`)) return;
  rec.applyStatus = "已忽略";
  saveState();
  showToast("已忽略该岗位");
}
async function applyRecommended(ids) {
  if (!ids || !ids.length) return;
  try {
    const resp = await fetch("/api/recommended/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "apply_failed");
    (data.applied || []).forEach((a) => { if (a.link) window.open(a.link, "_blank", "noopener"); });
    await bootstrapState();
    renderApply();
    const limited = (data.limited || []).length;
    showToast(`已确认投递 ${data.applied.length} 个${limited ? `；今日达上限，剩余 ${limited} 个未投` : ""}`);
  } catch (e) {
    showToast("确认投递失败：" + e.message);
  }
}
async function runFilterNow() {
  try {
    const resp = await fetch("/api/filter/run", { method: "POST" });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "filter_failed");
    await bootstrapState();
    showToast(`重新筛选完成：待投递 ${data.report.recommended}，新增 ${data.report.added}，排除 ${data.report.rejected}`);
  } catch (e) {
    showToast("筛选失败：" + e.message);
  }
}
async function openPrefsModal() {
  try {
    const resp = await fetch("/api/preferences");
    const data = await resp.json();
    const p = data.preferences || {};
    $("#prefCities").value = arrayToCsv(p.cities);
    $("#prefRoles").value = arrayToCsv(p.rolesInclude);
    $("#prefRolesExclude").value = arrayToCsv(p.rolesExclude);
    $("#prefCompanyBlack").value = arrayToCsv(p.companyBlacklist);
    $("#prefCompanyWhite").value = arrayToCsv(p.companyWhitelist);
    $("#prefExclude").value = arrayToCsv(p.excludeKeywords);
    $("#prefMinSalary").value = p.minSalaryK || 0;
    $("#prefMinScore").value = p.minScore || 50;
    $("#prefDaily").value = p.dailyLimit || 15;
    $("#prefOnlyCity").checked = Boolean(p.onlyListedCities);
    $("#prefAutoSubmit").checked = Boolean(p.autoSubmit);
    $("#prefsModal").showModal();
  } catch (e) {
    showToast("读取偏好失败：" + e.message);
  }
}
async function savePrefs() {
  const prefs = {
    cities: csvToArray($("#prefCities").value),
    rolesInclude: csvToArray($("#prefRoles").value),
    rolesExclude: csvToArray($("#prefRolesExclude").value),
    companyBlacklist: csvToArray($("#prefCompanyBlack").value),
    companyWhitelist: csvToArray($("#prefCompanyWhite").value),
    excludeKeywords: csvToArray($("#prefExclude").value),
    minSalaryK: Number($("#prefMinSalary").value) || 0,
    minScore: Number($("#prefMinScore").value) || 50,
    dailyLimit: Number($("#prefDaily").value) || 15,
    onlyListedCities: $("#prefOnlyCity").checked,
    autoSubmit: $("#prefAutoSubmit").checked
  };
  try {
    const resp = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "save_failed");
    showToast("偏好已保存，正在按新偏好重新筛选…");
    await runFilterNow();
  } catch (e) {
    showToast("保存偏好失败：" + e.message);
  }
}
function renderJobs() {
  const search = ($("#jobSearch")?.value || "").toLowerCase();
  const filter = $("#jobStatusFilter")?.value || "全部";
  const filtered = state.jobs.filter((job) => (!search || `${job.company} ${job.role}`.toLowerCase().includes(search)) && (filter === "全部" || displayStatus(job) === filter));
  $("#jobsTableBody").innerHTML = filtered.map((job) => `<tr>
    <td><div class="company-role"><strong>${escapeHtml(job.company)}</strong><span>${escapeHtml(job.role)}</span>${(job.labels || []).length ? `<span class="job-labels">${job.labels.map((label) => `<em>${escapeHtml(label)}</em>`).join("")}</span>` : ""}</div></td>
    <td>${escapeHtml(job.channel || "未填写")}</td><td>${escapeHtml(job.location || "未填写")}</td>
    <td>${statusPill(displayStatus(job))}</td><td>${formatDate(job.submitted || job.updated || "")}</td>
    <td><span class="material-count">${job.attachments?.length || 0} 份</span>${job.attachments?.length ? `<div class="job-attachments">${job.attachments.map((attachment) => {
      const url = safeCaptureUrl(attachment.url);
      return url ? `<a href="${url}" target="_blank" rel="noreferrer" title="${escapeHtml(attachment.name || attachment.kind || "查看附件")}">${escapeHtml(attachment.kind || attachment.name || "查看")}</a>` : "";
    }).join("")}</div>` : ""}</td>
    <td><div class="row-actions"><button class="small-button edit-job" data-id="${job.id}">编辑</button><button class="small-button advance-job" data-id="${job.id}">推进</button><button class="small-button delete-job" data-id="${job.id}">删除</button></div></td>
  </tr>`).join("") || `<tr><td colspan="7">没有符合条件的岗位。</td></tr>`;
  $$(".edit-job").forEach((button) => button.addEventListener("click", () => openJobModal(button.dataset.id)));
  $$(".advance-job").forEach((button) => button.addEventListener("click", () => advanceJob(button.dataset.id)));
  $$(".delete-job").forEach((button) => button.addEventListener("click", () => deleteJob(button.dataset.id)));
}

function deleteJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job || !window.confirm(`确定删除「${job.company} · ${job.role}」岗位吗？关联的笔试记录和流程事件也会删除。`)) return;
  state.jobs = state.jobs.filter((item) => item.id !== id);
  state.tests = state.tests.filter((test) => test.jobId !== id);
  state.events = state.events.filter((event) => event.jobId !== id);
  saveState();
  showToast("岗位已删除");
}

function renderInbox() {
  $("#inboxGrid").innerHTML = state.inbox.length ? state.inbox.map((item) => `<article class="inbox-card">
    ${item.preview ? `<img class="inbox-image" src="${item.preview}" alt="招聘截图预览" />` : `<div class="inbox-image"></div>`}
    <h3>${escapeHtml(item.title || "待确认招聘记录")}</h3>
    <p>${escapeHtml(item.text || "截图已保存，等待确认公司、岗位和状态。")}</p>
    ${item.material ? `<small class="muted">材料：${escapeHtml(item.material)}${item.storage === "long-term" ? " · 已归档" : ""}</small>` : ""}
    ${item.ocrStatus === "识别中" ? `<div class="ocr-progress"><span></span></div><small class="muted">正在识别截图文字…</small>` : ""}
    ${item.ocrStatus === "识别失败" ? `<small class="muted">识别失败，图片仍保留，可手动补录</small>` : ""}
    <div class="card-actions"><span class="status-pill warn">${escapeHtml(item.status || "待确认")}</span><button class="small-button confirm-inbox" data-id="${item.id}">${item.status === "已归档" ? "查看记录" : "确认识别"}</button></div>
  </article>`).join("") : `<div class="empty-state">还没有截图记录。把手机上的聊天截图拖到上方区域即可。</div>`;
  $$(".confirm-inbox").forEach((button) => button.addEventListener("click", () => openInboxModal(button.dataset.id)));
}

function renderTests() {
  const unfinished = state.tests.filter((test) => test.status === "未完成").length;
  $("#testSummary").innerHTML = `<div class="summary-chip">全部<strong>${state.tests.length}</strong></div><div class="summary-chip">未完成<strong>${unfinished}</strong></div><div class="summary-chip">已完成<strong>${state.tests.filter((test) => test.status === "已完成").length}</strong></div>`;
  $("#testList").innerHTML = state.tests.length ? state.tests.map((test) => `<article class="test-card"><div><h3>${escapeHtml(test.company || "未关联公司")} <span class="muted">· ${escapeHtml(test.subject || "笔试/测评")}</span></h3><div class="test-meta"><span>邮件：${escapeHtml(test.received || "未填写")}</span><span>截止：${escapeHtml(formatDate(test.deadline) || "未填写")}</span><span>发件人：${escapeHtml(test.sender || "未填写")}</span></div></div><div class="test-side">${statusPill(test.status)}<select class="test-status-select" data-id="${test.id}">${testStatuses.map((status) => `<option ${status === test.status ? "selected" : ""}>${status}</option>`).join("")}</select><button type="button" class="small-button delete-test" data-id="${test.id}">删除</button></div></article>`).join("") : `<div class="empty-state">还没有笔试记录。收到邮件后点击“新增笔试”。</div>`;
  $$(".test-status-select").forEach((select) => select.addEventListener("change", () => {
    const test = state.tests.find((item) => item.id === select.dataset.id);
    if (test) { test.status = select.value; saveState(); showToast("笔试状态已更新"); }
  }));
  $$(".delete-test").forEach((button) => button.addEventListener("click", () => deleteTest(button.dataset.id)));
}

function deleteTest(id) {
  const test = state.tests.find((item) => item.id === id);
  if (!test || !window.confirm(`确定删除「${test.company || "未关联岗位"}」的笔试记录吗？`)) return;
  state.tests = state.tests.filter((item) => item.id !== id);
  saveState();
  showToast("笔试记录已删除");
}

function renderMail() {
  const mails = state.mail || [];
  const counts = {
    全部: mails.length,
    笔试: mails.filter((mail) => mail.kind === "笔试/测评").length,
    面试: mails.filter((mail) => mail.kind === "面试邀请").length,
    其他: mails.filter((mail) => !["笔试/测评", "面试邀请"].includes(mail.kind)).length
  };
  $("#mailSummary").innerHTML = Object.entries(counts).map(([label, count]) => `<div class="summary-chip">${label}<strong>${count}</strong></div>`).join("");
  $("#mailList").innerHTML = mails.length ? mails.map((mail) => `<article class="mail-card">
    <div><h3>${escapeHtml(mail.subject || "无主题邮件")}</h3><p>${escapeHtml(mail.preview || "没有邮件正文摘要")}</p><div class="mail-meta"><span>${escapeHtml(mail.from || "未知发件人")}</span><span>${escapeHtml(formatDate(mail.date) || "未知日期")}</span><span>${escapeHtml(mail.kind || "招聘邮件")}</span>${(mail.labels || []).map((label) => `<span class="mail-label">${escapeHtml(label)}</span>`).join("")}</div></div>
    <div class="mail-side">${statusPill(mail.status || "待确认")}<br/><button class="small-button apply-mail" data-id="${mail.id}">写入流程</button></div>
  </article>`).join("") : `<div class="empty-state">还没有同步邮件。填写邮箱信息后点击“同步邮件”。</div>`;
  $$(".apply-mail").forEach((button) => button.addEventListener("click", () => applyMail(button.dataset.id)));
}

function renderMaterials(assets = []) {
  const grid = $("#materialsGrid");
  const summary = $("#materialsSummary");
  if (!grid) return;
  if (summary) {
    const byCategory = {};
    assets.forEach((asset) => { byCategory[asset.category] = (byCategory[asset.category] || 0) + 1; });
    summary.innerHTML = `<div class="summary-chip">共<strong>${assets.length}</strong>份材料</div>${Object.entries(byCategory).map(([label, count]) => `<div class="summary-chip">${label}<strong>${count}</strong></div>`).join("")}`;
  }
  grid.innerHTML = assets.length ? assets.map((asset) => `<article class="material-card">
    <div class="material-heading"><strong>${escapeHtml(asset.name)}</strong><span class="status-pill">${escapeHtml(asset.category)}</span></div>
    ${asset.use ? `<p class="material-use">建议用途：${escapeHtml(asset.use)}</p>` : `<p class="material-use muted">暂无建议用途，可自行标注</p>`}
    <div class="material-meta"><span>更新于 ${escapeHtml(asset.modified)}</span><span>${asset.sizeKB} KB</span></div>
    <a class="small-button" href="${escapeHtml(asset.url)}" target="_blank" rel="noreferrer">打开材料 ↗</a>
  </article>`).join("") : `<div class="empty-state">「简历资料」目录为空或不存在。请把简历、作品集、成绩单等材料放到该目录。</div>`;
}

async function fetchAssets() {
  const button = $("#refreshMaterialsButton");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/assets");
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "材料加载失败");
    renderMaterials(result.assets || []);
  } catch (error) {
    console.error("Materials load failed:", error);
    renderMaterials([]);
    const grid = $("#materialsGrid");
    if (grid) grid.innerHTML = `<div class="empty-state">材料库加载失败：${escapeHtml(error.message)}。请确认服务端已启动。</div>`;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTimeline() {
  const groups = state.jobs.map((job) => {
    const events = state.events
      .filter((event) => event.jobId === job.id || (!event.jobId && `${event.title} ${event.detail}`.includes(job.company) && (!job.role || `${event.title} ${event.detail}`.includes(job.role))))
      .sort((a, b) => b.date.localeCompare(a.date));
    return `<article class="job-timeline"><div class="job-timeline-heading"><div><span class="eyebrow">Job timeline</span><h3>${escapeHtml(job.company)}</h3><p>${escapeHtml(job.role || "未填写岗位")}</p></div>${statusPill(job.status)}</div><div class="timeline">${events.length ? events.map((event) => `<div class="timeline-item"><span class="timeline-date">${formatDate(event.date)} · ${escapeHtml(event.type)}</span><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.detail)}</p></div>`).join("") : `<div class="empty-state">暂无流程事件，投递日期：${escapeHtml(formatDate(job.submitted || "" ) || "未填写")}</div>`}</div></article>`;
  }).join("");
  $("#timeline").innerHTML = groups || `<div class="empty-state">暂无岗位时间线。</div>`;
}

function populateSelect(select, values, includeAll = false) {
  if (!select) return;
  select.innerHTML = `${includeAll ? `<option>全部</option>` : ""}${values.map((value) => `<option>${value}</option>`).join("")}`;
}

async function uploadCapture(file) {
  if (!file) return null;
  const formData = new FormData();
  formData.append("image", file);
  const response = await fetch("/api/captures", { method: "POST", body: formData });
  if (!response.ok) throw new Error(`capture upload ${response.status}`);
  return response.json();
}

async function promoteCapture(captureId) {
  if (!captureId) return null;
  const response = await fetch(`/api/captures/${encodeURIComponent(captureId)}/promote`, { method: "POST" });
  return response.ok ? response.json() : null;
}

function initSelects() {
  populateSelect($("#jobStatusFilter"), statuses, true);
  populateSelect($("#jobChannel"), channels);
  populateSelect($("#jobStatus"), statuses);
  populateSelect($("#jobPriority"), priorities);
  populateSelect($("#testStatus"), testStatuses);
}
function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function openJobModal(id = "") {
  const job = state.jobs.find((item) => item.id === id);
  $("#jobModalTitle").textContent = job ? "编辑岗位" : "新增岗位";
  $("#jobId").value = job?.id || "";
  $("#jobCompany").value = job?.company || "";
  $("#jobRole").value = job?.role || "";
  $("#jobChannel").value = job?.channel || "BOSS直聘";
  $("#jobStatus").value = job?.status || "待评估";
  $("#jobLocation").value = job?.location || "";
  $("#jobPriority").value = job?.priority || "中";
  $("#jobSubmitted").value = job?.submitted || "";
  $("#jobUpdated").value = job?.updated || today();
  $("#jobFollowup").value = job?.followup || "";
  $("#jobInterviewAt").value = job?.interviewAt || "";
  $("#jobLink").value = job?.link || "";
  $("#jobNext").value = job?.next || "";
  $("#jobModal").showModal();
}
function saveJob(event) {
  event.preventDefault();
  const data = { id: $("#jobId").value || `JOB-${Date.now()}`, company: $("#jobCompany").value.trim(), role: $("#jobRole").value.trim(), channel: $("#jobChannel").value, status: $("#jobStatus").value, location: $("#jobLocation").value.trim(), priority: $("#jobPriority").value, submitted: $("#jobSubmitted").value || "", updated: $("#jobUpdated").value || today(), followup: $("#jobFollowup").value, interviewAt: $("#jobInterviewAt").value || "", link: $("#jobLink").value.trim(), next: $("#jobNext").value.trim(), attachments: [] };
  const existing = state.jobs.findIndex((job) => job.id === data.id);
  if (existing >= 0) state.jobs[existing] = { ...state.jobs[existing], ...data, attachments: state.jobs[existing].attachments || [] };
  else state.jobs.unshift(data);
  state.events.unshift({ date: today(), type: existing >= 0 ? "更新" : "新增", title: `${data.company} · ${data.role}`, detail: `状态：${data.status}` });
  saveState();
  $("#jobModal").close();
  showToast(existing >= 0 ? "岗位已更新" : "岗位已加入管线");
}
function advanceJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  const nextIndex = Math.min(statuses.indexOf(job.status) + 1, statuses.length - 1);
  const old = job.status;
  job.status = statuses[nextIndex];
  job.updated = today();
  state.events.unshift({ date: today(), type: "状态变化", title: `${job.company} · ${job.role}`, detail: `${old} → ${job.status}` });
  saveState();
  showToast(`已推进到「${job.status}」`);
}
function openTestModal() {
  populateSelect($("#testJob"), state.jobs.map((job) => `${job.id} · ${job.company} · ${job.role}`));
  $("#testReceived").value = today();
  $("#testDeadline").value = "";
  $("#testSubject").value = "";
  $("#testSender").value = "";
  $("#testLink").value = "";
  $("#testStatus").value = "未完成";
  $("#testNote").value = "";
  $("#testModal").showModal();
}
function saveTest(event) {
  event.preventDefault();
  const jobText = $("#testJob").value || "";
  const jobId = jobText.split(" · ")[0];
  const job = state.jobs.find((item) => item.id === jobId);
  const test = { id: `TEST-${Date.now()}`, jobId, company: job?.company || "未关联公司", role: job?.role || "", received: $("#testReceived").value, deadline: $("#testDeadline").value, subject: $("#testSubject").value.trim(), sender: $("#testSender").value.trim(), link: $("#testLink").value.trim(), status: $("#testStatus").value || "未完成", note: $("#testNote").value.trim() };
  state.tests.unshift(test);
  state.events.unshift({ date: today(), type: "笔试", title: `${test.company} · 笔试测评`, detail: `来自邮件，当前状态：${test.status}` });
  saveState();
  $("#testModal").close();
  showToast("笔试记录已保存，状态默认为未完成");
}
function addCaptureText(text) {
  if (!text.trim()) return;
  state.inbox.unshift({
    id: `CAP-${Date.now()}`,
    title: "文字补录 · 待确认",
    text: text.trim(),
    status: "待确认",
    material: "其他",
    storage: "short-term",
    created: today()
  });
  saveState();
  showToast("文字记录已加入收件箱");
}
function addFiles(files) {
  [...files].filter((file) => file.type.startsWith("image/")).forEach((file) => {
    const item = {
      id: `SHOT-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: file.name,
      text: "截图已加入，正在识别文字。",
      status: "识别中",
      ocrStatus: "识别中",
      preview: "",
      material: "招聘截图",
      storage: "short-term",
      created: today()
    };
    state.inbox.unshift(item);
    saveState();
    runOcr(file, item);
  });
}
async function runOcr(file, item) {
  try {
    const formData = new FormData();
    formData.append("image", file);
    const response = await fetch("/api/ocr", { method: "POST", body: formData });
    const result = await response.json().catch(() => ({}));
    if (result.captureId) {
      item.captureId = result.captureId;
      item.preview = result.previewUrl || "";
    }
    if (!response.ok) throw new Error(result.detail || `OCR server ${response.status}`);
    const text = denoiseCjkSpaces((result.text || "").replace(/\n{3,}/g, "\n\n").trim());
    const guess = inferCapture(text);
    Object.assign(item, {
      ocrStatus: "已识别",
      status: "待确认",
      text: text || "未识别到清晰文字，请手动填写。",
      captureId: result.captureId || "",
      preview: result.previewUrl || "",
      company: guess.company,
      role: guess.role,
      channel: guess.channel,
      captureStatus: guess.status,
      next: guess.next,
      ocrText: text
    });
    saveState();
    showToast(text ? "截图识别完成，请点击“确认识别”核对" : "没有识别到清晰文字，请手动填写");
  } catch (error) {
    console.error(error);
    item.ocrStatus = "识别失败";
    item.status = "待确认";
    item.text = "截图识别失败，请手动填写。";
    saveState();
    showToast("截图识别失败，已保留截图");
  }
}
function inferCapture(text) {
  const company = state.jobs.find((job) => text.includes(job.company))?.company || "";
  const role = state.jobs.find((job) => text.includes(job.role))?.role || "";
  let status = "沟通中";
  if (/笔试|测评|测验|在线考试/.test(text)) status = "笔试";
  else if (/面试|一面|二面|HR面|复试/.test(text)) status = text.includes("二面") ? "二面" : text.includes("HR") ? "HR面" : "一面";
  else if (/offer|录用|入职/.test(text.toLowerCase())) status = "Offer";
  else if (/投递成功|申请成功|简历已投/.test(text)) status = "已投递";
  const dateMatch = text.match(/(?:今天|明天|后天|\d{1,2}[月\/]\d{1,2}日?|\d{4}[-年]\d{1,2}[-月]\d{1,2})/);
  return { company, role, channel: /邮件|邮箱/.test(text) ? "邮箱" : "BOSS直聘", status, next: dateMatch ? `确认 ${dateMatch[0]} 的流程安排` : "" };
}
function openInboxModal(id) {
  const item = state.inbox.find((entry) => entry.id === id);
  if (!item) return;
  populateSelect($("#captureChannel"), channels);
  populateSelect($("#captureStatus"), statuses);
  $("#captureJob").innerHTML = `<option value="">新建岗位或自动匹配</option>${state.jobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(`${job.company} · ${job.role}`)}</option>`).join("")}`;
  populateSelect($("#captureMaterial"), MATERIAL_TYPES);
  $("#inboxId").value = item.id;
  $("#inboxModalTitle").textContent = item.status === "已归档" ? "编辑截图记录" : "确认截图记录";
  $("#captureJob").value = item.jobId || "";
  $("#captureCompany").value = item.company || "";
  $("#captureRole").value = item.role || "";
  $("#captureChannel").value = item.channel || "BOSS直聘";
  $("#captureMaterial").value = item.material || "招聘截图";
  $("#captureStatus").value = item.captureStatus || "沟通中";
  $("#captureDate").value = item.created || today();
  $("#captureSubmitted").value = item.submitted || "";
  $("#captureNext").value = item.next || "";
  $("#captureSummary").value = item.text || "";
  $("#capturePreview").innerHTML = item.preview ? `<img src="${item.preview}" alt="待确认招聘截图" />` : `<p class="muted">这是一条文字补录记录，没有图片预览。</p>`;
  $("#inboxModal").showModal();
}
async function confirmInbox(event) {
  event.preventDefault();
  const item = state.inbox.find((entry) => entry.id === $("#inboxId").value);
  if (!item) return;
  const linkedJobId = $("#captureJob").value;
  const company = $("#captureCompany").value.trim();
  const role = $("#captureRole").value.trim();
  const captureStatus = $("#captureStatus").value;
  const material = $("#captureMaterial").value || "其他";
  const existing = state.jobs.find((job) => job.id === linkedJobId) || state.jobs.find((job) => job.company === company && job.role === role);
  const submitted = $("#captureSubmitted").value || "";
  let attachment = null;
  if (item.captureId) {
    try {
      const result = await promoteCapture(item.captureId);
      if (result) {
        attachment = { id: item.captureId, name: item.title, kind: material, url: result.url, created: item.created };
      }
    } catch (error) {
      console.error("Capture promotion failed:", error);
    }
    if (!attachment) {
      showToast("截图归档失败，记录仍保留在待处理区，请稍后重试");
      return;
    }
  }
  const job = existing || { id: `JOB-${Date.now()}`, company, role, channel: $("#captureChannel").value, status: captureStatus, location: "", priority: "中", submitted, updated: $("#captureDate").value || today(), next: $("#captureNext").value.trim(), attachments: [] };
  job.attachments = [...(job.attachments || [])];
  if (attachment && !job.attachments.some((entry) => entry.id === attachment.id)) job.attachments.push(attachment);
  if (existing) Object.assign(existing, { company, role, channel: $("#captureChannel").value, status: captureStatus, submitted: submitted || existing.submitted || "", updated: $("#captureDate").value || today(), next: $("#captureNext").value.trim() });
  else state.jobs.unshift(job);
  item.company = company;
  item.role = role;
  item.jobId = job.id;
  item.channel = $("#captureChannel").value;
  item.material = material;
  item.captureStatus = captureStatus;
  item.text = $("#captureSummary").value.trim();
  item.status = "已归档";
  item.storage = "long-term";
  if (attachment) item.preview = attachment.url;
  state.events.unshift({
    date: $("#captureDate").value || today(),
    type: material,
    title: `${company} · ${role}`,
    detail: `${captureStatus}：${item.text || "来自手机截图/文字补录"}${item.ocrText && item.ocrText !== item.text ? `\nOCR原文：${item.ocrText}` : ""}`,
    jobId: job.id,
    material,
    source: "capture",
    ocrText: item.ocrText || item.text || "",
    attachments: attachment ? [attachment] : []
  });
  saveState();
  $("#inboxModal").close();
  showToast(existing ? "已更新岗位并写入流程时间线" : "已新建岗位并写入流程时间线");
}
function updatePet() {
  const unfinished = state.tests.filter((test) => test.status === "未完成").length;
  const pending = state.inbox.filter((item) => item.status === "待确认").length;
  const followups = state.jobs.filter((job) => ["准备投递", "沟通中"].includes(job.status)).length;
  const nearDeadline = state.tests.some((test) => {
    if (test.status !== "未完成" || !test.deadline) return false;
    const days = daysUntil(test.deadline);
    return days !== null && days >= 0 && days <= 2;
  });
  const staleSubmits = state.jobs.filter((job) => {
    if (job.status !== "已投递" || isHangup(job)) return false;
    const days = daysSince(job.updated || job.submitted);
    return days !== null && days > 7;
  }).length;
  let message = "今天也慢慢推进一件事。";
  window.petHint = "overview";
  if (nearDeadline) { message = "有笔试/测评临近截止，记得按时完成。"; window.petHint = "tests"; }
  else if (unfinished) { message = `有 ${unfinished} 个笔试还没更新状态。`; window.petHint = "tests"; }
  else if (pending) { message = `收件箱里有 ${pending} 条截图等你确认。`; window.petHint = "inbox"; }
  else if (staleSubmits) { message = `有 ${staleSubmits} 个岗位投递后没动静了，去跟进一下。`; window.petHint = "jobs"; }
  else if (followups) { message = `今天推进一个岗位：还有 ${followups} 个待行动。`; window.petHint = "jobs"; }
  $("#petBubble").textContent = message;
}

function switchView(view) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
  const titles = { overview: "今日求职总览", jobs: "岗位管线", inbox: "截图补录", tests: "笔试测评", practice: "笔面试模拟", mail: "邮件中心", materials: "简历材料", timeline: "流程时间线", apply: "待投递名单", brain: "大脑助手" };
  $("#pageTitle").textContent = titles[view];
  if (view === "apply") renderApply();
}

function applyMail(id) {
  const mail = (state.mail || []).find((item) => item.id === id);
  if (!mail) return;
  if (mail.kind === "营销推送") {
    mail.status = "已写入";
    mail.skipJob = true;
    saveState();
    return;
  }
  const existing = state.jobs.find((job) => (mail.company && job.company === mail.company) || (mail.role && job.role === mail.role));
  if (existing) {
    existing.status = mail.status;
    existing.updated = (mail.date || today()).slice(0, 10);
    existing.next = mail.kind === "笔试/测评" ? "完成笔试并手动更新结果" : mail.kind === "面试邀请" ? "准备面试并确认时间" : "查看邮件并跟进";
    if (mail.labels?.length) existing.labels = [...new Set([...(existing.labels || []), ...mail.labels])];
  } else {
    state.jobs.unshift({ id: `JOB-${Date.now()}`, company: mail.company || "待确认公司", role: mail.role || "待确认岗位", channel: "邮箱", status: mail.status, location: "", priority: "中", updated: (mail.date || today()).slice(0, 10), next: mail.kind === "笔试/测评" ? "完成笔试并手动更新结果" : "查看邮件并确认下一步", attachments: [], labels: mail.labels || [] });
  }
  const job = existing || state.jobs[0];
  if (mail.kind === "笔试/测评" && !state.tests.some((test) => (test.mailId && test.mailId === mail.id) || (mail.company && test.company === mail.company && test.role === mail.role))) {
    state.tests.unshift({ id: `TEST-${Date.now()}`, mailId: mail.id, jobId: job?.id || "", company: mail.company || "待确认公司", role: mail.role || "", received: (mail.date || today()).slice(0, 10), deadline: mail.deadline || "", subject: mail.subject || "", sender: mail.from || "", link: mail.link || "", status: "未完成", note: mail.preview || "" });
  }
  state.events.unshift({ date: (mail.date || today()).slice(0, 10), type: "邮件", title: mail.subject || "招聘邮件", detail: `${mail.kind || "招聘邮件"}${mail.labels?.length ? `【${mail.labels.join("、")}】` : ""}：${mail.preview || ""}`, jobId: job?.id || "", material: mail.kind || "招聘邮件", source: "mail" });
  mail.status = "已写入";
  saveState();
  showToast("邮件信息已写入岗位流程");
}

async function syncMail() {
  const config = {
    user: $("#mailUser").value.trim(),
    password: $("#mailPassword").value,
    host: $("#mailHost").value.trim(),
    port: Number($("#mailPort").value || 993),
    mailbox: $("#mailbox").value.trim() || "INBOX",
    days: Number($("#mailDays").value || 30)
  };
  if (!config.user || !config.password || !config.host) {
    showToast("请先填写邮箱、应用专用密码和 IMAP 服务器");
    return;
  }
  $("#mailSyncStatus").textContent = "正在同步邮件…";
  $("#syncMailButton").disabled = true;
  try {
    const response = await fetch("/api/mail/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || result.error || "同步失败");
    const incoming = result.messages.map((message) => ({ ...message, id: `MAIL-${message.uid}-${Date.now()}` }));
    // 已存在的 uid 用新同步结果覆盖（分类/公司/岗位提取以最新代码为准），新邮件追加
    const byUid = new Map((state.mail || []).map((m) => [`${m.uid}-${m.account || ""}`, m]));
    for (const msg of incoming) byUid.set(`${msg.uid}-${msg.account || ""}`, msg);
    state.mail = [...byUid.values()].slice(0, 100);
    saveState();
    renderAll();
    $("#mailSyncStatus").textContent = `刚刚同步 ${result.messages.length} 封，发现 ${result.messages.filter((message) => message.kind !== "普通邮件").length} 封招聘相关邮件`;
    showToast("邮件同步完成，请点击“写入流程”");
  } catch (error) {
    $("#mailSyncStatus").textContent = "同步失败";
    showToast(`同步失败：${error.message}`);
  } finally {
    $("#syncMailButton").disabled = false;
  }
}

async function syncNowclaw() {
  const button = $("#syncNowclawButton");
  button.disabled = true;
  $("#nowclawStatus").textContent = "正在读取 Nowclaw 工作区快照…";
  try {
    const response = await fetch("/api/nowclaw/sync");
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Nowclaw 同步失败");
    const incoming = result.jobs || [];
    incoming.forEach((incomingJob) => {
      const existing = state.jobs.find((job) => (incomingJob.sourceId && job.sourceId === incomingJob.sourceId) || (job.company === incomingJob.company && job.role === incomingJob.role));
      if (existing) {
        Object.assign(existing, {
          ...incomingJob,
          id: existing.id,
          attachments: existing.attachments || [],
          notes: existing.notes || [],
          events: existing.events || []
        });
      }
      else state.jobs.push(incomingJob);
    });
    saveState();
    renderAll();
    const source = result.dataPath && !result.dataPath.includes("未发现") ? `本地数据 ${result.dataPath}` : `工作区 ${result.workspace}`;
    $("#nowclawStatus").textContent = `已连接 Nowclaw：${result.count} 条岗位快照，来源 ${source}`;
    showToast("Nowclaw 岗位快照同步完成");
  } catch (error) {
    $("#nowclawStatus").textContent = `未连接：${error.message}`;
    showToast(`Nowclaw 同步失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

const practiceBank = {
  written: {
    "AI应用/Agent": [
      { prompt: "请说明 RAG 相比直接调用大语言模型的核心价值，并列出两个常见失败原因。", keywords: ["检索", "知识库", "幻觉"] },
      { prompt: "设计一个能调用搜索、数据库和计算器的 Agent，简述工具调用流程和异常处理。", keywords: ["工具", "规划", "异常"] },
      { prompt: "什么是向量数据库？它在语义检索中通常承担什么职责？", keywords: ["向量", "相似度", "检索"] }
    ],
    "Java后端": [
      { prompt: "解释数据库事务的 ACID，并举例说明隔离性不足可能造成的问题。", keywords: ["原子", "一致", "隔离", "持久"] },
      { prompt: "一个接口突然出现大量慢请求，你会按什么顺序定位问题？", keywords: ["日志", "监控", "数据库", "缓存"] },
      { prompt: "简述 Redis 缓存穿透、击穿和雪崩的区别及一种应对方式。", keywords: ["缓存", "空值", "锁", "过期"] }
    ],
    "C++/嵌入式": [
      { prompt: "C++ 中智能指针解决了什么问题？unique_ptr 和 shared_ptr 如何选择？", keywords: ["所有权", "析构", "引用计数"] },
      { prompt: "嵌入式设备出现偶发死机，你会收集哪些信息并如何缩小范围？", keywords: ["日志", "看门狗", "堆栈", "复现"] },
      { prompt: "解释 volatile 的作用，并说明它不能替代什么机制。", keywords: ["编译器", "可见", "原子", "同步"] }
    ],
    "通用校招": [
      { prompt: "请用三分钟介绍一个你最有代表性的项目，并说明你个人的贡献。", keywords: ["背景", "方案", "贡献", "结果"] },
      { prompt: "遇到时间紧、任务多且需求不清晰的情况，你会如何推进？", keywords: ["优先级", "沟通", "拆解", "交付"] },
      { prompt: "请说明一次你发现问题、承担责任并推动改进的经历。", keywords: ["问题", "行动", "结果", "复盘"] }
    ]
  },
  interview: {
    "AI应用/Agent": ["请介绍一个你做过的 AI 应用项目，以及为什么选择这个技术方案。", "如果模型回答质量不稳定，你会如何设计评测和迭代闭环？", "你如何理解 Agent 的边界？哪些任务不应该交给 Agent 自动执行？", "请讲一次你和他人协作解决技术分歧的经历。", "如果入职后需要快速熟悉一个陌生业务，你会怎么做？"],
    "Java后端": ["请介绍一个你负责过的后端模块，并说明你做过的关键取舍。", "线上接口延迟升高时，你会怎样组织排查和止损？", "你如何保证一个重要接口的可靠性和可观测性？", "请讲一次你和他人协作解决技术分歧的经历。", "如果入职后需要快速熟悉一个陌生业务，你会怎么做？"],
    "C++/嵌入式": ["请介绍一个你做过的 C++ 或嵌入式项目，以及最难的部分。", "如何判断一个问题来自硬件、驱动还是应用层？", "你在性能、稳定性和开发速度之间如何做取舍？", "请讲一次你和他人协作解决技术分歧的经历。", "如果入职后需要快速熟悉一个陌生业务，你会怎么做？"],
    "通用校招": ["请做一个简洁的自我介绍，并说明你正在寻找什么样的机会。", "请介绍一个最能体现你能力的项目或经历。", "你遇到过最大的挫折是什么？后来做了哪些调整？", "请讲一次你和他人协作解决技术分歧的经历。", "如果入职后需要快速熟悉一个陌生业务，你会怎么做？"]
  }
};

let practiceSession = null;
let practiceTimer = null;
let practiceMode = "written";

function practiceQuestions(mode, track) {
  return (practiceBank[mode][track] || practiceBank[mode]["通用校招"]).slice();
}

function formatPracticeTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function renderPractice() {
  const history = state.practiceHistory || [];
  const historyNode = $("#practiceHistory");
  if (historyNode) {
    historyNode.innerHTML = history.length
      ? `<div class="practice-history-heading">最近练习</div>${history.slice(0, 5).map((item) => `<div class="practice-history-item"><div><strong>${escapeHtml(item.mode === "written" ? "笔试模拟" : "面试模拟")}</strong><span>${escapeHtml(item.track)} · ${escapeHtml(item.finishedAt || "")}</span></div><div class="practice-history-result"><b>${item.mode === "written" ? `${item.score}%` : `${item.answered}/${item.total}`}</b>${item.mode === "written" && item.wrongQuestions?.length ? `<button type="button" class="small-button review-practice" data-id="${item.id}">错题复盘</button>` : ""}</div></div>`).join("")}`
      : `<div class="practice-history-heading">最近练习</div><p class="muted">提交一次模拟后，结果会保存在这里。</p>`;
    $$(".review-practice").forEach((button) => button.addEventListener("click", () => reviewPractice(button.dataset.id)));
  }
  renderNowcoderRecords();
  const sessionNode = $("#practiceSession");
  if (!sessionNode || !practiceSession) return;
  const question = practiceSession.questions[practiceSession.index];
  const answer = practiceSession.answers[practiceSession.index] || {};
  const isLast = practiceSession.index === practiceSession.questions.length - 1;
  const prompt = practiceMode === "written" ? question.prompt : question;
  sessionNode.innerHTML = `<div class="session-topline"><div><span class="eyebrow">${practiceMode === "written" ? "Written practice" : "Interview practice"}</span><h3>${escapeHtml(practiceSession.track)}</h3></div><strong class="practice-timer" id="practiceTimer">${formatPracticeTime(practiceSession.remaining)}</strong></div><div class="practice-progress"><span style="width:${Math.round(practiceSession.index / practiceSession.questions.length * 100)}%"></span></div><div class="question-count">第 ${practiceSession.index + 1} / ${practiceSession.questions.length} 题</div><div class="question-card"><h3>${escapeHtml(prompt)}</h3></div>${practiceMode === "written" ? `<label class="practice-answer-label">你的答案<textarea id="practiceAnswer" rows="9" placeholder="写下你的思路、关键步骤和结论...">${escapeHtml(answer.text || "")}</textarea></label><div class="practice-hint">建议覆盖：${escapeHtml(question.keywords.join("、"))}</div>` : `<label class="practice-answer-label">回答记录<textarea id="practiceAnswer" rows="6" placeholder="先按自己的方式回答，再用 STAR 复盘...">${escapeHtml(answer.text || "")}</textarea></label><div class="star-grid"><label>情境（Situation）<textarea id="practiceSituation" rows="3">${escapeHtml(answer.situation || "")}</textarea></label><label>任务（Task）<textarea id="practiceTask" rows="3">${escapeHtml(answer.task || "")}</textarea></label><label>行动（Action）<textarea id="practiceAction" rows="3">${escapeHtml(answer.action || "")}</textarea></label><label>结果（Result）<textarea id="practiceResult" rows="3">${escapeHtml(answer.result || "")}</textarea></label></div>`}<div class="session-actions"><button type="button" class="secondary-button" id="endPracticeButton">结束并放弃</button><button type="button" class="primary-button" id="nextPracticeButton">${isLast ? "提交模拟" : "保存并下一题"}</button></div>${practiceSession.feedback ? `<div class="practice-feedback"><h3>本次反馈</h3><p>${escapeHtml(practiceSession.feedback)}</p></div>` : ""}`;
  $("#practiceAnswer")?.addEventListener("input", saveCurrentPracticeAnswer);
  ["practiceSituation", "practiceTask", "practiceAction", "practiceResult"].forEach((id) => $(`#${id}`)?.addEventListener("input", saveCurrentPracticeAnswer));
  $("#nextPracticeButton")?.addEventListener("click", nextPracticeQuestion);
  $("#endPracticeButton")?.addEventListener("click", abandonPractice);
}

function reviewPractice(id) {
  const record = (state.practiceHistory || []).find((item) => item.id === id);
  const node = $("#practiceReview");
  if (!record || !node) return;
  node.innerHTML = `<div class="practice-review-heading"><div><span class="eyebrow">Error review</span><h3>错题复盘 · ${escapeHtml(record.track)}</h3></div><button type="button" class="small-button targeted-practice" data-id="${record.id}">针对错题再练</button></div>${record.wrongQuestions.map((question, index) => `<div class="review-question"><strong>${index + 1}. ${escapeHtml(question.prompt)}</strong><p>你的答案：${escapeHtml(question.answer || "未作答")}</p><small>建议关注：${escapeHtml(question.keywords.join("、"))}</small></div>`).join("")}`;
  $(".targeted-practice")?.addEventListener("click", () => startTargetedPractice(record));
}

function renderNowcoderRecords() {
  const node = $("#practiceReview");
  if (!node) return;
  const records = state.nowcoderRecords || [];
  const existingReview = node.querySelector(".review-question");
  const recordsHtml = records.length ? `<div class="nowcoder-records"><div class="practice-review-heading"><div><span class="eyebrow">Nowcoder history</span><h3>牛客刷题记录</h3></div><button type="button" class="small-button nowcoder-targeted-practice">错题专项练习</button></div>${records.slice(0, 8).map((record) => `<div class="nowcoder-record"><div><strong>${escapeHtml(record.track)}</strong><span>${escapeHtml(record.date)} · ${record.total || 0} 题${record.score !== "" && record.score != null ? ` · ${record.score} 分` : ""}</span>${record.mistakes ? `<p>${escapeHtml(record.mistakes)}</p>` : ""}</div>${record.preview ? `<img src="${record.preview}" alt="牛客刷题截图" />` : ""}</div>`).join("")}</div>` : "";
  if (!existingReview) node.innerHTML = recordsHtml;
  else node.insertAdjacentHTML("beforeend", recordsHtml);
  $(".nowcoder-targeted-practice")?.addEventListener("click", buildNowcoderTargetedPractice);
}

function openNowcoderModal() {
  $("#nowcoderDate").value = today();
  $("#nowcoderTrack").value = "";
  $("#nowcoderTotal").value = "";
  $("#nowcoderScore").value = "";
  $("#nowcoderMistakes").value = "";
  $("#nowcoderScreenshot").value = "";
  $("#nowcoderModal").showModal();
}

async function saveNowcoderRecord(event) {
  event.preventDefault();
  const file = $("#nowcoderScreenshot").files?.[0];
  const record = {
    id: `NOWCODER-${Date.now()}`,
    date: $("#nowcoderDate").value || today(),
    track: $("#nowcoderTrack").value.trim(),
    total: Number($("#nowcoderTotal").value || 0),
    score: $("#nowcoderScore").value === "" ? "" : Number($("#nowcoderScore").value),
    mistakes: $("#nowcoderMistakes").value.trim(),
    captureId: "",
    preview: ""
  };
  const finish = () => {
    state.nowcoderRecords = [record, ...(state.nowcoderRecords || [])].slice(0, 50);
    state.events.unshift({ date: record.date, type: "牛客刷题", title: `牛客 · ${record.track}`, detail: `完成 ${record.total || 0} 题${record.score === "" ? "" : `，得分 ${record.score}`}，错题已归档。` });
    saveState();
    $("#nowcoderModal").close();
    showToast("牛客刷题记录已保存");
  };
  if (file) {
    try {
      const uploaded = await uploadCapture(file);
      const promoted = await promoteCapture(uploaded.captureId);
      record.captureId = uploaded.captureId;
      record.preview = promoted?.url || uploaded.previewUrl || "";
    } catch (error) {
      console.error("Nowcoder screenshot upload failed:", error);
      showToast("截图保存失败，已保留文字记录");
    }
  }
  finish();
}

function buildNowcoderTargetedPractice() {
  const records = state.nowcoderRecords || [];
  const mistakes = records.flatMap((record) => record.mistakes ? record.mistakes.split(/\r?\n/).map((text) => text.trim()).filter(Boolean) : []);
  if (!mistakes.length) {
    showToast("请先在牛客记录中填写错题或错题原因");
    return;
  }
  const questions = mistakes.slice(0, 8).map((text) => ({ prompt: `针对错题复盘：${text}`, keywords: ["原因", "思路", "边界"] }));
  clearInterval(practiceTimer);
  practiceMode = "written";
  $$(".practice-tab").forEach((item) => item.classList.toggle("active", item.dataset.practiceMode === "written"));
  practiceSession = { mode: "written", track: "牛客错题专项", questions, index: 0, answers: [], remaining: Number($("#practiceDuration").value || 10) * 60 };
  practiceTimer = setInterval(() => {
    if (!practiceSession) return;
    practiceSession.remaining -= 1;
    if ($("#practiceTimer")) $("#practiceTimer").textContent = formatPracticeTime(practiceSession.remaining);
    if (practiceSession.remaining <= 0) submitPractice("时间到，已自动提交。");
  }, 1000);
  renderPractice();
  showToast("已根据牛客错题生成专项练习");
}

function startTargetedPractice(record) {
  const questions = record.wrongQuestions.map((item) => ({ prompt: item.prompt, keywords: item.keywords }));
  if (!questions.length) return;
  clearInterval(practiceTimer);
  practiceMode = "written";
  $$(".practice-tab").forEach((item) => item.classList.toggle("active", item.dataset.practiceMode === "written"));
  practiceSession = { mode: "written", track: `${record.track} · 错题专项`, questions, index: 0, answers: [], remaining: Number($("#practiceDuration").value || 10) * 60 };
  practiceTimer = setInterval(() => {
    if (!practiceSession) return;
    practiceSession.remaining -= 1;
    if ($("#practiceTimer")) $("#practiceTimer").textContent = formatPracticeTime(practiceSession.remaining);
    if (practiceSession.remaining <= 0) submitPractice("时间到，已自动提交。");
  }, 1000);
  renderPractice();
  showToast("已根据错题生成专项练习");
}

function startPractice() {
  clearInterval(practiceTimer);
  practiceMode = document.querySelector(".practice-tab.active")?.dataset.practiceMode || practiceMode;
  const track = $("#practiceTrack").value;
  practiceSession = { mode: practiceMode, track, questions: practiceQuestions(practiceMode, track), index: 0, answers: [], remaining: Number($("#practiceDuration").value || 10) * 60 };
  practiceTimer = setInterval(() => {
    if (!practiceSession) return;
    practiceSession.remaining -= 1;
    if ($("#practiceTimer")) $("#practiceTimer").textContent = formatPracticeTime(practiceSession.remaining);
    if (practiceSession.remaining <= 0) submitPractice("时间到，已自动提交。");
  }, 1000);
  renderPractice();
  showToast("模拟已开始，祝你发挥稳定");
}

function saveCurrentPracticeAnswer() {
  if (!practiceSession) return;
  practiceSession.answers[practiceSession.index] = {
    text: $("#practiceAnswer")?.value.trim() || "",
    situation: $("#practiceSituation")?.value.trim() || "",
    task: $("#practiceTask")?.value.trim() || "",
    action: $("#practiceAction")?.value.trim() || "",
    result: $("#practiceResult")?.value.trim() || ""
  };
}

function nextPracticeQuestion() {
  if (!practiceSession) return;
  saveCurrentPracticeAnswer();
  if (practiceSession.index < practiceSession.questions.length - 1) {
    practiceSession.index += 1;
    renderPractice();
  } else submitPractice();
}

function submitPractice(reason = "") {
  if (!practiceSession) return;
  saveCurrentPracticeAnswer();
  clearInterval(practiceTimer);
  const session = practiceSession;
  const answered = session.answers.filter((answer) => answer?.text || answer?.action || answer?.result).length;
  let score = 0;
  if (session.mode === "written") {
    score = Math.round(session.questions.reduce((total, question, index) => {
      const text = session.answers[index]?.text || "";
      return total + Math.min(100, Math.round(question.keywords.filter((keyword) => text.includes(keyword)).length / question.keywords.length * 100));
    }, 0) / session.questions.length);
  }
  const feedback = session.mode === "written"
    ? `${reason ? `${reason} ` : ""}共完成 ${answered}/${session.questions.length} 题，关键词覆盖度约 ${score}%。建议补充结构化表达、边界条件和实际例子。`
    : `${reason ? `${reason} ` : ""}共回答 ${answered}/${session.questions.length} 题。建议重点复盘是否讲清背景、个人行动和可量化结果。`;
  const wrongQuestions = session.mode === "written" ? session.questions.map((question, index) => {
    const answer = session.answers[index]?.text || "";
    const hits = question.keywords.filter((keyword) => answer.includes(keyword)).length;
    return hits < Math.ceil(question.keywords.length / 2) ? { prompt: question.prompt, keywords: question.keywords, answer } : null;
  }).filter(Boolean) : [];
  const record = { id: `PRACTICE-${Date.now()}`, mode: session.mode, track: session.track, score, answered, total: session.questions.length, finishedAt: today(), answers: session.answers, wrongQuestions, feedback };
  state.practiceHistory = [record, ...(state.practiceHistory || [])].slice(0, 30);
  state.events.unshift({ date: today(), type: "练习", title: `${session.track} · ${session.mode === "written" ? "笔试模拟" : "面试模拟"}`, detail: feedback });
  practiceSession = null;
  saveState();
  $("#practiceSession").innerHTML = `<div class="session-result"><span class="eyebrow">Session complete</span><h3>${session.mode === "written" ? `本次得分 ${score}%` : `已完成 ${answered}/${session.questions.length} 题`}</h3><p>${escapeHtml(feedback)}</p><button type="button" class="primary-button" id="restartPracticeButton">再来一次</button></div>`;
  $("#restartPracticeButton").addEventListener("click", startPractice);
  showToast("模拟结果已保存");
}

function abandonPractice() {
  clearInterval(practiceTimer);
  practiceSession = null;
  renderPractice();
  showToast("本次模拟已放弃，未写入历史");
}

initSelects();
state.mail = state.mail || [];
state.practiceHistory = state.practiceHistory || [];
state.nowcoderRecords = state.nowcoderRecords || [];
renderTodayLabel();
renderAll();
bootstrapState();
fetchAssets();
if ("Notification" in window && Notification.permission === "default") { Notification.requestPermission(); }

$$("[data-close-modal]").forEach((button) => button.addEventListener("click", () => {
  const modal = document.getElementById(button.dataset.closeModal);
  if (modal) modal.close();
}));

$$(".nav-item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
$$("[data-view-link]").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.viewLink)));
$("#addJobButton").addEventListener("click", () => openJobModal());
$("#jobForm").addEventListener("submit", saveJob);
$("#addTestButton").addEventListener("click", openTestModal);
$$(".practice-tab").forEach((button) => button.addEventListener("click", () => {
  practiceMode = button.dataset.practiceMode;
  $$(".practice-tab").forEach((item) => item.classList.toggle("active", item === button));
  if (!practiceSession) renderPractice();
}));
$("#startPracticeButton").addEventListener("click", startPractice);
$("#addNowcoderRecordButton").addEventListener("click", openNowcoderModal);
$("#nowcoderForm").addEventListener("submit", saveNowcoderRecord);
$("#testForm").addEventListener("submit", saveTest);
$("#syncMailButton").addEventListener("click", syncMail);
$("#organizeButton")?.addEventListener("click", runOrganizeNow);
$("#openPrefsButton")?.addEventListener("click", openPrefsModal);
$("#reFilterButton")?.addEventListener("click", runFilterNow);
$("#batchApplyButton")?.addEventListener("click", async () => {
  const ids = (state.recommendedJobs || []).filter((r) => r.applyStatus !== "已投递" && r.applyStatus !== "已忽略").map((r) => r.id);
  if (!ids.length) { showToast("没有待投递岗位"); return; }
  if (!window.confirm(`确认投递选中的 ${ids.length} 个岗位？系统将标记已投、写入管线并打开岗位链接。`)) return;
  await applyRecommended(ids);
});
$("#savePrefsButton")?.addEventListener("click", (event) => { event.preventDefault(); savePrefs(); $("#prefsModal").close(); });
$("#syncNowclawButton").addEventListener("click", syncNowclaw);
$("#refreshMaterialsButton").addEventListener("click", fetchAssets);
$$(".mail-preset").forEach((button) => button.addEventListener("click", () => { $("#mailHost").value = button.dataset.host; $("#mailPort").value = 993; }));
$("#pasteTextButton").addEventListener("click", () => { $("#captureText").value = ""; $("#textModal").showModal(); });
$("#textForm").addEventListener("submit", (event) => { event.preventDefault(); addCaptureText($("#captureText").value); $("#textModal").close(); });
$("#inboxForm").addEventListener("submit", confirmInbox);
$("#jobSearch").addEventListener("input", renderJobs);
$("#jobStatusFilter").addEventListener("change", renderJobs);
$("#screenshotInput").addEventListener("change", (event) => addFiles(event.target.files));
$("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("dragging"); });
$("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("dragging"));
$("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("dragging"); addFiles(event.dataTransfer.files); });
$("#petToggleButton").addEventListener("click", () => { $("#pet").hidden = !$("#pet").hidden; });
$("#petBody").addEventListener("click", () => {
  const hint = window.petHint || "overview";
  const tips = { tests: "带你去笔试测评跟进", inbox: "带你去待处理收件箱", jobs: "带你去岗位管线跟进", overview: "回到今日求职总览" };
  switchView(hint);
  showToast(tips[hint]);
});
$("#resetDataButton").addEventListener("click", () => {
  if (!window.confirm("恢复示例数据会清除当前本地记录，确定继续吗？")) return;
  state = structuredClone(seed);
  state.mail = [];
  saveState();
  showToast("示例数据已恢复");
});

// ===== 大脑助手（LLM） =====
async function brainRequest(action, payload) {
  try {
    const response = await fetch("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload })
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
function brainRender(html) { const el = $("#brainResult"); if (el) el.innerHTML = html; }
function brainCard(title, contentHtml) {
  return `<div class="brain-card"><div class="brain-card-title">${title}</div><div class="brain-card-body">${contentHtml}</div></div>`;
}
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function appendBrainChat(role, text) {
  const log = $("#brainChatLog");
  if (!log) return;
  const empty = log.querySelector(".empty-state");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "chat-msg " + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
async function brainAnalyzeMail() {
  brainRender('<div class="brain-loading">大脑分析邮件中…</div>');
  const mails = (state.mail || []).filter((m) => m.subject && !m.skipJob).slice(0, 4);
  if (!mails.length) { brainRender('<div class="empty-state">暂无待分析邮件。</div>'); return; }
  let html = "";
  for (const mail of mails) {
    const r = await brainRequest("classify_mail", { subject: mail.subject, from: mail.from || "", body: (mail.body || mail.text || "").slice(0, 1500) });
    if (!r.ok) { html += brainCard(esc(mail.subject), "分析失败：" + esc(r.error)); continue; }
    const res = r.result || {};
    html += brainCard(esc(mail.subject), `
      <div class="kv"><span>类别</span><strong>${esc(res.category || "?")}</strong></div>
      <div class="kv"><span>公司</span><strong>${esc(res.company || "?")}</strong></div>
      <div class="kv"><span>岗位</span><strong>${esc(res.role || "?")}</strong></div>
      <div class="kv"><span>标签</span><strong>${esc((res.tags || []).join(" / ") || "?")}</strong></div>
      <div class="kv"><span>紧急</span><strong>${res.urgent ? "是" : "否"}</strong></div>
      <p class="muted">${esc(res.reason || "")}</p>
      <button class="small-button brain-apply" data-kind="${esc(res.category || "其他")}" data-id="${esc(mail.id)}">采用此分类</button>`);
  }
  brainRender(html);
  document.querySelectorAll(".brain-apply").forEach((b) => b.addEventListener("click", () => {
    const mail = (state.mail || []).find((m) => String(m.id) === String(b.dataset.id));
    if (mail) { mail.kind = b.dataset.kind; saveState(); showToast("已采用 AI 分类"); brainRender(""); }
  }));
}
async function brainAnalyzeCapture() {
  brainRender('<div class="brain-loading">大脑判断截图归档中…</div>');
  const items = (state.inbox || []).filter((i) => (i.text || i.ocrText || i.preview)).slice(0, 4);
  if (!items.length) { brainRender('<div class="empty-state">收件箱暂无待归档截图记录。</div>'); return; }
  let html = "";
  for (const item of items) {
    const text = (item.text || item.ocrText || "").slice(0, 1200);
    if (!text) {
      html += brainCard("截图记录", "该截图没有 OCR 文本，大脑无法分析内容。请先在截图补录中识别出文字，再让大脑归档判断。");
      continue;
    }
    const r = await brainRequest("classify_capture", { text });
    if (!r.ok) { html += brainCard("截图分析", "分析失败：" + esc(r.error)); continue; }
    const res = r.result || {};
    html += brainCard((item.company || "截图记录") + (item.date ? "（" + item.date + "）" : ""), `
      <div class="kv"><span>归档类别</span><strong>${esc(res.category || "?")}</strong></div>
      <div class="kv"><span>公司</span><strong>${esc(res.company || "?")}</strong></div>
      <div class="kv"><span>岗位</span><strong>${esc(res.role || "?")}</strong></div>
      <div class="kv"><span>建议状态</span><strong>${esc(res.status || "?")}</strong></div>
      <div class="kv"><span>关键日期</span><strong>${esc(res.date || "?")}</strong></div>
      <p class="muted">${esc(res.summary || "")}</p>`);
  }
  brainRender(html);
}
async function brainFlowSuggest() {
  brainRender('<div class="brain-loading">大脑分析流程中…</div>');
  const stale = (state.jobs || []).filter((j) => j.status === "已投递" || j.status === "沟通中").slice(0, 5);
  if (!stale.length) { brainRender('<div class="empty-state">暂无已投递/沟通中岗位。</div>'); return; }
  let html = "";
  for (const job of stale) {
    const r = await brainRequest("flow_suggest", { status: job.status, next: job.next || "", company: job.company, role: job.role, notes: "" });
    if (!r.ok) { html += brainCard(esc(job.company), "分析失败：" + esc(r.error)); continue; }
    const res = r.result || {};
    html += brainCard(esc(job.company) + " · " + esc(job.role), `
      <div class="kv"><span>建议状态</span><strong>${esc(res.suggestedStatus || "?")}</strong></div>
      <div class="kv"><span>下一步</span><strong>${esc(res.nextAction || "?")}</strong></div>
      <p class="muted">${esc(res.reason || "")}</p>`);
  }
  brainRender(html);
}
async function brainRecommend() {
  brainRender('<div class="brain-loading">大脑匹配岗位中…</div>');
  const profile = "林云霞：重庆师范大学智能科学与技术本科27届（专业前5%），熟悉Python、RAG检索增强生成、多智能体协同系统（自研MCP）、OpenCV视觉检测、AI应用开发；项目：药品RAG问答系统、自适应刷题多智能体系统、一体化智能仓储巡航小车；CRAIC机器人竞技赛国家级三等奖。求职方向：AI应用开发/Agent/大模型应用。";
  const jobs = (state.recommendedJobs || []).filter((j) => j.applyStatus !== "已投递").slice(0, 12).map((j) => ({ id: j.id, company: j.company, role: j.role, reason: j.reason || "" }));
  if (!jobs.length) { brainRender('<div class="empty-state">暂无未投递的推荐岗位。</div>'); return; }
  const r = await brainRequest("recommend_jobs", { profile, jobs });
  if (!r.ok) { brainRender('<div class="empty-state">分析失败：' + esc(r.error) + "</div>"); return; }
  const res = r.result || {};
  const matches = res.matches || [];
  let html = '<p class="muted">' + esc(res.summary || "") + "</p>";
  html += matches.map((m) => {
    const job = jobs.find((j) => String(j.id) === String(m.id));
    return brainCard(job ? job.company + " · " + job.role : "岗位 " + m.id, '<div class="kv"><span>匹配度</span><strong>' + esc(m.score) + "</strong></div><p class=\"muted\">" + esc(m.reason || "") + "</p>");
  }).join("");
  brainRender(html || '<div class="empty-state">暂无匹配结果。</div>');
}
async function brainChat(question) {
  if (!question.trim()) return;
  appendBrainChat("user", question);
  appendBrainChat("brain", "思考中…");
  const allJobs = state.jobs || [];
  const urgent = allJobs.filter((j) => j.status === "一面" || j.status === "二面" || (j.next || "").includes("面试"));
  const stats = {};
  allJobs.forEach((j) => { stats[j.status] = (stats[j.status] || 0) + 1; });
  const statText = Object.entries(stats).map((kv) => kv[0] + " " + kv[1] + " 个").join("，");
  const pendingInbox = (state.inbox || []).filter((i) => i.status === "待确认" || i.status === "pending").length;
  const unfinishedTests = (state.tests || []).filter((t) => t.status === "待完成" || t.status === "未完成").length;
  const recent = (state.events || []).slice(0, 3).map((e) => (e.date || "") + " " + (e.title || "")).join("；");
  const context = "【进行中面试】" + (urgent.map((j) => j.company + " " + j.role + " " + j.status + " " + (j.next || "")).join("；") || "无") + "。【岗位概况】共" + allJobs.length + "个：" + (statText || "无") + "。【待办】待确认截图 " + pendingInbox + " 条，未完成笔试 " + unfinishedTests + " 个。【最近动态】" + (recent || "无") + "。";
  const r = await brainRequest("chat", { question, context });
  const log = $("#brainChatLog");
  const last = log ? log.lastElementChild : null;
  if (last && last.classList.contains("brain")) last.remove();
  appendBrainChat("brain", r.ok ? (r.result.text || r.result.raw || "（无回复）") : "出错了：" + r.error);
}
$("#brainMailBtn")?.addEventListener("click", brainAnalyzeMail);
$("#brainCaptureBtn")?.addEventListener("click", brainAnalyzeCapture);
$("#brainFlowBtn")?.addEventListener("click", brainFlowSuggest);
$("#brainRecommendBtn")?.addEventListener("click", brainRecommend);
$("#brainSendBtn")?.addEventListener("click", () => { const q = $("#brainQuestion"); brainChat(q.value); q.value = ""; });
$("#brainQuestion")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { const q = $("#brainQuestion"); brainChat(q.value); q.value = ""; } });
// ===== 桌宠气泡点击跳转（?v= 参数） =====
(function () {
  const v = new URLSearchParams(location.search).get("v");
  const views = ["overview", "jobs", "inbox", "tests", "practice", "mail", "materials", "timeline", "brain"];
  if (v && views.includes(v)) switchView(v);
})();