const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;
const net = require("net");
const ipaddr = require("ipaddr.js");
const express = require("express");
const multer = require("multer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createWorker } = require("tesseract.js");
const chiSim = require("@tesseract.js-data/chi_sim");
const organize = require("./organize");
const filter = require("./filter");

const app = express();
const port = process.env.PORT || 4173;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const dataRoot = path.resolve(process.env.CAREER_DATA_DIR || path.join(__dirname, "data"));
const longTermRoot = path.join(dataRoot, "长期记忆");
const shortTermRoot = path.join(dataRoot, "短期记忆");
const longTermAttachments = path.join(longTermRoot, "attachments");
const shortTermCaptures = path.join(shortTermRoot, "captures");
const materialsRoot = path.resolve(__dirname, "..", "简历资料");
const materialsIgnoreParts = ["Backend_Engineering做题", ".git", ".agents", ".codex", "node_modules", "__pycache__"];
const stateBundleFile = path.join(longTermRoot, "state.json");
const stateFiles = {
  jobs: path.join(longTermRoot, "jobs.json"),
  tests: path.join(longTermRoot, "tests.json"),
  events: path.join(longTermRoot, "events.json"),
  practiceHistory: path.join(longTermRoot, "practice-history.json"),
  nowcoderRecords: path.join(longTermRoot, "nowcoder-records.json"),
  recommendedJobs: path.join(longTermRoot, "recommended-jobs.json"),
  archivedInbox: path.join(longTermRoot, "archived-captures.json"),
  archivedMail: path.join(longTermRoot, "archived-mail.json"),
  inbox: path.join(shortTermRoot, "inbox.json"),
  mail: path.join(shortTermRoot, "mail.json")
};
let workerPromise;
let stateWriteQueue = Promise.resolve();

for (const directory of [dataRoot, longTermRoot, shortTermRoot, longTermAttachments, shortTermCaptures]) {
  fs.mkdirSync(directory, { recursive: true });
}

app.use(express.json({ limit: "8mb" }));

// ---- 访问密码保护（设置 APP_PASSWORD 环境变量后启用；未设置则放行，兼容本地开发）----
const crypto = require("crypto");
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_COOKIE = "qz_auth";
const authDigest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const AUTH_DIGEST = authDigest(APP_PASSWORD);

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const cookies = readCookies(req);
  if (cookies[AUTH_COOKIE] === AUTH_DIGEST) return true;
  const pwd = req.query.pwd || req.headers["x-app-pwd"];
  return !!pwd && authDigest(pwd) === AUTH_DIGEST;
}

const loginPage = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>求职智能体 · 访问验证</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e2e8f0}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px 36px;width:min(360px,88vw);box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 6px}
p{color:#94a3b8;font-size:13px;margin:0 0 22px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:15px;outline:none}
input:focus{border-color:#38bdf8}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#38bdf8;color:#0f172a;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#0ea5e9}
.err{color:#f87171;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body><div class="card"><h1>求职智能体</h1><p>请输入访问密码</p><form id="f"><input id="p" type="password" placeholder="访问密码" autocomplete="current-password"><button type="submit">进入</button><div class="err" id="e"></div></form></div><script>
var f=document.getElementById("f"),p=document.getElementById("p"),e=document.getElementById("e");
f.addEventListener("submit",function(ev){ev.preventDefault();e.textContent="";
fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p.value})})
.then(function(r){if(r.ok){location.reload()}else{return r.json().catch(function(){return {};}).then(function(j){e.textContent=j.error||"密码错误";});}})
.catch(function(){e.textContent="请求失败，请重试";});});
</script></body></html>`;

app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const path = req.path;
  if (path === "/api/login" || path === "/api/logout") return next();
  if (isAuthed(req)) return next();
  if (path.startsWith("/api/")) return res.status(401).json({ error: "需要访问密码" });
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(loginPage);
});

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD || authDigest(password) === AUTH_DIGEST) {
    res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${AUTH_DIGEST}; Path=/; HttpOnly; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "密码错误" });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

const defaultState = {
  jobs: [],
  tests: [],
  practiceHistory: [],
  nowcoderRecords: [],
  recommendedJobs: [],
  archivedInbox: [],
  archivedMail: [],
  inbox: [],
  mail: [],
  events: []
};

function readJson(file, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(temporary, payload, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readState() {
  let bundled = null;
  if (fs.existsSync(stateBundleFile)) {
    try {
      bundled = JSON.parse(fs.readFileSync(stateBundleFile, "utf8"));
    } catch (error) {
      console.error("State bundle is invalid; falling back to legacy files:", error.message);
    }
  }
  const state = bundled && typeof bundled === "object"
    ? { ...defaultState, ...bundled }
    : Object.fromEntries(Object.entries(stateFiles).map(([key, file]) => [key, readJson(file, defaultState[key])]));
  state.inbox = [...(state.archivedInbox || []), ...(state.inbox || [])];
  state.mail = [...(state.archivedMail || []), ...(state.mail || [])];
  delete state.archivedInbox;
  delete state.archivedMail;
  return state;
}

function writeState(nextState = {}) {
  const current = readState();
  const merged = { ...current };
  for (const [key, value] of Object.entries(nextState)) {
    if (!["archivedInbox", "archivedMail"].includes(key) && Object.hasOwn(stateFiles, key) && Array.isArray(value)) merged[key] = value;
  }
  const archived = merged.inbox.filter((item) => item.storage === "long-term" || item.status === "已归档");
  const pending = merged.inbox.filter((item) => !archived.includes(item));
  const archivedMail = merged.mail.filter((item) => item.storage === "long-term" || item.status === "已写入");
  const pendingMail = merged.mail.filter((item) => !archivedMail.includes(item));
  const persisted = { ...merged, archivedInbox: archived, inbox: pending, archivedMail, mail: pendingMail };
  writeJson(stateBundleFile, persisted);
  return { ...merged, inbox: [...archived, ...pending], mail: [...archivedMail, ...pendingMail] };
}

function isPrivateAddress(address) {
  try {
    const parsed = ipaddr.parse(String(address).replace(/^\[|\]$/g, ""));
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      return isPrivateAddress(parsed.toIPv4Address().toString());
    }
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}

async function resolvePublicMailHost(host) {
  if (typeof host !== "string" || !host.trim() || /[\s/\\@]/.test(host)) return null;
  const normalized = host.trim().replace(/^\[|\]$/g, "");
  if (net.isIP(normalized)) return isPrivateAddress(normalized) ? null : { address: normalized, family: net.isIP(normalized), servername: undefined };
  try {
    const addresses = await dns.lookup(normalized, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return null;
    return { ...addresses[0], servername: normalized };
  } catch {
    return null;
  }
}

function captureExtension(mimetype = "") {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" })[mimetype] || ".bin";
}

function capturePath(id, root) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return "";
  const files = fs.readdirSync(root).filter((name) => name.startsWith(`${id}.`));
  return files.length ? path.join(root, files[0]) : "";
}

function saveCapture(file) {
  if (!file) throw new Error("missing image");
  if (!file.mimetype.startsWith("image/")) throw new Error("unsupported_image_type");
  const captureId = `CAPTURE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const captureFile = path.join(shortTermCaptures, `${captureId}${captureExtension(file.mimetype)}`);
  fs.writeFileSync(captureFile, file.buffer);
  return { captureId, previewUrl: `/api/captures/${captureId}` };
}

