import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import archiver from "archiver";
import multer from "multer";
import AdmZip from "adm-zip";

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.resolve("workspace");
const MAX_FILE_BYTES = 2_000_000;
const MAX_ZIP_BYTES = 25_000_000;
const MAX_IMPORT_FILES = 500;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } });
const execFileAsync = promisify(execFile);
const BACKUP_ROOT = path.resolve(".adveyra-backups");

app.set("trust proxy", 1);
app.use(express.json({ limit: "24mb" }));
app.use(cookieSession({
  name: "adveyra_session",
  keys: [process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET_BEFORE_DEPLOY"],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 8 * 60 * 60 * 1000
}));
app.use(express.static("public", { etag: true, maxAge: 0 }));

// Serve project preview assets from the workspace with strict no-cache headers.
app.use("/preview", requireAuth, express.static(ROOT, {
  etag: false, lastModified: false, maxAge: 0,
  setHeaders(res) { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate"); res.setHeader("Pragma", "no-cache"); res.setHeader("Expires", "0"); }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function requireAuth(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: "Please log in." });
  next();
}

function isIgnoredName(name) {
  return name === ".git" || name === "node_modules" || /^\.env(?:\.|$)/i.test(name) || name.startsWith(".adveyra-");
}

function safePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("A file path is required.");
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").some(part => part === ".." || part === "." || isIgnoredName(part))) throw new Error("Invalid or protected path. .git, node_modules, .env and internal backup paths are blocked.");
  const full = path.resolve(ROOT, normalized);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error("Path is outside the project workspace.");
  return { full, relative: normalized };
}

async function ensureWorkspace() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(BACKUP_ROOT, { recursive: true });
}
await ensureWorkspace();

const SETTINGS_DIR = path.resolve(".adveyra-private");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "providers.enc.json");
function settingsKey() {
  const secret = process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET_BEFORE_DEPLOY";
  return crypto.createHash("sha256").update(secret).digest();
}
function encryptSettings(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", settingsKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}
function decryptSettings(payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", settingsKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8"));
}
async function readProviderSettings() {
  try { return decryptSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"))); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new Error("Saved provider settings could not be decrypted. Check SESSION_SECRET; do not change it after saving API keys."); }
}
async function writeProviderSettings(value) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  const temp = SETTINGS_FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(encryptSettings(value)), { mode: 0o600 });
  await fs.rename(temp, SETTINGS_FILE);
}
async function providerConfig() {
  const saved = await readProviderSettings();
  return {
    provider: saved.provider || "gemini",
    geminiKey: saved.geminiKey || process.env.GEMINI_API_KEY || "",
    geminiModel: saved.geminiModel || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    openaiKey: saved.openaiKey || process.env.OPENAI_API_KEY || "",
    openaiModel: saved.openaiModel || process.env.OPENAI_MODEL || "gpt-5.3-codex"
  };
}


async function backupExisting(full, relative) {
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return;
    const safeName = relative.replaceAll("/", "__");
    const dir = path.join(BACKUP_ROOT, new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(full, path.join(dir, safeName));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function walkWorkspace(dir = ROOT, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push({ path: rel, type: "directory" }, ...(await walkWorkspace(path.join(dir, entry.name), rel)));
    else result.push({ path: rel, type: "file" });
  }
  return result;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "ADVEYRA AI STUDIO" }));

app.get("/api/session", (req, res) => res.json({ authenticated: Boolean(req.session?.admin), username: req.session?.username || null }));

