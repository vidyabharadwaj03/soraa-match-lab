// Soraa research fleet: planner -> parallel creator researchers -> synthesizer.
// All agents work inside ONE shared Archil disk (each run gets its own folder: runs/<runId>/).
// Keenable gives them the live web. This module is used by app.ts (the web UI).
import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, tool } from "ai";
import { createDiskTools } from "@archildata/ai-sdk";
import { Keenable } from "keenable";
import * as archil from "disk";
import { z } from "zod";

export const MODEL = process.env.FLEET_MODEL ?? "claude-haiku-5-5"; // cheapest; try claude-sonnet-5-5 for better prose
const MAX_CREATORS = Number(process.env.MAX_CREATORS ?? 4);
const MOUNT = "/mnt/archil/workspace"; // the disk root, as seen by the agents' sandbox

export type Candidate = { name: string; where: string };
export type FleetEvent =
  | { type: "stage"; stage: "planning" | "researching" | "writing" | "done" }
  | { type: "candidates"; list: (Candidate & { id: string })[] }
  | { type: "worker"; id: string; status: "running" | "done" | "failed"; score?: number; error?: string }
  | { type: "tool"; agent: string; tool: string; ms: number; hint: string }
  | { type: "error"; message: string };

const keenable = new Keenable(); // uses KEENABLE_API_KEY if set; keyless otherwise

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "creator";

const webTools = {
  web_search: tool({
    description: "Search the live web. Returns numbered, citable [n] Title (url) results with page text.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => (await keenable.search(query, { maxResults: 5 })).toContext(),
  }),
  web_fetch: tool({
    description: "Fetch one web page as markdown (use after web_search when a snippet is not enough).",
    inputSchema: z.object({ url: z.string() }),
    execute: async ({ url }) => (await keenable.fetch(url)).toContext(),
  }),
};

const mk = (instructions: string, tools: any) => new ToolLoopAgent({ model: anthropic(MODEL), instructions, tools });

const hintOf = (input: any): string => {
  const v = input?.query ?? input?.url ?? input?.path ?? input?.command ?? input?.pattern ?? "";
  return String(v).slice(0, 90);
};