async function getWorker() {
  if (!workerPromise) {
    // 中文模型已随 npm 依赖安装到本地；中文模型也能识别常见英文、数字和链接。
    workerPromise = createWorker("chi_sim", 1, {
      langPath: chiSim.langPath,
      gzip: true,
      logger: (message) => {
        if (message.status === "recognizing text") {
          process.stdout.write(`\rOCR ${Math.round((message.progress || 0) * 100)}%`);
        }
      }
    });
  }
  return workerPromise;
}

app.use((req, res, next) => {
  if (req.path === "/data" || req.path.startsWith("/data/")) return res.status(404).end();
  next();
});
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(__dirname));
if (fs.existsSync(materialsRoot)) {
  app.use("/materials", express.static(materialsRoot, { fallthrough: true }));
}

function guessMaterialUse(name) {
  const rules = [
    ["AI应用开发", "AI应用/Agent/大模型岗位"],
    ["AI应用", "AI应用/大模型岗位"],
    ["NLP", "NLP/算法岗位"],
    ["Java", "Java后端/Web开发岗位"],
    ["java", "Java后端/Web开发岗位"],
    ["C++", "C++/嵌入式/算法部署岗位"],
    ["杭州银行", "银行信息科技岗位"],
    ["德勤", "咨询/大模型应用岗位"],
    ["诚迈", "影像系统/外包驻场材料"],
    ["作品集", "随简历补充项目材料"],
    ["项目集", "随简历补充项目材料"],
    ["成绩单", "网申附件"],
    ["获奖", "网申附件"]
  ];
  for (const [key, value] of rules) if (name.includes(key)) return value;
  return "";
}

function categorizeMaterial(name, rel) {
  if (name.includes("成绩单")) return "成绩单";
  if (name.includes("作品集") || name.includes("项目集")) return "作品集";
  if (name.includes("获奖")) return "获奖证明";
  if (name.includes("简历") || name.toLowerCase().endsWith(".docx")) return "简历/文案";
  return "资料";
}