app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  // Fixed legacy admin login requested for this deployment.
  // Keep this aligned with the existing ADVEYRA account.
  const expectedUser = "adveyraadmin";
  const hash = "$2b$12$DSs1sUj7wQ6p78b8CQwpTeCPngawlTYjZuWTqCP586m6kKyapF3ru";
  if (!expectedUser || !hash) return res.status(503).json({ error: "Admin credentials are not configured on the server." });
  if (username !== expectedUser || typeof password !== "string" || !(await bcrypt.compare(password, hash))) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session = { admin: true, username: expectedUser };
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/files", requireAuth, async (_req, res) => {
  try { res.json({ files: await walkWorkspace() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/file", requireAuth, async (req, res) => {
  try {
    const { full, relative } = safePath(req.query.path);
    const content = await fs.readFile(full, "utf8");
    res.json({ path: relative, content });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/file", requireAuth, async (req, res) => {
  try {
    const { full, relative } = safePath(req.body?.path);
    const content = req.body?.content;
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return res.status(400).json({ error: "File content must be text and no larger than 2 MB." });
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await backupExisting(full, relative);
    await fs.writeFile(full, content, "utf8");
    res.json({ ok: true, path: relative });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/folder", requireAuth, async (req, res) => {
  try { const { full, relative } = safePath(req.body?.path); await fs.mkdir(full, { recursive: false }); res.json({ ok: true, path: relative }); }
  catch (e) { res.status(400).json({ error: e.code === "EEXIST" ? "Folder already exists." : e.message }); }
});

app.post("/api/rename", requireAuth, async (req, res) => {
  try {
    const from = safePath(req.body?.from); const to = safePath(req.body?.to);
    await fs.mkdir(path.dirname(to.full), { recursive: true });
    await fs.rename(from.full, to.full);
    res.json({ ok: true, from: from.relative, to: to.relative });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/file", requireAuth, async (req, res) => {
  try {
    const { full, relative } = safePath(req.body?.path);
    const stat = await fs.stat(full);
    if (!stat.isFile()) return res.status(400).json({ error: "Only files can be deleted from this action." });
    await backupExisting(full, relative);
    await fs.unlink(full);
    res.json({ ok: true, path: relative, backupCreated: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/files/bulk-delete", requireAuth, apiLimiter, async (req, res) => {
  try {
    const paths = Array.isArray(req.body?.paths) ? [...new Set(req.body.paths)] : [];
    if (!paths.length) return res.status(400).json({ error: "Select at least one file." });
    if (paths.length > 500) return res.status(413).json({ error: "A maximum of 500 files can be deleted at once." });
    const targets = paths.map(safePath);
    for (const target of targets) {
      const stat = await fs.stat(target.full);
      if (!stat.isFile()) throw new Error(`${target.relative} is not a file.`);
    }
    for (const target of targets) await backupExisting(target.full, target.relative);
    for (const target of targets) await fs.unlink(target.full);
    res.json({ ok: true, deleted: targets.length, paths: targets.map(x => x.relative), backupsCreated: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/files/download-selected", requireAuth, apiLimiter, async (req, res) => {
  try {
    const paths = Array.isArray(req.body?.paths) ? [...new Set(req.body.paths)] : [];
    if (!paths.length) return res.status(400).json({ error: "Select at least one file to download." });
    if (paths.length > 500) return res.status(413).json({ error: "A maximum of 500 files can be downloaded at once." });
    const files = [];
    for (const value of paths) {
      const target = safePath(value);
      const stat = await fs.stat(target.full);
      if (!stat.isFile()) throw new Error(`${target.relative} is not a file.`);
      files.push(target);
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="adveyra-selected-files.zip"');
    const archive = archiver("zip", { zlib: { level: 8 } });
    archive.on("error", error => res.destroy(error));
    archive.pipe(res);
    for (const file of files) archive.file(file.full, { name: file.relative });
    await archive.finalize();
  } catch (e) { if (!res.headersSent) res.status(400).json({ error: e.message }); else res.destroy(e); }
});

app.post("/api/upload-file", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
    const { full, relative } = safePath(req.body?.path || req.file.originalname);
    if (req.file.size > MAX_FILE_BYTES) return res.status(413).json({ error: "Single-file upload limit is 2 MB. Use ZIP import for a project." });
    await fs.mkdir(path.dirname(full), { recursive: true });
    await backupExisting(full, relative);
    await fs.writeFile(full, req.file.buffer);
    res.json({ ok: true, path: relative, size: req.file.size });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/import-zip", requireAuth, upload.single("archive"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a ZIP archive." });
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    if (!entries.length) return res.status(400).json({ error: "The ZIP archive contains no files." });
    if (entries.length > MAX_IMPORT_FILES) return res.status(413).json({ error: `ZIP contains too many files. Maximum: ${MAX_IMPORT_FILES}.` });
    const prepared = [];
    let total = 0;
    for (const entry of entries) {
      const raw = entry.entryName.replaceAll("\\", "/");
      if (raw.startsWith("/") || raw.split("/").some(part => part === ".." || part === ".")) throw new Error(`Unsafe ZIP path rejected: ${raw}`);
      const parts = raw.split("/");
      if (parts.some(part => isIgnoredName(part))) continue;
      const relative = parts.filter(Boolean).join("/");
      if (!relative) continue;
      const data = entry.getData();
      total += data.length;
      if (total > 100_000_000) return res.status(413).json({ error: "ZIP expands beyond the 100 MB import limit." });
      const { full } = safePath(relative);
      prepared.push({ full, relative, data });
    }
    if (!prepared.length) return res.status(400).json({ error: "No importable project files found. .env, .git and node_modules are excluded." });
    // Back up overwritten files before writing any imported content.
    for (const item of prepared) await backupExisting(item.full, item.relative);
    for (const item of prepared) { await fs.mkdir(path.dirname(item.full), { recursive: true }); await fs.writeFile(item.full, item.data); }
    res.json({ ok: true, imported: prepared.length, totalBytes: total, files: prepared.map(x => x.relative) });
  } catch (e) { res.status(400).json({ error: `ZIP import failed: ${e.message}` }); }
});


app.get("/api/settings/providers", requireAuth, async (_req, res) => {
  try {
    const c = await providerConfig();
    res.json({ provider: c.provider, geminiModel: c.geminiModel, openaiModel: c.openaiModel,
      geminiKeySet: Boolean(c.geminiKey), openaiKeySet: Boolean(c.openaiKey), variableNames: Object.keys((await readProviderSettings()).variables || {}),
      geminiKeySource: process.env.GEMINI_API_KEY ? "hosting environment" : "encrypted studio settings",
      openaiKeySource: process.env.OPENAI_API_KEY ? "hosting environment" : "encrypted studio settings" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/settings/providers", requireAuth, apiLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const current = await readProviderSettings();
    const next = {
      provider: ["gemini","openai"].includes(body.provider) ? body.provider : (current.provider || "gemini"),
      geminiModel: typeof body.geminiModel === "string" ? body.geminiModel.slice(0,100) : (current.geminiModel || "gemini-3.1-flash-lite"),
      openaiModel: typeof body.openaiModel === "string" ? body.openaiModel.slice(0,100) : (current.openaiModel || "gpt-5.3-codex"),
      geminiKey: typeof body.geminiKey === "string" && body.geminiKey.trim() ? body.geminiKey.trim() : (current.geminiKey || ""),
      openaiKey: typeof body.openaiKey === "string" && body.openaiKey.trim() ? body.openaiKey.trim() : (current.openaiKey || ""),
      variables: body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? Object.fromEntries(Object.entries(body.variables).filter(([k,v]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k) && typeof v === "string").slice(0,100))
        : (current.variables || {})
    };
    await writeProviderSettings(next);
    res.json({ ok: true, provider: next.provider, geminiKeySet: Boolean(next.geminiKey), openaiKeySet: Boolean(next.openaiKey), note: "Keys are encrypted on the server. On Render Free, local files may be lost on restart/redeploy; use Render environment variables for durable production secrets." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/settings/test", requireAuth, apiLimiter, async (req, res) => {
  try {
    const c = await providerConfig();
    const provider = req.body?.provider || c.provider;
    if (provider === "openai") {
      if (!c.openaiKey) return res.status(400).json({ error: "OpenAI API key is not configured." });
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${c.openaiKey}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: d.error?.message || `OpenAI connection failed (${r.status})` });
      return res.json({ ok: true, provider, message: "OpenAI API key authenticated. This checks access, not model billing or tool execution." });
    }
    if (!c.geminiKey) return res.status(400).json({ error: "Gemini API key is not configured." });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.geminiModel)}?key=${encodeURIComponent(c.geminiKey)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || `Gemini connection failed (${r.status})` });
    return res.json({ ok: true, provider, message: `Gemini model ${c.geminiModel} is reachable.` });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/diagnostics", requireAuth, async (_req, res) => {
  const checks = [];
  checks.push({ name: "Node.js runtime", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: `Node ${process.versions.node}` });
  const pc = await providerConfig().catch(() => ({}));
  checks.push({ name: "Gemini API key configured", ok: Boolean(pc.geminiKey), detail: pc.geminiKey ? "Key configured (hidden)" : "Add it in AI Settings or hosting environment" });
  checks.push({ name: "OpenAI API key configured", ok: Boolean(pc.openaiKey), detail: pc.openaiKey ? "Key configured (hidden)" : "Optional: add it in AI Settings or hosting environment" });
  checks.push({ name: "Admin credentials configured", ok: true, detail: "Legacy ADVEYRA admin login is configured in the application" });
  checks.push({ name: "Session secret configured", ok: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32), detail: process.env.SESSION_SECRET?.length >= 32 ? "Session secret length looks good" : "Set a random SESSION_SECRET of at least 32 characters" });
  checks.push({ name: "Workspace writable", ok: await fs.access(ROOT).then(() => true).catch(() => false), detail: "Project workspace" });
  const githubReady = Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);
  const githubMissing = [!process.env.GITHUB_TOKEN && "GITHUB_TOKEN", !process.env.GITHUB_OWNER && "GITHUB_OWNER", !process.env.GITHUB_REPO && "GITHUB_REPO"].filter(Boolean);
  checks.push({ name: "GitHub integration configured", ok: githubReady, detail: githubReady ? `Configured for ${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO} (${process.env.GITHUB_BRANCH || "main"})` : `Missing Render variables: ${githubMissing.join(", ")}` });
  res.json({ checks, model: pc.provider === "openai" ? pc.openaiModel : pc.geminiModel, provider: pc.provider || "gemini" });
});

app.get("/api/export", requireAuth, async (_req, res) => {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="adveyra-project.zip"');
  const archive = archiver("zip", { zlib: { level: 8 } });
  archive.on("error", error => res.destroy(error));
  archive.pipe(res);
  archive.directory(ROOT, false);
  await archive.finalize();
});

app.post("/api/chat", requireAuth, apiLimiter, async (req, res) => {
  const cfg = await providerConfig();
  const selectedProvider = req.body?.provider || cfg.provider || "gemini";
  if (selectedProvider === "openai" && !cfg.openaiKey) return res.status(503).json({ error: "OpenAI API key is not configured. Add it in AI Settings." });
  if (selectedProvider !== "openai" && !cfg.geminiKey) return res.status(503).json({ error: "Gemini API key is not configured. Add it in AI Settings." });
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16) : [];
  if (!messages.length) return res.status(400).json({ error: "No chat messages provided." });

  const ai = selectedProvider === "openai" ? null : new GoogleGenAI({ apiKey: cfg.geminiKey });
  const model = selectedProvider === "openai" ? cfg.openaiModel : cfg.geminiModel;
  const systemInstruction = `You are ADVEYRA AI STUDIO, an expert, proactive, multimodal software-building agent similar in workflow to Google AI Studio.
CORE BEHAVIOUR:
- Understand natural Hindi and English instructions. Do not demand technical prompts, framework names, schemas, or implementation details from the user.
- Translate vague ideas into a practical plan. Ask only essential questions, preferably one at a time. Offer sensible defaults and let the user approve or adjust them.
- If the request is clear enough, start working immediately instead of asking unnecessary questions.
- When the user says build a CRM, website, dashboard, app, landing page or feature, inspect the existing workspace first, identify the stack, then create/update the actual files. Do not merely give instructions or code snippets.
- For a new app, choose a simple maintainable architecture, responsive UI, accessible controls, validation, loading/error/empty states, and secure backend patterns.
- For backend/database requirements, create real API routes, schema/migrations, validation, auth and integration adapters when feasible. Never pretend a remote database, secret, deployment or external service is connected until credentials and a successful test exist. Use environment-variable placeholders and document exact setup steps; never put secrets in frontend code.
PROJECT SAFETY:
- Inspect before editing. Preserve all existing working features, routes, styling, data formats and integrations. Make the smallest complete change. Never reset databases, delete project files, overwrite unrelated code, or redesign the app unless explicitly asked.
- Use relative paths only. Never read, reveal, request, or write secrets, API keys, passwords, .env files, .git, node_modules or internal backups.
- Before risky/destructive work, stop and ask for approval. Prefer additive, reversible edits and explain backups.
EXECUTION HONESTY:
- Available tools can list, read, create and update project files. There is no general shell, npm install, arbitrary process runner, live database provisioner, browser automation, or deployment execution in this agent.
- Never claim code was run, tested, installed, deployed, or connected unless an available operation actually confirmed it. Distinguish code created from runtime verification.
- After work, summarize what changed, what remains, required environment variables, and exact next steps. Be concise, warm and practical. Do not over-explain or repeat the user's request.`;

  const tools = [{
    functionDeclarations: [
      {
        name: "list_project_files",
        description: "List all files in the current project workspace.",
        parameters: { type: Type.OBJECT, properties: {}, required: [] }
      },
      {
        name: "create_project_folder",
        description: "Create a folder in the project workspace when organizing a new feature or app. Existing folders are preserved.",
        parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Relative folder path." } }, required: ["path"] }
      },
      {
        name: "read_project_file",
        description: "Read a UTF-8 text file from the current project workspace.",
        parameters: {
          type: Type.OBJECT,
          properties: { path: { type: Type.STRING, description: "Relative path of the file." } },
          required: ["path"]
        }
      },
      {
        name: "write_project_file",
        description: "Create or replace a UTF-8 text file in the project workspace. Only write files needed for the user's requested project changes.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: "Relative path of the file." },
            content: { type: Type.STRING, description: "Complete UTF-8 text content to save." }
          },
          required: ["path", "content"]
        }
      }
    ]
  }];

  async function runTool(name, args) {
    if (name === "list_project_files") {
      async function walk(dir, prefix = "") {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
          if (isIgnoredName(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
          else out.push(rel);
        }
        return out;
      }
      return await walk(ROOT);
    }
    if (name === "create_project_folder") {
      const { full, relative } = safePath(args.path);
      await fs.mkdir(full, { recursive: true });
      return { created: relative };
    }
    if (name === "read_project_file") {
      const { full } = safePath(args.path);
      return await fs.readFile(full, "utf8");
    }
    if (name === "write_project_file") {
      const { full, relative } = safePath(args.path);
      if (typeof args.content !== "string" || Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) {
        throw new Error("File is too large or invalid.");
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await backupExisting(full, relative);
      await fs.writeFile(full, args.content, "utf8");
      return { saved: relative, backupCreated: true };
    }
    throw new Error("Unknown tool.");
  }


  try {
    if (selectedProvider === "openai") {
      const functionTools = [
        { type: "function", name: "list_project_files", description: "List files in the current project workspace.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true },
        { type: "function", name: "create_project_folder", description: "Create a project folder.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
        { type: "function", name: "read_project_file", description: "Read a UTF-8 project file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
        { type: "function", name: "write_project_file", description: "Create or update a UTF-8 project file. Existing files are backed up first.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path","content"], additionalProperties: false }, strict: true }
      ];
      const input = messages.map((m, i) => {
        const content = [{ type: "input_text", text: String(m.content || "").slice(0,12000) }];
        if (i === messages.length - 1 && Array.isArray(req.body?.images)) {
          for (const image of req.body.images.slice(0,4)) {
            if (typeof image?.data === "string" && /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType || "")) content.push({ type: "input_image", image_url: image.data });
          }
        }
        return { role: m.role === "assistant" ? "assistant" : "user", content };
      });
      let response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${cfg.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions: systemInstruction, input, tools: functionTools, max_output_tokens: 10000 })
      });
      let data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
      let finalText = "";
      for (let turn = 0; turn < 10; turn++) {
        const calls = (data.output || []).filter(x => x.type === "function_call");
        if (!calls.length) {
          finalText = (data.output || []).filter(x => x.type === "message").flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
          break;
        }
        const outputs = [];
        for (const call of calls) {
          let result;
          try { result = await runTool(call.name, JSON.parse(call.arguments || "{}")); }
          catch (toolError) { result = { error: toolError.message }; }
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        }
        response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Authorization": `Bearer ${cfg.openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, instructions: systemInstruction, previous_response_id: data.id, input: outputs, tools: functionTools, max_output_tokens: 10000 })
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || `OpenAI tool-call error ${response.status}`);
      }
      return res.json({ reply: finalText || "The agent completed available file operations. Refresh the Files panel to review changes.", provider: "openai", model });
    }
    // Gemini uses role "model" for assistant turns and role "user" for user turns.
    const contents = messages.map((m, index) => {
      const parts = [{ text: String(m.content || "").slice(0, 12000) }];
      if (index === messages.length - 1 && Array.isArray(req.body?.images)) {
        for (const image of req.body.images.slice(0, 4)) {
          if (!image || typeof image.data !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType || "")) continue;
          const raw = image.data.replace(/^data:image\/[^;]+;base64,/, "");
          if (raw.length > 5_000_000) continue;
          parts.push({ inlineData: { mimeType: image.mimeType, data: raw } });
        }
      }
      return { role: m.role === "assistant" ? "model" : "user", parts };
    });

    let finalText = "";
    for (let turn = 0; turn < 10; turn++) {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools,
          temperature: 0.2,
          maxOutputTokens: 12288
        }
      });

      const functionCalls = response.functionCalls || [];
      if (!functionCalls.length) {
        finalText = response.text || "The agent completed its tool steps. Please check the project files.";
        break;
      }

      // Preserve the model's function-call turn, then return tool results as a user turn.
      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);
      const functionResponses = [];
      for (const call of functionCalls) {
        let result;
        try {
          result = await runTool(call.name, call.args || {});
        } catch (toolError) {
          result = { error: toolError.message };
        }
        const functionResponse = {
          name: call.name,
          response: { result }
        };
        if (call.id) functionResponse.id = call.id;
        functionResponses.push({ functionResponse });
      }
      contents.push({ role: "user", parts: functionResponses });
    }

    if (!finalText) finalText = "I completed the available file operations. Please refresh the Files panel to review the changes.";
    res.json({ reply: finalText });
  } catch (e) {
    const status = Number(e?.status || e?.code || 0);
    const message = String(e?.message || "AI request failed.");
    console.error("Gemini request failed:", message);
    if (status === 429 || /quota|rate.?limit|resource exhausted/i.test(message)) {
      return res.status(429).json({ error: `${selectedProvider} API quota or rate limit reached. Check provider billing and usage limits.` });
    }
    if (status === 400 && /model/i.test(message)) {
      return res.status(400).json({ error: `Selected model '${model}' is unavailable or unsupported by this API key. Check the provider and model selection.` });
    }
    if (status === 401 || status === 403 || /api.?key|permission|unauthenticated/i.test(message)) {
      return res.status(502).json({ error: `${selectedProvider} API key is invalid or lacks permission for this model. Check AI Settings or hosting environment variables.` });
    }
    res.status(500).json({ error: message.slice(0, 500) });
  }
});

