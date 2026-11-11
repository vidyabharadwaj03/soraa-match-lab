// Web app: type a brand brief, watch the agent fleet work, read the shortlist.
//   npm start      ->  http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import * as archil from "disk";
import { runFleet, slug, MODEL, type FleetEvent } from "./fleet.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_ACTIVE = 2; // each run spends model + search credits
const dec = new TextDecoder();

// ---- the shared Archil disk (reused across restarts by name) ----
async function getSharedDisk() {
  if (process.env.ARCHIL_DISK_ID) return archil.getDisk(process.env.ARCHIL_DISK_ID);
  const name = "soraa-fleet";
  try {
    const existing = (await archil.listDisks()).find((d: any) => d.name === name);
    if (existing) return archil.getDisk((existing as any).id);
  } catch {}
  return (await archil.createDisk({ name })).disk;
}
const disk: any = await getSharedDisk();
console.log(`Archil disk: ${disk.id}   model: ${MODEL}`);

// ---- run state ----
type Worker = { id: string; name: string; where: string; status: "queued" | "running" | "done" | "failed"; score?: number; last?: string; error?: string; cached?: boolean };
type Run = {
  id: string; brief: string; stage: "starting" | "planning" | "researching" | "writing" | "done" | "error";
  workers: Worker[]; activity: { agent: string; tool: string; ms: number; hint: string }[]; error?: string; startedAt: number;
};
const runs = new Map<string, Run>();
const active = () => [...runs.values()].filter((r) => r.stage !== "done" && r.stage !== "error").length;

function reduce(run: Run, e: FleetEvent) {
  if (e.type === "stage") run.stage = e.stage;
  else if (e.type === "candidates") run.workers = e.list.map((c) => ({ id: c.id, name: c.name, where: c.where, status: "queued" }));
  else if (e.type === "worker") {
    const w = run.workers.find((x) => x.id === e.id);
    if (w) Object.assign(w, { status: e.status, score: e.score ?? w.score, error: e.error, cached: e.cached ?? w.cached });
  } else if (e.type === "tool") {
    run.activity.push({ agent: e.agent, tool: e.tool, ms: e.ms, hint: e.hint });
    if (run.activity.length > 40) run.activity.shift();
    const w = run.workers.find((x) => e.agent === `worker:${x.id}`);
    if (w) w.last = `${e.tool}: ${e.hint}`;
  } else if (e.type === "error") {
    run.stage = "error"; run.error = e.message;
  }
}