export async function runFleet(opts: {
  brief: string;
  runId: string;
  disk: any;
  creators?: string[]; // optional hand-picked creators (skips discovery)
  resume?: boolean; // finish an interrupted run: skip research, just write the report
  emit: (e: FleetEvent) => void;
}) {
  const { brief, runId, disk, emit } = opts;
  const workspace = archil.workspace({ workspace: { disk, conditional: true } });
  const base = `runs/${runId}`; // S3 key prefix on the disk
  const ROOT = `${MOUNT}/${base}`; // same place, as seen by the agents
  const auditKey = `${base}/audit.jsonl`;

  const audit =
    (agent: string) =>
    async ({ toolCall, toolOutput, toolExecutionMs }: any) => {
      const ms = Math.round(toolExecutionMs);
      const entry = {
        t: new Date().toISOString(),
        agent,
        tool: toolCall.toolName,
        input: toolCall.input,
        ms,
        result: JSON.stringify(toolOutput.type === "tool-result" ? toolOutput.output : toolOutput.error)?.slice(0, 500),
      };
      await disk.appendObject(auditKey, `${JSON.stringify(entry)}\n`).catch(() => {});
      emit({ type: "tool", agent, tool: toolCall.toolName, ms, hint: hintOf(toolCall.input) });
    };

  if (!opts.resume) await disk.putObject(`${base}/BRIEF.md`, `# Brand brief\n\n${brief}\n`);

  // Resuming an interrupted run: reuse the creators already researched, only write the report.
  const existingIds = async (): Promise<string[]> => {
    const list = JSON.parse(new TextDecoder().decode(await disk.getObject(`${base}/candidates.json`))) as (Candidate & { id: string })[];
    emit({ type: "candidates", list });
    const ok: string[] = [];
    for (const c of list) {
      try {
        await disk.getObject(`${base}/creators/${c.id}/fit.md`);
        ok.push(c.id);
        emit({ type: "worker", id: c.id, status: "done" });
      } catch {
        emit({ type: "worker", id: c.id, status: "failed", error: "no research saved" });
      }
    }
    if (!ok.length) throw new Error("Nothing was researched in this run yet. Start a new run instead.");
    return ok;
  };

  const discoverAndResearch = async (): Promise<string[]> => {
  // 1. planner
  emit({ type: "stage", stage: "planning" });
  let candidates: Candidate[];
  if (opts.creators?.length) {
    candidates = opts.creators.map((name) => ({ name, where: "" }));
  } else {
    const planner = mk(
      "You scout content creators for brand partnerships. Use web_search/web_fetch to find REAL, currently active " +
        "creators that plausibly fit the brief. Prefer micro-creators with a public web presence (YouTube, blog, " +
        "Substack, TikTok/Instagram profile pages that show up in search, press). Do not invent anyone. " +
        `Run at least 4 different searches (vary the niche, platform and location wording) and return EXACTLY ${MAX_CREATORS} distinct creators ` +
        "(fewer only if you truly cannot find that many real ones). " +
        `Reply with ONLY a JSON array: [{"name": "...", "where": "main profile URL"}]`,
      webTools,
    );
    const found: Candidate[] = [];
    for (let attempt = 0; attempt < 2 && found.length < MAX_CREATORS; attempt++) {
      const have = found.length ? `\n\nAlready found (do NOT repeat, find ${MAX_CREATORS - found.length} more different ones): ${found.map((c) => c.name).join(", ")}` : "";
      const res = await planner.generate({ prompt: `Brand brief:\n${brief}${have}`, onToolExecutionEnd: audit("planner") });
      const m = res.text.match(/\[[\s\S]*\]/);
      if (!m) continue;
      try {
        for (const c of JSON.parse(m[0]) as Candidate[]) {
          if (c?.name && !found.some((f) => slug(f.name) === slug(c.name))) found.push({ name: String(c.name), where: String(c.where ?? "") });
        }
      } catch {}
    }
    if (!found.length) throw new Error("The planner couldn't find any creators. Try a more specific brief.");
    candidates = found.slice(0, MAX_CREATORS);
  }
  const list = candidates.map((c) => ({ ...c, id: slug(c.name) }));
  await disk.putObject(`${base}/candidates.json`, JSON.stringify(list, null, 2));
  emit({ type: "candidates", list });

  // 2. workers, in parallel
  emit({ type: "stage", stage: "researching" });
  const research = async (c: Candidate & { id: string }) => {
    emit({ type: "worker", id: c.id, status: "running" });
    try {
      const worker = mk(
        [
          "You research ONE creator for a brand-partnership matcher. Be factual and cite sources; never invent numbers.",
          "If something can't be verified, write 'unknown' rather than guessing.",
          `Work only in ${ROOT}/creators/${c.id}. Use write_file for files (each bash command runs in a fresh microVM).`,
          "Write exactly these files:",
          "  profile.md  - platforms + handles, follower counts (approx, with source), niche, location, content style/aesthetic/tone, posting cadence, rates if public.",
          "  partnerships.md - past brand deals / sponsored content you can find, and what kinds of brands they work with.",
          "  fit.md - fit against the brief. The FIRST line must be exactly 'Score: NN/100'. Then 3-5 bullet reasons (audience/geo, budget, style, niche, risks), each tagged with a [n] source.",
          "  sources.md - the numbered list of URLs you relied on.",
        ].join("\n"),
        { ...createDiskTools(workspace), ...webTools },
      );
      await worker.generate({
        prompt: `Brand brief:\n${brief}\n\nCreator: ${c.name}${c.where ? `\nStarting point: ${c.where}` : ""}`,
        onToolExecutionEnd: audit(`worker:${c.id}`),
      });
      let score: number | undefined;
      try {
        const fit = new TextDecoder().decode(await disk.getObject(`${base}/creators/${c.id}/fit.md`));
        const m = fit.match(/(\d{1,3})\s*\/\s*100/);
        if (m) score = Math.min(100, Number(m[1]));
      } catch {}
      emit({ type: "worker", id: c.id, status: "done", score });
      return c.id;
    } catch (e: any) {
      emit({ type: "worker", id: c.id, status: "failed", error: String(e?.message ?? e).slice(0, 200) });
      throw e;
    }
  };
  const settled = await Promise.allSettled(list.map(research));
  const ids = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ids.length) throw new Error("Every research worker failed. Check your API keys and credits, then try again.");
  return ids;
  };
  const ids = opts.resume ? await existingIds() : await discoverAndResearch();

  // 3. synthesizer
  emit({ type: "stage", stage: "writing" });
  const synth = mk(
    [
      "You are Soraa's matching brain. Read every creator folder and produce the curated shortlist.",
      `Creator folders: ${ids.map((i) => `${ROOT}/creators/${i}`).join(", ")}. Read profile.md, partnerships.md, fit.md, sources.md for each.`,
      `Write ${ROOT}/REPORT.md in a warm, friendly, skimmable voice (like a smart friend giving a recommendation, not a consulting memo). ` +
        "Use EXACTLY this markdown structure:\n" +
        "# <a short, catchy title for this brief>\n" +
        "A 2-3 sentence 'bottom line' paragraph (no heading) saying who to reach out to first and the biggest caveat.\n" +
        "Then a ranked top 3 (fewer if the evidence is thin). For each, in order:\n" +
        "## #1 <Creator name> (@handle)\n" +
        "One italic line: what makes them special for this brand.\n" +
        "### Why we love it\n(2-3 sentences, plain language)\n" +
        "### Quick facts\n(short bullets: followers, location, style, cadence, rate if known)\n" +
        "### Watch-outs\n(short bullets: real risks and unknowns)\n" +
        "### Sources\n(a bullet list of just the links)\n" +
        "Then '## Not shortlisted' (one line each on why) and '## Before you reach out' (a short checklist). " +
        "Curated, not a filtered list. If you disagree with a worker's score, say why. " +
        "Never add facts that are not in the creator files; say 'unknown' when unknown.",
    ].join("\n"),
    createDiskTools(workspace),
  );
  await synth.generate({ prompt: `Brand brief:\n${brief}\n\nWrite the report now.`, onToolExecutionEnd: audit("synthesizer") });
  emit({ type: "stage", stage: "done" });
}