app.post("/api/github/push", requireAuth, apiLimiter, async (req, res) => {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return res.status(503).json({ error: "Configure GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in hosting environment variables first." });
  }
  try {
    async function gh(url, options = {}) {
      const r = await fetch(`https://api.github.com${url}`, {
        ...options,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `GitHub API error ${r.status}`);
      return data;
    }
    let ref;
    try { ref = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${branch}`); }
    catch { return res.status(400).json({ error: `Branch '${branch}' was not found. Create the repository and branch first.` }); }
    const parentSha = ref.object.sha;
    const parentCommit = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${parentSha}`);
    async function walk(dir, prefix = "") {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let out = [];
      for (const entry of entries) {
        if (isIgnoredName(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
        else {
          const content = await fs.readFile(path.join(dir, entry.name));
          const blob = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, { method: "POST", body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }) });
          out.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
        }
      }
      return out;
    }
    const treeItems = await walk(ROOT);
    if (!treeItems.length) return res.status(400).json({ error: "The workspace is empty. Create or import project files before pushing." });
    const tree = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
      method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeItems })
    });
    const commit = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
      method: "POST", body: JSON.stringify({ message: req.body?.message || "Update from ADVEYRA AI Studio", tree: tree.sha, parents: [parentSha] })
    });
    await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branch}`, {
      method: "PATCH", body: JSON.stringify({ sha: commit.sha })
    });
    res.json({ ok: true, commit: commit.sha, url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${commit.sha}` });
  } catch (e) {
    const message = String(e.message || "GitHub push failed.");
    const status = /bad credentials|resource not accessible|not found|permission|protected branch/i.test(message) ? 400 : 502;
    res.status(status).json({ error: `GitHub push failed: ${message}. Check that the token has Contents: Read and write permission and that owner, repository and branch are correct.` });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ADVEYRA AI STUDIO listening on ${PORT}`));