app.get("/api/assets", (req, res) => {
  if (!fs.existsSync(materialsRoot)) return res.json({ root: materialsRoot, exists: false, assets: [] });
  const assets = [];
  for (const pattern of ["*.pdf", "*.docx", "*.png", "*.jpg", "*.jpeg"]) {
    for (const file of fs.readdirSync(materialsRoot, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(pattern.slice(1))) continue;
      const relParts = file.path.split(path.sep).slice(materialsRoot.split(path.sep).length);
      if (relParts.some((part) => materialsIgnoreParts.includes(part))) continue;
      const rel = [...relParts, file.name].join("/");
      const full = path.join(file.path, file.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      assets.push({
        name: file.name,
        category: categorizeMaterial(file.name, rel),
        use: guessMaterialUse(file.name),
        modified: stat.mtime.toISOString().slice(0, 10),
        sizeKB: Math.round(stat.size / 1024),
        url: `/materials/${rel.split("/").map(encodeURIComponent).join("/")}`,
        path: rel
      });
    }
  }
  assets.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  res.json({ root: materialsRoot, exists: true, count: assets.length, assets });
});

app.get("/api/state", (req, res) => {
  const hasData = fs.existsSync(stateBundleFile) || Object.values(stateFiles).some((file) => fs.existsSync(file));
  res.json({ hasData, state: readState() });
});

app.put("/api/state", (req, res) => {
  stateWriteQueue = stateWriteQueue.then(() => {
    const saved = writeState(req.body || {});
    res.json({ ok: true, state: saved });
  }).catch((error) => {
    console.error("State save failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "state_save_failed", detail: error.message });
  });
});

app.get("/api/captures/:id", (req, res) => {
  const file = capturePath(req.params.id, shortTermCaptures) || capturePath(req.params.id, longTermAttachments);
  if (!file) return res.status(404).end();
  const contentTypes = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
  res.type(contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream");
  const stream = fs.createReadStream(file);
  stream.on("error", (error) => {
    console.error("Capture read failed:", error);
    if (!res.headersSent) res.status(404).end();
    else res.destroy(error);
  });
  stream.pipe(res);
});

app.post("/api/captures/:id/promote", (req, res) => {
  const source = capturePath(req.params.id, shortTermCaptures);
  if (!source) {
    const existing = capturePath(req.params.id, longTermAttachments);
    return existing ? res.json({ ok: true, url: `/api/captures/${req.params.id}` }) : res.status(404).json({ error: "capture_not_found" });
  }
  const target = path.join(longTermAttachments, path.basename(source));
  fs.renameSync(source, target);
  res.json({ ok: true, url: `/api/captures/${req.params.id}` });
});

app.post("/api/captures", upload.single("image"), (req, res) => {
  try {
    res.json(saveCapture(req.file));
  } catch (error) {
    res.status(error.message === "missing image" ? 400 : 415).json({ error: error.message });
  }
});

app.post("/api/ocr", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing image" });
  if (!req.file.mimetype.startsWith("image/")) return res.status(415).json({ error: "unsupported_image_type" });
  const { captureId, previewUrl } = saveCapture(req.file);
  try {
    const worker = await getWorker();
    const result = await worker.recognize(req.file.buffer);
    process.stdout.write("\n");
    res.json({ text: result.data.text || "", captureId, previewUrl });
  } catch (error) {
    console.error("\nOCR failed:", error);
    res.status(422).json({ error: "ocr_failed", detail: error.message, text: "", captureId, previewUrl });
  }
});

// ---- 邮箱配置（用于每日自动同步，本地明文存储）----
const mailConfigFile = path.join(shortTermRoot, "mail-config.json");
function loadMailConfig() {
  try { return JSON.parse(fs.readFileSync(mailConfigFile, "utf-8")); } catch { return null; }
}
function saveMailConfig(config) {
  fs.writeFileSync(mailConfigFile, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

// ---- IMAP 同步核心（手动接口与每日定时共用）----
async function syncMailbox(config) {
  const { user, password, host, port = 993, mailbox = "INBOX", days = 30 } = config || {};
  if (!user || !password || !host) throw Object.assign(new Error("missing_mail_config"), { code: 400 });
  const numericPort = Number(port);
  const numericDays = Number(days);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw Object.assign(new Error("invalid_mail_port"), { code: 400 });
  if (!Number.isFinite(numericDays) || numericDays < 1 || numericDays > 365) throw Object.assign(new Error("invalid_mail_days"), { code: 400 });
  const resolvedHost = await resolvePublicMailHost(host);
  if (!resolvedHost) throw Object.assign(new Error("invalid_or_private_mail_host"), { code: 400 });
  const client = new ImapFlow({
    host: resolvedHost.address,
    servername: resolvedHost.servername,
    port: numericPort,
    secure: numericPort === 993,
    auth: { user, pass: password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
  // 连接失败/超时时 ImapFlow 会 emit 'error'，必须消费该事件，否则进程崩溃（每日定时同步尤其危险）
  client.on("error", () => {});
  const since = new Date(Date.now() - numericDays * 24 * 60 * 60 * 1000);
  const messages = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = await client.search({ since });
      const recent = uids.slice(-300);
      // 两阶段：先读信封按关键词过滤，再解析正文，避免被大量营销邮件拖慢
      const recruitRe = /招聘|笔试|测评|面试|offer|OFFER|录用|邀请|投递|简历|校招|实习|测试|性格|网申|宣讲|双选|复试|考核|管培|内推|岗位|职位|秋招|春招|空中|报名|申请|机试|答题|在线考试|遗憾|未通过|已通过|诚邀|邀您|回执|确认|通知|感谢/;
      const wanted = [];
      for await (const msg of client.fetch(recent, { uid: true, envelope: true })) {
        if (recruitRe.test(msg.envelope?.subject || "")) wanted.push(msg.uid);
      }
      for await (const msg of client.fetch(wanted, { uid: true, envelope: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        const body = parsed.text || stripHtml(parsed.html || "") || "";
        const text = `${parsed.subject || ""}\n${body}`.slice(0, 12000);
        const classified = classifyMail(text, parsed);
        if (classified.kind === "普通邮件") continue;
        messages.push({
          account: user,
          uid: msg.uid,
          subject: parsed.subject || "",
          from: parsed.from?.text || msg.envelope?.from?.map((item) => item.address).join(", ") || "",
          date: (parsed.date || msg.envelope?.date || new Date()).toISOString(),
          preview: normalizeText(body).slice(0, 240),
          link: firstUrl(text),
          ...classified
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return messages;
  } catch (error) {
    try { await client.logout(); } catch {}
    throw error;
  }
}

app.post("/api/mail/sync", async (req, res) => {
  try {
    const messages = await syncMailbox(req.body || {});
    let autoReport = null;
    try {
      autoReport = organize.runOrganize({ ingestMessages: messages });
    } catch (e) {
      console.error("Auto organize after mail sync failed:", e);
    }
    res.json({ messages, autoOrganized: autoReport });
  } catch (error) {
    if (error.code === 400) return res.status(400).json({ error: error.message });
    console.error("Mail sync failed:", error);
    const detail = /AUTH|invalid credentials|authentication|login/i.test(error.message)
      ? "邮箱认证失败：请确认已开启 IMAP，并使用最新授权码，不要使用 QQ 登录密码。"
      : /ENOTFOUND|ECONNREFUSED|timeout|自签名|certificate/i.test(error.message)
        ? "无法连接 IMAP 服务器：请检查服务器地址、端口和网络。QQ 邮箱通常使用 imap.qq.com:993。"
        : error.message;
    res.status(500).json({ error: "mail_sync_failed", detail });
  }
});

app.get("/api/mail/config", (req, res) => {
  const cfg = loadMailConfig();
  res.json({ configured: !!(cfg && cfg.password), config: cfg ? { user: cfg.user, host: cfg.host, port: cfg.port, mailbox: cfg.mailbox, days: cfg.days, password: cfg.password ? "已保存" : "" } : null });
});

app.post("/api/mail/config", (req, res) => {
  const body = req.body || {};
  const prev = loadMailConfig() || {};
  if (!body.user || !body.host) return res.status(400).json({ error: "missing_mail_config" });
  const saved = saveMailConfig({
    user: body.user,
    host: body.host,
    port: Number(body.port) || 993,
    mailbox: body.mailbox || "INBOX",
    days: Number(body.days) || 30,
    password: body.password || prev.password || ""
  });
  res.json({ ok: true, config: { ...saved, password: saved.password ? "已保存" : "" } });
});

// ---- 每日自动同步（默认 08:00；启动时若已过点则补跑一次，防重复）----
function scheduleDailyMailSync(hour = 8, minute = 0) {
  let lastRunDate = "";
  const runOnce = async () => {
    const cfg = loadMailConfig();
    if (!cfg || !cfg.password) { console.log("每日邮件同步：未配置邮箱授权码，跳过"); return; }
    try {
      console.log("每日邮件同步开始:", new Date().toLocaleString());
      const messages = await syncMailbox(cfg);
      let autoReport = null;
      try { autoReport = organize.runOrganize({ ingestMessages: messages }); } catch (e) { console.error("每日自动整理失败:", e); }
      console.log(`每日邮件同步完成: ${messages.length} 封招聘邮件, 自动整理改动 ${autoReport ? autoReport.changed : 0} 项`);
    } catch (e) {
      console.error("每日邮件同步失败:", e.message);
    }
  };
  const check = async () => {
    const now = new Date();
    const today = now.toDateString();
    if (lastRunDate === today) return;
    if (now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)) {
      lastRunDate = today;
      await runOnce();
    }
  };
  check();
  setInterval(check, 60_000);
}


app.get("/api/nowclaw/sync", async (req, res) => {
  const workspace = path.resolve(__dirname, "..", "简历资料", "Nowclaw");
  const snapshotDir = path.join(workspace, "岗位快照");
  const installedCandidates = [
    "D:\\Users\\不夙\\AppData\\Local\\Programs\\nowclaw",
    "C:\\Users\\busu\\AppData\\Local\\Programs\\nowclaw",
    "C:\\Users\\busu\\AppData\\Local\\nowclaw",
    "C:\\Users\\不夙\\AppData\\Local\\Programs\\nowclaw"
  ];
  const installedPath = installedCandidates.find((candidate) => fs.existsSync(candidate)) || "";
  const dataCandidates = [
    "C:\\Users\\busu\\AppData\\Roaming\\nowclaw",
    "C:\\Users\\不夙\\AppData\\Roaming\\nowclaw",
    "D:\\Users\\不夙\\AppData\\Roaming\\nowclaw"
  ];
  const dataPath = dataCandidates.find((candidate) => fs.existsSync(candidate)) || "";
  if (!fs.existsSync(snapshotDir)) {
    return res.status(404).json({ error: "nowclaw_workspace_missing", detail: "未找到 Nowclaw 工作区岗位快照目录" });
  }
  const jobs = fs.readdirSync(snapshotDir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name, index) => parseNowclawSnapshot(path.join(snapshotDir, name), index))
    .filter(Boolean);
  res.json({
    connected: Boolean(installedPath || dataPath),
    installedPath: installedPath || "未发现安装目录；已连接 Nowclaw 工作区导出",
    dataPath: dataPath || "未发现 Nowclaw 本地数据目录",
    workspace,
    count: jobs.length,
    jobs
  });
});

function parseNowclawSnapshot(file, index) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const title = (text.match(/^# (.+)$/m) || [null, path.basename(file, ".md")])[1];
    const [company = "", role = title] = title.split(" · ");
    const value = (label) => ((text.match(new RegExp(`^- ${label}[：:]\\s*(.+)$`, "m")) || [null, ""])[1]).trim();
    const front = (key) => ((text.match(new RegExp(`^${key}:\\s*(.+)$`, "m")) || [null, ""])[1]).trim();
    return {
      id: `NC-SYNC-${index + 1}`,
      sourceId: front("nowclaw_id"),
      source: `Nowclaw/${value("来源") || "workspace"}`,
      company,
      role,
      channel: value("来源").includes("beisen") ? "北森" : value("来源").includes("moka") ? "Moka" : "Nowclaw",
      status: value("当前阶段") || (front("phase") === "submitted" ? "已投递" : "准备投递"),
      location: value("工作地点"),
      updated: (front("updated_at") || "").slice(0, 10),
      link: value("岗位链接"),
      next: value("当前阶段") === "已投递" ? "关注后续通知" : "确认简历版本并投递",
      attachments: []
    };
  } catch {
    return null;
  }
}

function isMarketingPush(text) {
  return /智联推荐|智联招聘|前程无忧|51job|校招空宣|空中宣讲会|宣讲会|校招启动|秋招启动|火热进行中|邀你同行|邀您收看|抢先拿offer|抢面试先机|解锁|点击查看>>|空宣直播|校招岗位邀请函|有奖|内测|百分百中奖|免费领取|专属好礼|抽奖|更多信息请登录|完整体验|职悟空|关注微信公众号|重要消息不错过|\(AD\)|岗位推荐|职位推荐|急招职位|待领取|礼包|试用|trial|优惠|off |limited time|待查收|方便聊聊吗|国企公司|开出薪资|相似.*急招|经历很亮眼|RealVNC|popular features|平台为您推荐|点击投递拿offer|投递拿offer|已上市\s*\d+\s*人以上|现在沟通，抢|相似的急招职位|履历不错|方便聊聊吗|打招呼|正在热招|岗位急招|HR.*留言|等你来投递|欢迎投递简历至/.test(text);
}

function classifyMail(text, parsed) {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const subject = normalizeText(parsed.subject || "");
  // 邮箱服务商/平台系统邮件与退信：与求职无关，直接归档不建岗位
  const systemMail = /QQ邮箱团队|QQ邮箱APP|腾讯邮箱|网易邮箱|163邮箱|126邮箱|新浪邮箱|Microsoft|outlook|icloud|iCloud|邮箱APP|邮箱大师|退信|投递失败|邮件投递|系统通知|安全提醒|登录提醒|账号安全|已成功登录|服务条款|隐私政策|会员中心|容量提醒|垃圾邮件|垃圾箱|收件箱容量|异地登录|修改密码|绑定邮箱成功|邮箱绑定|邮件存储|防骚扰|举报垃圾邮件/;
  if (systemMail.test(normalized) || systemMail.test(subject)) return { kind: "系统通知", status: "已归档", labels: ["系统通知"], company: "", role: "" };
  const recruiting = /招聘|应聘|投递|简历|岗位|职位|校招|实习|笔试|测评|面试|offer|录用|很遗憾|未通过|内推|网申|宣讲|测试|性格|邀请|双选|秋招|春招|复试|考核|管培/.test(normalized);
  if (!recruiting) return { kind: "普通邮件", status: "待确认", labels: [] };

  // 强营销模板（BOSS/智联推荐卡片特征词）：出现即营销推送，不受标题流程词影响（避免"投递拿offer"标题命中 offer 绕过拦截）
  const hardMarketing = /点击投递拿offer|投递拿offer|已上市\s*\d+\s*人以上|现在沟通，抢|相似的急招职位|履历不错|方便聊聊吗|打招呼|抢面试先机|抢先拿offer|岗位推荐，点击投递|岗位推荐|职位推荐，立即投递/;
  if (hardMarketing.test(normalized)) {
    const labels = [];
    if (/投递邀请|网申邀请|岗位邀请|投递候选人|推荐你为|急招/.test(normalized)) labels.push("邀请投递");
    return { kind: "营销推送", status: "待确认", labels, company: guessCompany(normalized, subject, parsed), role: guessRole(normalized, subject), deadline: "" };
  }
  // 标题含明确流程特征（复试/考核/笔试邀请/测试题/投递成功/录用等）时优先按真实流程分类，即使正文带广告词
  const subjectFlow = /复试|考核通知|笔试邀请|在线笔试|测试题|机试|测评邀请|测评链接|面试预约|面试邀请函|面试通知|投递成功|申请成功|录用|意向书|offer|简历信息完善邀请|更新简历邀请|完善简历信息|完善简历|测试结果/;
  const isFlowMail = subjectFlow.test(subject);

  // 智联/前程无忧等平台营销推送（标题无明显流程特征时）拦截：统一标"营销推送"，前端不建岗位；邀请字样只作标签
  if (!isFlowMail && isMarketingPush(normalized)) {
    const labels = [];
    if (/投递邀请|网申邀请|岗位邀请|投递候选人|推荐你为|急招/.test(normalized)) labels.push("邀请投递");
    return { kind: "营销推送", status: "待确认", labels, company: guessCompany(normalized, subject, parsed), role: guessRole(normalized, subject), deadline: "" };
  }

  const labels = [];
  const realInterview = /面试邀请|面试预约|面试通知|面试安排|线上面试|视频面试|腾讯会议|会议号|zoom|飞书会议|钉钉会议|面试时间|复试|一面|二面|终面|面谈|面试详情|面试环节|复试考核/;
  if (realInterview.test(normalized)) {
    if (/AI面试|ai 面试|智能面试|ai interview/.test(lower)) labels.push("AI面试");
    if (/腾讯会议|会议号|视频面试|线上会议|zoom|teams|飞书会议|钉钉会议/.test(lower)) labels.push("线上会议面试");
    if (/线下面试|现场面试|到面|面试地点/.test(lower)) labels.push("线下面试");
  }
  if (/投递邀请|网申邀请|投递候选人|推荐你为/.test(normalized)) labels.push("邀请投递");
  if (/简历(信息)?完善邀请|更新简历邀请|简历完善|完善简历|补充简历信息|完善个人资料/.test(normalized)) {
    labels.push("简历完善邀请");
    if (!labels.includes("邀请投递")) labels.push("邀请投递");
  }
  if (/投递成功|申请成功|已收到|感谢投递|简历已收到|申请已提交|投递完成|已成功投递/.test(normalized)) labels.push("投递成功");
  if (/技术测试|编程测试|在线编程|代码测试|算法题|编程题|hackerrank|coderbyte|牛客笔试|机试|测试题结果/.test(lower)) labels.push("技术测试");
  if (/性格测试|人格测试|心理测试|职业性格|MBTI|胜任力测评/.test(lower)) labels.push("性格测试");

  let kind = "招聘邮件";
  let status = "待确认";
  const testSignals = /笔试|机试|在线测评|测评邀请|测评链接|人才测评|测试题|答题|作答|在线考试|考试邀请|笔试邀请|性格测试|技术测试|测试结果/;
  const resumeComplete = /简历(信息)?完善邀请|更新简历邀请|简历完善|完善简历|补充简历信息|完善个人资料/;
  if ((testSignals.test(subject) && !resumeComplete.test(subject)) || (testSignals.test(normalized) && /邀请|通知|链接|结果/.test(normalized) && !resumeComplete.test(normalized))) {
    kind = "笔试/测评";
    status = "笔试";
  } else if (realInterview.test(normalized)) {
    kind = "面试邀请";
    status = normalized.includes("二面") ? "二面" : /HR面|hr面|终面/.test(normalized) ? "HR面" : "一面";
  } else if (resumeComplete.test(normalized) || resumeComplete.test(subject)) {
    kind = "简历完善邀请";
    status = "待确认";
  } else if (/offer|录用|意向书|签约|薪资|入职|恭喜.{0,10}(通过|入选)/.test(lower)) {
    kind = "Offer";
    status = "Offer";
  } else if (/很遗憾|未通过|不匹配|结束流程|淘汰/.test(normalized)) {
    kind = "流程结果";
    status = "已拒绝";
  } else if (/投递成功|申请成功|已收到|感谢投递|简历已|投递完成/.test(normalized)) {
    kind = "投递回执";
    status = "已投递";
  }
  return {
    kind,
    status,
    labels: [...new Set(labels)],
    company: guessCompany(normalized, subject, parsed),
    role: guessRole(normalized, subject),
    deadline: guessDeadline(normalized)
  };
}function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&Uuml;/g, "Ü").replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä").replace(/&auml;/g, "ä")
    .replace(/&Ouml;/g, "Ö").replace(/&ouml;/g, "ö")
    .replace(/&szlig;/g, "ß").replace(/&hellip;/g, "…")
    .replace(/&middot;/g, "·").replace(/&mdash;/g, "—")
    .replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”")
    .replace(/&lsquo;/g, "‘").replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function firstUrl(text) {
  return (String(text || "").match(/https?:\/\/[^\s)）]+/) || [""])[0];
}

function guessCompany(text, subject, parsed) {
  const blocked = /智联推荐|智联招聘|前程无忧|猎聘|BOSS直聘|boss直聘|双选会|尊敬的|林同学|林云霞|亲爱的|简历|已读取|非常感谢|感谢您投递|投递我司|非常感谢您投递|更多信息请登录|登录智联|年假|点击查看|关注微信|重要消息|中奖|内测|完整体验|百分百|有奖|职悟空|林女士同学|先生同学|请登录/;
  const source = `${subject || ""} ${text || ""}`;
  // 0) 营销推送专用：去掉"尊敬的林同学【智联推荐】"前缀后，匹配"XX 2027校招/空宣/宣讲/培训生"
  if (isMarketingPush(source)) {
    const cleaned = source.replace(/尊敬的[^，,。！!？?]{0,12}【[^】]*】/g, "").replace(/^[^，,。！!？?]{0,10}?(?:亲爱的|尊敬的)[^，,。！!？?]{0,12}/, "");
    const m = cleaned.match(/([^，,。！!？?【】]{2,30}?)(?:(?:20\d{2})(?:届|年|年度)?)?(?:校园|校招|秋招|春招|招聘|空宣|宣讲|经营管理|管理培训生|培训生|实习生|项目|启动|进行中|热招|开启|管培生|网申|考试|年度|届)/);
    if (m) {
      const name = m[1].replace(/^(?:来自|世界500强|知名企业)/, "").trim();
      if (name && name.length >= 2 && !blocked.test(name)) return name;
    }
  }
  // 1) 标题/正文中的【公司】（跳过平台词）
  const bracketMatches = source.match(/【([^】]{2,35})】/g);
  if (bracketMatches) {
    for (const b of bracketMatches) {
      let name = b.slice(1, -1).replace(/校园招聘|校招|招聘|秋招|春招|2027|2026|2025|届/g, "").replace(/^来自/, "").trim();
      name = name.split(/[|｜]/)[0].trim();
      if (name && !blocked.test(name) && name.length >= 2 && !/^\d/.test(name) && !/[:：]/.test(name) && !/[\d][~～]/.test(name) && !/税前|月薪|薪资|年薪/.test(name) && !/(?:工程师|开发|算法|测试|运营|专员|分析师|管培生|培训生|实习生|实习|大模型|python|Python|Java|java|数据分析|技术|岗位|职位|HR|人力资源)(?:岗|工程师|生|师)?$/.test(name)) return name;
    }
  }
  // 2) 标题开头公司：XX2027届校园招聘 / XX2027年复试考核 / XX-测试题结果通知
  const headPattern = /^(?!来自)([^\s，,。|【】]{2,30}?)(?:(?:20\d{2}|2027|2026|2025)年?届?)?(?:校园|校园招聘)?(?:招聘|校招|秋招|春招|笔试|测评|面试|offer|录用|复试|考核|测试|管培|培训|推免|通知|反馈|提醒|结果|邀请|投递)/;
  const headMatch = subject.match(headPattern);
  if (headMatch) {
    let name = headMatch[1].replace(/校园招聘|校招|招聘|秋招|春招|2027|2026|2025|届/g, "").replace(/^来自/, "").replace(/[-—_]+$/, "").replace(/(?:AI|智能|运营|工程师|开发|算法|测试|岗|实习生|实习|管培生|管培|域运营|应聘|反馈|通知|提醒|结果).*$/g, "").replace(/的$/, "").trim();
    if (/来自|——|—|邀|请|您|你好|您好|同学/.test(name)) name = "";
    if (name && !blocked.test(name) && name.length >= 2) return name;
  }
  const dashMatch = subject.match(/^([^\s，,。|【】]{2,28}?)[-—_](?:测试题|笔试|测评|面试|offer|录用|招聘|通知)/);
  if (dashMatch) {
    const name = dashMatch[1].replace(/校园招聘|校招|招聘|2027|2026|2025|届/g, "").replace(/[-—_]+$/, "").replace(/(?:AI|智能|运营|工程师|开发|算法|测试|岗|实习生|实习|管培生|管培|域运营|应聘|反馈|通知|提醒|结果).*$/g, "").replace(/的$/, "").trim();
    if (name && !blocked.test(name) && name.length >= 2) return name;
  }
  // 3) 发件人显示名（Hytera 海能达 -> 海能达；CCQ Staffing -> CCQ）
  if (parsed && parsed.from) {
    let rawName = "";
    const fromObj = parsed.from || {};
    if (Array.isArray(fromObj.value) && fromObj.value[0]) {
      rawName = fromObj.value[0].name || fromObj.value[0].address || "";
    } else if (Array.isArray(parsed.from) && parsed.from[0]) {
      rawName = parsed.from[0].name || parsed.from[0].address || "";
    } else if (typeof parsed.from === "string") {
      rawName = String(parsed.from).match(/^"?([^"<]{2,24})"?\s*</)?.[1] || "";
    } else if (fromObj.text) {
      rawName = String(fromObj.text).match(/^"?([^"<]{2,24})"?\s*</)?.[1] || "";
    }
    let name = rawName.replace(/["']/g, "").trim();
    if (/^[A-Za-z][A-Za-z\s·-]{2,34}$/.test(name)) {
      name = name.split(/[\s·]+/).filter((w) => !/hr|recruit|talent|staff|招聘|经理|专员/i.test(w)).join(" ").trim();
    } else {
      name = name.split(/[\s·/]+/).pop().trim();
    }
    if (name && !blocked.test(name) && name.length >= 2 && !/招聘|邮件|通知|系统|校招组|人力资源/.test(name)) return name;
  }
  // 4) 正文模式：来自XX的招聘/提醒
  const fromMatch = text.match(/来自([^，,。！!？?]{2,24}?)(?:的)?(?:招聘|通知|邀请|邮件|提醒|面试)/);
  if (fromMatch) {
    let name = fromMatch[1].replace(/^来自/, "").replace(/(?:的)?(?:招聘|通知|邀请|邮件|提醒|面试)$/, "").trim();
    if (name && !blocked.test(name) && name.length >= 2) return name;
  }
  // 5) "XX职位申请"（TÜV SÜD职位申请）
  const jobApply = text.match(/([^，,。\s]{2,24}?)职位申请/);
  if (jobApply) {
    const name = jobApply[1].replace(/数据保护相关条款待确认/g, "").trim();
    if (name && !blocked.test(name) && name.length >= 2 && !/^[0-9]/.test(name)) return name;
  }
  return "";
}function guessRole(text, subject) {
  const source = `${subject || ""} ${text || ""}`;
  const patterns = [
    /【([^】]{2,28}?(?:工程师|开发|实习|培训生|管培生|运营|产品|设计|算法|测试|分析师|专员|经理|顾问|研究|技术|策略|顾问))】/,
    /(?:招聘|招募|岗位|职位|机会)[:： ]?【?([^【】，,。\s]{2,28}?(?:工程师|开发|实习|培训生|管培生|运营|产品|设计|算法|测试|分析师|专员|经理|顾问|研究|技术|策略|顾问))】?/,
    /(?:岗位|职位)[:： ]([^，,。\s]{2,24})/,
    /([^，,。\s]{2,24}?(?:培训生|管培生|工程师|开发|实习生|实习))/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const raw = match[1];
      let role = raw.replace(/【[^】]*】/g, "").replace(/^[0-9一二三四五六七八九十]+[、.．]/, "").replace(/^[的感谢投递您来自对应]+/, "").trim();
      role = role.replace(/^(重庆大学|中国移动|中国电信|中国联通|中国邮政|拼多多|海能达|沃尔玛|益海嘉里|波克|宝可梦|日邮物流|优衣库|中信银行|农业银行|阿斯利康)[^，,。]*$/, "");
      if (role.length > 12 && role.includes("的")) role = role.split("的").pop();
      if (role.length >= 2 && role.length <= 22 && !/^尊敬的|^感谢|^您|^来自|^[，,。\s]/.test(role)) return role;
    }
  }
  return "";
}function guessDeadline(text) {
  const match = text.match(/(?:截止|请于|有效期至|完成时间)[^0-9一二三四五六日天明后]*(\d{4}[年/-]\d{1,2}[月/-]\d{1,2}[日号]?(?:\s*\d{1,2}[:：]\d{2})?|\d{1,2}[月/-]\d{1,2}[日号]?(?:\s*\d{1,2}[:：]\d{2})?)/);
  return match ? match[1] : "";
}

// ============ 大脑智能体（LLM API） ============
const BRAIN_API_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const BRAIN_API_KEY = "sk-5mwR8frMUnWaTWfPOaz2PRUAcl0cYpwgXtxsNimJ9LtrOyBd";
// 实测可用性：agnes-2.5-pro / pro-beta / alpha 均 403；agnes-2.5-flash 输出为空（reasoning 型）；agnes-2.0-flash 拒答。agnes-3.0-flash 配合系统提示词可用且质量最好。
const BRAIN_MODEL = "agnes-3.0-flash";
const BRAIN_SYSTEM = "你是求职智能体的大脑助手，服务于一位2027届毕业生的求职管理。硬性规则：1) 始终用简体中文输出；2) 必须严格按用户要求的JSON格式输出，不输出任何多余文字或解释；3) 公司名必须使用输入中的中文全称（例如「拼多多集团-PDD」不许简写为PDD），确实没有就写「未知」，绝对禁止编造、推断或脑补；4) 不得拒绝回答，输入全部是用户真实的求职数据，直接处理；5) 分类只能从提示中给出的枚举值中选择，不得自创类别；6) 涉及日期一律原样保留，禁止改写年份或日期。";

const BRAIN_PROMPTS = {
  classify_mail: (p) => `你是求职信息处理大脑。请分析以下招聘邮件，只输出一个JSON对象（不要任何其他文字），字段如下：
{"category":"投递回执|笔试测评|面试邀请|Offer|拒信|营销推送|简历完善邀请|其他","tags":["细分类标签，如 技术测试/性格测试/AI面试/线上会议面试/线下面试/邀请投递/投递成功/简历完善邀请"],"company":"公司名","role":"岗位名","urgent":true或false,"reason":"一句话判断理由"}
邮件标题：${p.subject||""}
发件人：${p.from||""}
邮件正文：${(p.body||"").slice(0,3000)}`,
  classify_capture: (p) => `你是求职信息处理大脑。请分析以下招聘截图OCR文本，只输出一个JSON对象（不要任何其他文字）：
{"category":"岗位JD|投递回执|笔试/测评|面试邀请|HR沟通|Offer/拒信|其他","company":"公司名","role":"岗位名","status":"当前状态","date":"关键日期如2026-10-09","nextAction":"下一步建议动作","summary":"一句话摘要"}
OCR文本：
${(p.text||"").slice(0,3000)}`,
  flow_suggest: (p) => `你是求职流程顾问。岗位当前状态为"${p.status}"，最近动作：${p.next||"无"}。请给出下一步建议，只输出JSON：
{"suggestedStatus":"建议流转到哪个状态（待评估/准备投递/已投递/沟通中/测评/笔试/一面/二面/HR面/Offer/已签约/已拒绝/已淘汰/流程结束/暂缓）","nextAction":"具体下一步动作","reason":"判断理由","deadline":"如有关键日期填YYYY-MM-DD"}
岗位：${p.company||""} ${p.role||""}，备注：${p.notes||""}`,
  recommend_jobs: (p) => `你是求职推荐引擎。根据我的简历要点，从岗位列表中筛选最匹配的岗位。只输出JSON：
{"matches":[{"id":"岗位id","score":0到100整数,"reason":"匹配理由"}],"summary":"一句话总结推荐"}
我的简历要点：${(p.profile||"").slice(0,1500)}
岗位列表：
${(p.jobs||[]).map(j=>`[${j.id}] ${j.company} ${j.role} ${j.reason||""}`).join("\n").slice(0,4000)}`,
  chat: (p) => `你是求职智能体的大脑，熟悉用户的求职进度。请用中文回答用户问题，简洁实用。
用户问题：${(p.question||"").slice(0,2000)}
参考数据（可选）：${(p.context||"").slice(0,2000)}`
};

async function brainCall(prompt, maxTokens = 2000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(BRAIN_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${BRAIN_API_KEY}` },
        body: JSON.stringify({ model: BRAIN_MODEL, messages: [{ role: "system", content: BRAIN_SYSTEM }, { role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`brain api ${response.status}: ${detail.slice(0,200)}`);
      }
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content || "";
      if (content && content.trim()) return content;
      throw new Error("brain api 返回空内容");
    } catch (error) {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return { raw: text };
}

app.post("/api/brain", async (req, res) => {
  const { action, payload = {} } = req.body || {};
  const builder = BRAIN_PROMPTS[action];
  if (!builder) return res.status(400).json({ error: "unknown action: " + action });
  try {
    const prompt = builder(payload);
    const output = await brainCall(prompt);
    const result = extractJson(output);
    if (action === "chat" && result.raw) { result.text = output; delete result.raw; }
    res.json({ ok: true, action, result, model: BRAIN_MODEL });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});
// ============ 自动整理（同步后自动运行；也可手动触发，?dry=1 预览） ============
app.post("/api/organize", (req, res) => {
  const dryRun = Boolean(req.query && req.query.dry === "1");
  try {
    const report = organize.runOrganize({ dryRun });
    res.json({ ok: true, dryRun, report });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============ 自动筛选 / 偏好 / 待投递 ============
app.get("/api/preferences", (req, res) => {
  try {
    const prefs = filter.ensurePreferences(readState());
    res.json({ ok: true, preferences: prefs });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put("/api/preferences", (req, res) => {
  try {
    const body = req.body || {};
    const saved = filter.writePreferences(body);
    res.json({ ok: true, preferences: saved });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 按当前偏好重新筛选，刷新待投递名单（recommendedJobs）与被排除清单（filterRejected）
app.post("/api/filter/run", (req, res) => {
  try {
    const state = readState();
    const prefs = filter.ensurePreferences(state);
    const report = filter.applyFilterToState(state, prefs, { dryRun: false });
    writeState({ recommendedJobs: state.recommendedJobs, filterRejected: state.filterRejected });
    res.json({ ok: true, report });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 确认投递：把指定推荐岗位标记为已投、写入主表管线、遵守每日上限。
// 说明：投递动作本身在当前实现下由前端打开岗位链接完成最终提交；autoSubmit 开关仅记录意图，
// 真正的“代点提交”需另接浏览器自动化引擎（见 README 合规提示），默认关闭。
app.post("/api/recommended/apply", (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return res.status(400).json({ ok: false, error: "missing_ids" });
    const state = readState();
    const prefs = filter.ensurePreferences(state);
    const recs = state.recommendedJobs || [];
    const today = new Date().toISOString().slice(0, 10);
    const dailyFile = path.join(shortTermRoot, "daily-apply.json");
    let daily = { date: today, count: 0 };
    try { const d = JSON.parse(fs.readFileSync(dailyFile, "utf8")); if (d && d.date === today) daily = d; } catch {}
    const limit = prefs.dailyLimit || 15;
    const applied = [], skipped = [], limited = [];
    for (const id of ids) {
      const rec = recs.find((r) => r.id === id);
      if (!rec) { skipped.push({ id, reason: "not_found" }); continue; }
      if (rec.applyStatus === "已投递") { skipped.push({ id, reason: "already" }); continue; }
      if (daily.count >= limit) { limited.push(id); continue; }
      filter.ensurePipelineJob(state, rec, { autoSubmit: Boolean(prefs.autoSubmit) });
      daily.count += 1;
      applied.push({ id, company: rec.company, role: rec.role, link: rec.link || "" });
    }
    state.dailyApply = daily;
    try { writeJson(dailyFile, daily); } catch {}
    writeState({ recommendedJobs: state.recommendedJobs, jobs: state.jobs, events: state.events });
    res.json({ ok: true, applied, skipped, limited, dailyLimit: limit, dailyCount: daily.count });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============ 独立桌宠（桌面提醒） ============
const dismissedPet = new Set();
app.get("/api/pet-status", (req, res) => {
  const state = readState();
  const jobs = state.jobs || [];
  const tests = state.tests || [];
  const inbox = state.inbox || [];
  const now = new Date();
  const daysOld = (d) => { const t = new Date(d); return isNaN(t) ? null : Math.floor((now - t) / 864e5); };
  const nearDeadline = tests.filter((t) => t.deadline && (new Date(t.deadline) - now) > 0 && (new Date(t.deadline) - now) < 3 * 864e5).length;
  const unfinished = tests.filter((t) => ["待完成", "未完成", "进行中"].includes(t.status)).length;
  const pending = inbox.filter((i) => ["待确认", "pending"].includes(i.status)).length;
  const stale = jobs.filter((j) => j.status === "已投递" && daysOld(j.updated || j.date) !== null && daysOld(j.updated || j.date) >= 7).length;
  const followups = jobs.filter((j) => ["沟通中", "测评", "笔试"].includes(j.status)).length;
  const candidates = [];
  if (nearDeadline) candidates.push({ message: `有 ${nearDeadline} 个笔试/测评临近截止，记得按时完成。`, hint: "tests", urgent: true });
  if (unfinished) candidates.push({ message: `有 ${unfinished} 个笔试还没更新状态。`, hint: "tests", urgent: false });
  if (pending) candidates.push({ message: `收件箱里有 ${pending} 条截图等你确认。`, hint: "inbox", urgent: false });
  if (stale) candidates.push({ message: `有 ${stale} 个岗位投递后没动静了，去跟进一下。`, hint: "jobs", urgent: false });
  if (followups) candidates.push({ message: `今天推进一个岗位：还有 ${followups} 个待行动。`, hint: "jobs", urgent: false });
  candidates.push({ message: "今天也慢慢推进一件事。", hint: "overview", urgent: false });
  const item = candidates.find((c) => !dismissedPet.has(c.message)) || candidates[candidates.length - 1];
  res.json(item);
});
app.post("/api/pet-dismiss", (req, res) => {
  const { message } = req.body || {};
  if (message) {
    dismissedPet.add(message);
    if (dismissedPet.size > 100) dismissedPet.clear();
  }
  res.json({ ok: true });
});
app.get("/pet", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>求职桌宠</title><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.pet-wrap{position:fixed;right:14px;bottom:14px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;user-select:none;-webkit-user-select:none}
.pet-bubble{max-width:190px;padding:10px 12px;border-radius:12px 2px 12px 12px;background:#fff;border:1px solid #e5e9f2;box-shadow:0 8px 24px rgba(0,0,0,.14);color:#52635e;font-size:13px;line-height:1.5}
.pet-body{width:84px;height:84px;border-radius:26px 26px 30px 30px;background:#ffd84d;display:grid;place-items:center;font-size:30px;cursor:pointer;box-shadow:0 10px 25px rgba(93,78,23,.25);transform:rotate(-4deg);transition:transform .15s;border:0}
.pet-body:hover{transform:rotate(0deg) scale(1.04)}
@keyframes wiggle{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(7deg) scale(1.06)}}
.wiggle{animation:wiggle .9s infinite}
.pet-meta{position:fixed;right:18px;bottom:112px;font-size:10px;color:#9aa3b2;background:rgba(255,255,255,.85);padding:3px 8px;border-radius:8px}
</style></head><body>
<div class="pet-wrap"><div class="pet-bubble" id="bubble">连接中…</div><button class="pet-body" id="body">·ᴗ·</button></div>
<script>
async function tick(){
  const bubble = document.getElementById("bubble");
  const body = document.getElementById("body");
  try {
    const r = await fetch("/api/pet-status", { cache: "no-store" });
    const j = await r.json();
    bubble.textContent = j.message || "今天也慢慢推进一件事。";
    body.classList.toggle("wiggle", !!j.urgent);
    if (j.urgent) { try { new Notification("求职桌宠 · 重要提醒", { body: j.message }); } catch (e) {} }
  } catch (e) {
    bubble.textContent = "主服务未连接，请先启动求职智能体应用。";
  }
}
if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
tick();
setInterval(tick, 30000);
document.getElementById("body").addEventListener("click", () => { window.open("http://localhost:4173/", "_blank"); });
</script></body></html>`);
});
async function shutdown() {
  if (workerPromise) (await workerPromise).terminate();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const server = app.listen(port, () => {
  console.log(`求职智能体已启动：http://localhost:${port}/`);
});

scheduleDailyMailSync(8, 0);

server.keepAliveTimeout = 65_000;
setInterval(() => {}, 60_000);