function startRun(brief: string, creators?: string[]) {
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${slug(brief).slice(0, 20)}`;
  const run: Run = { id, brief, stage: "starting", workers: [], activity: [], startedAt: Date.now() };
  runs.set(id, run);
  runFleet({ brief, runId: id, disk, creators, emit: (e) => reduce(run, e) }).catch((err) =>
    reduce(run, { type: "error", message: String(err?.message ?? err).slice(0, 300) }),
  );
  return id;
}

// Finish an interrupted run (e.g. the server restarted mid-run): reuse the saved research, write the report.
async function resumeRun(id: string) {
  const brief = (await text(`runs/${id}/BRIEF.md`)).replace(/^# Brand brief\s*/, "").trim();
  const run: Run = { id, brief, stage: "starting", workers: [], activity: [], startedAt: Date.now() };
  runs.set(id, run);
  runFleet({ brief, runId: id, disk, resume: true, emit: (e) => reduce(run, e) }).catch((err) =>
    reduce(run, { type: "error", message: String(err?.message ?? err).slice(0, 300) }),
  );
}

// ---- reading from the disk ----
const text = async (key: string) => dec.decode(await disk.getObject(key));
async function listRuns() {
  const out: { id: string; brief: string; stage: string }[] = [];
  const seen = new Set<string>();
  for (const r of [...runs.values()].reverse()) { out.push({ id: r.id, brief: r.brief, stage: r.stage }); seen.add(r.id); }
  try {
    const l = await disk.listObjects("runs/");
    const prefixes: string[] = (l.commonPrefixes ?? []).map((p: any) => (typeof p === "string" ? p : p.prefix));
    for (const p of prefixes.sort().reverse()) {
      const id = p.replace(/^runs\//, "").replace(/\/$/, "");
      if (seen.has(id)) continue;
      let brief = id;
      try { brief = (await text(`runs/${id}/BRIEF.md`)).replace(/^# Brand brief\s*/, "").trim(); } catch {}
      let finished = true;
      try { await disk.getObject(`runs/${id}/REPORT.md`); } catch { finished = false; }
      out.push({ id, brief, stage: finished ? "done" : "interrupted" });
    }
  } catch {}
  return out;
}
async function getRun(id: string) {
  const live = runs.get(id);
  let report: string | null = null;
  try { report = await text(`runs/${id}/REPORT.md`); } catch {}
  if (live) return { ...live, report, resumable: live.stage === "error" && !report && live.workers.length > 0 };
  // finished run from a previous session: rebuild from the disk
  let brief = id, workers: Worker[] = [];
  try { brief = (await text(`runs/${id}/BRIEF.md`)).replace(/^# Brand brief\s*/, "").trim(); } catch { return null; }
  try {
    const c = JSON.parse(await text(`runs/${id}/candidates.json`));
    workers = await Promise.all(c.map(async (x: any) => {
      let score: number | undefined;
      try { const m = (await text(`runs/${id}/creators/${x.id}/fit.md`)).match(/(\d{1,3})\s*\/\s*100/); if (m) score = Number(m[1]); } catch {}
      return { id: x.id, name: x.name, where: x.where, status: "done" as const, score };
    }));
  } catch {}
  return {
    id, brief, stage: report ? "done" : "error", workers, activity: [], report,
    resumable: !report && workers.length > 0,
    error: report ? undefined : "This run was interrupted before the report was written (for example, the server restarted).",
  };
}
// Creators the fleet has researched before (saved on the disk under memory/creators/).
async function listMemory() {
  const out: { name: string; where: string; updatedAt: string }[] = [];
  try {
    const l = await disk.listObjects("memory/creators/");
    const prefixes: string[] = (l.commonPrefixes ?? []).map((p: any) => (typeof p === "string" ? p : p.prefix));
    await Promise.all(prefixes.map(async (p) => {
      try { out.push(JSON.parse(await text(`${p}meta.json`))); } catch {}
    }));
  } catch {}
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function listFiles(id: string) {
  const l = await disk.listObjects(`runs/${id}/`, { recursive: true });
  return l.objects.map((o: any) => o.key as string).filter((k: string) => !k.endsWith("/")).sort();
}

// ---- http ----
const json = (res: any, code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
const readBody = (req: any) => new Promise<string>((ok, bad) => { let s = ""; req.on("data", (c: any) => { s += c; if (s.length > 20000) bad(new Error("too big")); }); req.on("end", () => ok(s)); });
const ID = /^[a-z0-9-]+$/;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://localhost");
    const p = url.pathname;
    if (req.method === "GET" && p === "/") {
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(new URL("./index.html", import.meta.url)));
    }
    if (req.method === "GET" && p === "/api/runs") return json(res, 200, await listRuns());
    if (req.method === "GET" && p === "/api/memory") return json(res, 200, await listMemory());
    if (req.method === "POST" && p === "/api/runs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const brief = String(body.brief ?? "").trim();
      if (brief.length < 15) return json(res, 400, { error: "Describe your brand and who you want to partner with (a sentence or two)." });
      if (brief.length > 2000) return json(res, 400, { error: "Brief is too long (max 2000 characters)." });
      if (active() >= MAX_ACTIVE) return json(res, 429, { error: `${MAX_ACTIVE} runs are already in progress. Wait for one to finish.` });
      const creators = Array.isArray(body.creators) ? body.creators.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 6) : undefined;
      return json(res, 200, { id: startRun(brief, creators) });
    }
    const rs = p.match(/^\/api\/runs\/([a-z0-9-]+)\/resume$/);
    if (req.method === "POST" && rs) {
      if (active() >= MAX_ACTIVE) return json(res, 429, { error: `${MAX_ACTIVE} runs are already in progress. Wait for one to finish.` });
      if (runs.has(rs[1]) && !["done", "error"].includes(runs.get(rs[1])!.stage)) return json(res, 409, { error: "This run is still going." });
      await resumeRun(rs[1]);
      return json(res, 200, { id: rs[1] });
    }
    const m = p.match(/^\/api\/runs\/([^/]+)(\/files)?$/);
    if (req.method === "GET" && m) {
      if (!ID.test(m[1])) return json(res, 400, { error: "bad id" });
      if (m[2]) return json(res, 200, await listFiles(m[1]));
      const r = await getRun(m[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && p === "/api/file") {
      const key = url.searchParams.get("key") ?? "";
      if (!/^runs\/[a-z0-9-]+\/[A-Za-z0-9._\/-]+$/.test(key) || key.includes("..")) return json(res, 400, { error: "bad key" });
      return void res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(await text(key));
    }
    json(res, 404, { error: "not found" });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e).slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Soraa Match Lab: http://localhost:${PORT}`));
