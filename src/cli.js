#!/usr/bin/env node
/**
 * crucible — interactive AI planning session
 *
 * Usage:
 *   crucible              open interactive session
 *   crucible plan "task"  start a plan directly
 *   crucible debate "task" raw debate
 *   crucible git          GitHub menu
 *   crucible history      browse past sessions and proposals
 *   crucible models       show current model versions
 *   crucible help
 */

import OpenAI    from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync }            from "child_process";
import { createInterface }      from "readline";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join, resolve }        from "path";
import * as DB   from "./db.js";
import { analyseRepo, getRepoSummary, getChangeLog, clearRepoKnowledge } from "./repo.js";
import { runStagingFlow, listStagedFiles, restageApproved, setInteractiveHelpers } from "./staging.js";
import { retrieveKey, storeKey, getKeySource, SERVICE_OPENAI, SERVICE_ANTHROPIC } from "./keys.js";
import { validateBranchName, gitq, gitExec, ghExec, ghq } from "./safety.js";

// Keys retrieved from secure store (keychain or file), with env var fallback
let _openai    = null;
let _anthropic = null;

function getOpenAI() {
  if (!_openai) {
    const key = retrieveKey(SERVICE_OPENAI) || "";
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

function getAnthropic() {
  if (!_anthropic) {
    const key = retrieveKey(SERVICE_ANTHROPIC) || "";
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

const MAX_ROUNDS         = parseInt(process.env.MAX_ROUNDS || "10");
const CONVERGENCE_PHRASE = "I AGREE WITH THIS PLAN";
const EXCLUDE  = /transcribe|search|realtime|audio|vision|preview|tts|whisper|dall-e|instruct|embed|codex/i;
const PRIORITY = [/^gpt-5/, /^gpt-4\.5/, /^gpt-4o/, /^gpt-4/];

// ── Session state ─────────────────────────────────────────────────────────────

const state = {
  sessionId:   null,
  proposalId:  null,
  project:     null,
  repoPath:    null,
  repoUrl:     null,
  repoContext: null,
  gptModel:    null,
  claudeModel: null,
};

// ── Colours ───────────────────────────────────────────────────────────────────

const c = {
  reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m",
  cyan:"\x1b[36m", green:"\x1b[32m", yellow:"\x1b[33m",
  blue:"\x1b[34m", magenta:"\x1b[35m", red:"\x1b[31m",
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const dim    = s => `${c.dim}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const blue   = s => `${c.blue}${s}${c.reset}`;
const mag    = s => `${c.magenta}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;
const hr     = (ch="─", w=72) => dim(ch.repeat(w));
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, "");

function box(lines) {
  const width = Math.max(...lines.map(l => stripAnsi(l).length)) + 6;
  console.log(cyan("  ┌" + "─".repeat(width - 2) + "┐"));
  for (const l of lines) {
    const pad = " ".repeat(Math.max(0, width - 4 - stripAnsi(l).length));
    console.log(cyan("  │  ") + l + pad + cyan("  │"));
  }
  console.log(cyan("  └" + "─".repeat(width - 2) + "┘"));
}

function crucibleSay(msg) {
  console.log("");
  console.log(bold(cyan("  crucible")) + dim(" ›") + " " + msg);
}

function systemMsg(msg) {
  console.log(dim(`  [${msg}]`));
}

// ── Readline ──────────────────────────────────────────────────────────────────

let _rl;
function getRL() {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}

async function ask(prompt, { defaultVal } = {}) {
  const label = defaultVal ? `${prompt} ${dim(`[${defaultVal}]`)} ` : `${prompt} `;
  return new Promise(res => getRL().question(label, ans => {
    const v = ans.trim();
    res(v === "" && defaultVal ? defaultVal : v);
  }));
}

async function confirm(msg, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans  = (await ask(`${msg} ${dim(hint)}`)).toLowerCase();
  return defaultYes ? ans !== "n" : ans === "y";
}

const done = () => { if (_rl) { _rl.close(); _rl = null; } };

// Pass interactive helpers and colour fns to staging.js
setInteractiveHelpers(ask, confirm, { bold, dim, cyan, green, yellow, red, blue, hr });

function inGitRepo(p)    { return gitq(p||".", ["rev-parse", "--is-inside-work-tree"]) === "true"; }
function currentBranch(p){ return gitq(p||".", ["branch", "--show-current"]); }
function ghInstalled()   {
  // Use `gh --version` rather than `which gh`: more portable (no `which` on
  // Windows/minimal containers) and confirms the binary is actually runnable.
  const r = spawnSync("gh", ["--version"], { stdio: "ignore", shell: false });
  return r.status === 0;
}

// ── Model detection ───────────────────────────────────────────────────────────

async function getLatestGPTModel() {
  try {
    const { data: models } = await getOpenAI().models.list();
    const chat = models.map(m=>m.id).filter(id => /^gpt-(4|5)/.test(id) && !EXCLUDE.test(id));
    const candidates = [];
    for (const pat of PRIORITY) {
      const tier = chat.filter(id=>pat.test(id)).sort().reverse();
      if (!tier.length) continue;
      const chatLatest = tier.find(id => id.includes("chat-latest"));
      const dated      = tier.find(id => !id.includes("chat-latest") && (/\d{4}-\d{2}-\d{2}/.test(id) || /\d{8}/.test(id)));
      const rest       = tier.filter(id => id !== chatLatest && id !== dated);
      if (chatLatest) candidates.push(chatLatest);
      if (dated)      candidates.push(dated);
      candidates.push(...rest);
    }
    for (const model of candidates) {
      try {
        await getOpenAI().chat.completions.create({ model, max_tokens:1, messages:[{ role:"user", content:"hi" }] });
        return model;
      } catch(e) {
        if (e.status === 404 || e.status === 400) continue;
        throw e;
      }
    }
    return "gpt-4o";
  } catch { return "gpt-4o"; }
}

async function getLatestClaudeModel() {
  try {
    const { data: models } = await getAnthropic().models.list();
    return models
      .filter(m => m.id.includes("sonnet"))
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0]?.id
      || "claude-sonnet-4-20250514";
  } catch { return "claude-sonnet-4-20250514"; }
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function askGPT(messages) {
  const res = await getOpenAI().chat.completions.create({ model: state.gptModel, messages, max_tokens:2000 });
  return res.choices[0].message.content;
}

async function askClaude(messages) {
  const res = await getAnthropic().messages.create({ model: state.claudeModel, max_tokens:2000, messages });
  return res.content[0].text;
}

function hasConverged(r) { return r.toUpperCase().includes(CONVERGENCE_PHRASE); }

// ── Repo analysis — delegates to repo.js ──────────────────────────────────────

async function loadRepoContext(repoPath, repoUrl) {
  if (!repoPath || !inGitRepo(repoPath)) return null;

  let result;
  try {
    result = await analyseRepo(repoPath, repoUrl, {
      claudeModel: state.claudeModel,
      onStatus: msg => systemMsg(msg),
    });
  } catch (err) {
    systemMsg(`Repo analysis failed: ${err.message} — continuing without context.`);
    return null;
  }

  const { understanding, stackSummary, isFirstVisit, newCommitCount } = result;

  if (isFirstVisit) {
    crucibleSay(`Codebase understood and cached.  ${dim(stackSummary)}`);
  } else if (newCommitCount > 0) {
    crucibleSay(`Understanding updated — ${newCommitCount} new commit(s) processed.  ${dim(stackSummary)}`);
  } else {
    crucibleSay(`Using cached understanding.  ${dim(stackSummary)}`);
  }

  // Return the understanding as context for debates/proposals
  return understanding;
}

// ── Repo setup ────────────────────────────────────────────────────────────────

async function setupRepo() {
  console.log("");
  crucibleSay("Let's get the repo set up.");
  console.log("");
  console.log(`  ${cyan("1")}  Use a local repo (give me a path)`);
  console.log(`  ${cyan("2")}  Clone a GitHub repo`);
  console.log(`  ${cyan("3")}  Create a new GitHub repo`);
  console.log(`  ${cyan("4")}  Skip — no repo for this session`);
  console.log("");

  const choice = (await ask("  ›")).trim();

  if (choice === "1") {
    const p = await ask("  Path to repo:", { defaultVal: process.cwd() });
    const resolved = resolve(p);
    if (!inGitRepo(resolved)) {
      crucibleSay(`${red("That doesn't look like a git repo.")} Run ${dim("git init")} there first, or pick another option.`);
      return setupRepo();
    }
    state.repoPath = resolved;
    state.repoUrl  = gitq(resolved, ["remote", "get-url", "origin"]);
    crucibleSay(`Got it — ${yellow(resolved)}`);
  }

  else if (choice === "2") {
    if (!ghInstalled()) { crucibleSay("GitHub CLI not found — run setup-crucible-git.sh first."); return; }
    const url = await ask("  GitHub repo URL or owner/name:");
    if (!url.trim()) return;
    const dest = await ask("  Clone to:", { defaultVal: process.cwd() });
    ghExec(["repo", "clone", url.trim(), dest.trim()]);
    state.repoPath = dest.trim();
    state.repoUrl  = url.trim();
    crucibleSay(`Cloned to ${yellow(state.repoPath)}`);
  }

  else if (choice === "3") {
    if (!ghInstalled()) { crucibleSay("GitHub CLI not found — run setup-crucible-git.sh first."); return; }
    const name    = await ask("  New repo name:");
    const desc    = await ask("  Description (optional):");
    const priv    = await confirm("  Make it private?", false);
    if (!name.trim()) return;
    ghExec(["repo", "create", "--name", name.trim(), "--description", desc.trim(),
            priv ? "--private" : "--public", "--confirm"]);
    const dest = join(process.cwd(), name.trim());
    state.repoPath = dest;
    state.repoUrl  = ghq(["repo", "view", name.trim(), "--json", "url", "-q", ".url"]);
    DB.logAction(null, state.sessionId, "create_repo", `Created repo: ${name.trim()}`, { name: name.trim(), url: state.repoUrl });
    crucibleSay(`Repo created: ${yellow(state.repoUrl)}`);
  }

  else {
    crucibleSay("No repo — carrying on without one.");
    return;
  }

  state.repoContext = await loadRepoContext(state.repoPath, state.repoUrl);
  if (state.repoContext) systemMsg(`Context loaded (${state.repoContext.length} chars)`);
  DB.updateSession(state.sessionId, { repoPath: state.repoPath, repoUrl: state.repoUrl });
}

// ── Claude feedback on a proposal ────────────────────────────────────────────

// ── Pre-debate proposal refinement ───────────────────────────────────────────
//
//  Phase 0a: GPT critiques and streamlines the raw proposal
//  Phase 0b: Claude responds to GPT's critique
//  Phase 0c: GPT synthesises a clean refined proposal from the exchange
//  User reviews refined proposal, can edit, then debate starts from there

async function refineProposal(rawProposal) {
  const repoSection = state.repoContext
    ? `\n\nRepo context:\n${state.repoContext.slice(0, 3000)}`
    : "";
  const projectLine = `Project: ${state.project || "unspecified"}`;

  console.log("");
  console.log(hr("═"));
  console.log(bold(cyan("\n  Phase 0 — Refinement\n")));
  console.log(dim("  GPT will critique your proposal, Claude will respond,"));
  console.log(dim("  then GPT synthesises a clean version for you to approve."));
  console.log("");
  console.log(hr());

  // ── Step 1: GPT critiques ───────────────────────────────────────────────────

  const gptCritiquePrompt = `You are a senior technical architect reviewing a rough project proposal.
Your job is to critique it honestly and thoroughly before planning begins.
Identify: unclear requirements, missing constraints, technical risks, scope creep, better approaches, and any questions that must be answered before work starts.
Be direct and specific. Do not start planning or solving yet — only critique and question.

${projectLine}${repoSection}

Raw proposal:
${rawProposal}`;

  process.stdout.write(dim("  GPT critiquing..."));
  const gptCritique = await askGPT([
    { role: "system", content: "You are a senior technical architect. Critique proposals honestly before planning begins." },
    { role: "user",   content: gptCritiquePrompt },
  ]);
  process.stdout.write("\r                  \r");

  DB.logMessage(state.proposalId, "gpt", gptCritique, { phase: "refinement" });

  console.log("");
  console.log(bold(yellow(`  ▶ GPT (${state.gptModel}) — Critique`)));
  console.log("");
  gptCritique.split("\n").forEach(l => console.log(`    ${l}`));
  console.log("");

  // ── Step 2: User can respond to GPT critique before Claude weighs in ────────

  console.log(hr("·"));
  crucibleSay("Any response to GPT's critique? Clarify, push back, or add context. Hit Enter to continue.");
  console.log("");
  const userClarification = (await ask("  ›")).trim();
  if (userClarification) {
    DB.logMessage(state.proposalId, "user", userClarification, { phase: "refinement" });
  }

  // ── Step 3: Claude responds to GPT's critique ───────────────────────────────

  const claudeResponsePrompt = `${projectLine}${repoSection}

Original proposal:
${rawProposal}

${userClarification ? `User clarified: ${userClarification}\n\n` : ""}GPT's critique:
${gptCritique}

You are Claude, a senior technical advisor. Respond to GPT's critique of this proposal.
Defend what is sound, agree where GPT is right, add your own concerns or angles GPT missed.
Do not write a plan yet — this is still the critique phase.`;

  process.stdout.write(dim("  Claude responding..."));
  const claudeResponse = await askClaude([{ role: "user", content: claudeResponsePrompt }]);
  process.stdout.write("\r                     \r");

  DB.logMessage(state.proposalId, "claude", claudeResponse, { phase: "refinement" });

  console.log("");
  console.log(bold(blue(`  ▶ Claude (${state.claudeModel}) — Response`)));
  console.log("");
  claudeResponse.split("\n").forEach(l => console.log(`    ${l}`));
  console.log("");

  // ── Step 4: GPT synthesises a refined proposal from the full exchange ────────

  console.log(hr("·"));

  const synthesisPrompt = `${projectLine}${repoSection}

Original rough proposal:
${rawProposal}

${userClarification ? `User clarification: ${userClarification}\n\n` : ""}GPT critique:
${gptCritique}

Claude response:
${claudeResponse}

Now synthesise a clean, refined proposal that:
- Incorporates the valid concerns from both critiques
- Resolves ambiguities using the most sensible interpretation
- Is specific enough to plan from — clear scope, constraints, and success criteria
- Is written as a proposal, not a plan (no implementation steps yet)

Keep it concise but complete. This will be handed to both models as the starting point for a technical debate.`;

  process.stdout.write(dim("  Synthesising refined proposal..."));
  const refinedProposal = await askGPT([
    { role: "system", content: "You synthesise crisp, unambiguous project proposals from rough ideas and critique sessions." },
    { role: "user",   content: synthesisPrompt },
  ]);
  process.stdout.write("\r                              \r");

  DB.logMessage(state.proposalId, "gpt", refinedProposal, { phase: "refinement" });

  // ── Step 5: Show refined proposal, let user edit or approve ─────────────────

  console.log("");
  console.log(hr("═"));
  console.log(bold(cyan("\n  Refined Proposal\n")));
  refinedProposal.split("\n").forEach(l => console.log(`  ${l}`));
  console.log("");
  console.log(hr("═"));
  console.log("");

  console.log(`  ${cyan("1")}  Looks good — start the debate`);
  console.log(`  ${cyan("2")}  Edit before debating`);
  console.log(`  ${cyan("3")}  Scrap refinement — debate my original proposal`);
  console.log(`  ${cyan("0")}  Save and exit`);
  console.log("");

  while (true) {
    const ans = (await ask("  ›")).trim();

    if (ans === "1" || ans === "") {
      return { refined: refinedProposal, accepted: true };
    }

    if (ans === "2") {
      console.log("");
      crucibleSay("Edit the refined proposal below. Submit an empty line to finish.");
      console.log(dim("  (Paste your edited version and press Enter twice)"));
      console.log("");
      const lines = [];
      while (true) {
        const line = await ask("");
        if (line === "" && lines.length && lines[lines.length - 1] === "") break;
        lines.push(line);
      }
      const edited = lines.join("\n").trim();
      if (edited) {
        DB.logMessage(state.proposalId, "user", edited, { phase: "refinement" });
        return { refined: edited, accepted: true };
      }
      continue;
    }

    if (ans === "3") {
      return { refined: rawProposal, accepted: true };
    }

    if (ans === "0") {
      return { refined: null, accepted: false };
    }

    console.log(dim("  Enter 0–3."));
  }
}

// ── Summarise agreed points ───────────────────────────────────────────────────

async function summariseProgress(claudeMsgs) {
  try {
    const res = await anthropic.messages.create({
      model: state.claudeModel, max_tokens: 500,
      messages: [...claudeMsgs, { role:"user", content:"List only the points BOTH models have clearly agreed on so far. Bullet points only, no preamble." }],
    });
    return res.content[0].text;
  } catch { return "(Could not generate summary)"; }
}

// ── Inter-round controls ──────────────────────────────────────────────────────

async function roundControls({ round, claudeMsgs, prevPlan, currentPlan }) {
  console.log("");
  console.log(hr());
  console.log(bold(cyan(`\n  After Round ${round}\n`)));
  console.log(`  ${cyan("1")}  Continue`);
  console.log(`  ${cyan("2")}  Show agreed points`);
  console.log(`  ${cyan("3")}  Show diff`);
  console.log(`  ${cyan("4")}  Steer next round`);
  console.log(`  ${cyan("5")}  ${green("Accept")} — take this as the plan`);
  console.log(`  ${cyan("6")}  ${red("Reject & restart")}`);
  console.log("");

  let steering = null;
  while (true) {
    const ans = (await ask("  ›")).trim().toLowerCase();

    if (ans === "1" || ans === "") return { action:"continue", steering };

    if (ans === "2") {
      process.stdout.write(dim("  Summarising..."));
      const s = await summariseProgress(claudeMsgs);
      process.stdout.write("\r               \r");
      console.log(""); console.log(bold(cyan("  Agreed so far:")));
      s.split("\n").forEach(l => console.log(`    ${l}`)); console.log("");
      continue;
    }

    if (ans === "3") {
      if (!prevPlan) { console.log(dim("\n  No previous round to diff against.\n")); continue; }
      const prevLines = prevPlan.split("\n");
      const currLines = currentPlan.split("\n");
      const added   = currLines.filter(l => l.trim() && !prevLines.includes(l));
      const removed = prevLines.filter(l => l.trim() && !currLines.includes(l));
      if (!added.length && !removed.length) { console.log(dim("\n  No significant changes.\n")); continue; }
      if (removed.length) { console.log(bold(red("\n  Removed:"))); removed.slice(0,6).forEach(l => console.log(red(`    − ${l.trim()}`))); }
      if (added.length)   { console.log(bold(green("\n  Added:")) ); added.slice(0,6).forEach(l => console.log(green(`    + ${l.trim()}`))); }
      console.log(""); continue;
    }

    if (ans === "4") {
      const s = await ask("\n  Your direction:\n  ›");
      if (s.trim()) { steering = s.trim(); console.log(green("\n  ✔ Will inject into next round.\n")); }
      continue;
    }

    if (ans === "5") return { action:"accept" };

    if (ans === "6") {
      const d = await ask("\n  New direction for restart:\n  ›");
      return { action:"restart", newDirection: d.trim() };
    }

    console.log(dim("  Enter 1–6."));
  }
}

// ── Core debate engine ────────────────────────────────────────────────────────

async function runDebate(taskContext) {
  const repoSection = state.repoContext
    ? `\n\nRepo context:\n${state.repoContext.slice(0, 3000)}`
    : "";

  const systemGPT = `You are ${state.gptModel}, collaborating with ${state.claudeModel} to produce the best possible technical plan.
Critically evaluate the other model's proposal each round. Push back where needed. Be specific.
When you genuinely believe the plan is solid, include "${CONVERGENCE_PHRASE}" in your response.`;

  const systemClaude = `You are ${state.claudeModel}, collaborating with ${state.gptModel} to produce the best possible technical plan.
Critically evaluate the other model's proposal each round. Push back where needed. Be specific.
When you genuinely believe the plan is solid, include "${CONVERGENCE_PHRASE}" in your response.`;

  const gptMsgs    = [
    { role:"system", content: systemGPT },
    { role:"user",   content: `${taskContext}${repoSection}\n\nGive your initial approach and plan.` },
  ];
  const claudeMsgs = [
    { role:"user", content: `${systemClaude}\n\n${taskContext}${repoSection}\n\nGive your initial approach and plan.` },
  ];

  let round=1, prevPlan=null, currentPlan=null, gptAgreed=false, claudeAgreed=false;

  console.log(""); console.log(hr("═"));
  console.log(bold(cyan("\n  Debate\n"))); console.log(hr());
  console.log(""); console.log(bold(`  Round 1`)); console.log(hr("·"));

  process.stdout.write(dim("  GPT thinking..."));
  let gptResponse = await askGPT(gptMsgs);
  process.stdout.write("\r                    \r");
  gptMsgs.push({ role:"assistant", content: gptResponse });
  claudeMsgs[0].content += `\n\n${state.gptModel}'s opening plan:\n${gptResponse}\n\nNow respond — push back where needed.`;
  gptAgreed = hasConverged(gptResponse);

  console.log(""); console.log(bold(yellow(`  ▶ GPT (${state.gptModel})`))); console.log("");
  gptResponse.split("\n").forEach(l => console.log(`    ${l}`));
  if (gptAgreed) console.log(green("\n  ✔ GPT agrees"));
  DB.logMessage(state.proposalId, "gpt",    gptResponse,    { phase:"debate", round:1 });

  process.stdout.write(dim("  Claude thinking..."));
  let claudeResponse = await askClaude(claudeMsgs);
  process.stdout.write("\r                    \r");
  claudeMsgs.push({ role:"assistant", content: claudeResponse });
  claudeAgreed = hasConverged(claudeResponse);

  console.log(""); console.log(bold(blue(`  ▶ Claude (${state.claudeModel})`))); console.log("");
  claudeResponse.split("\n").forEach(l => console.log(`    ${l}`));
  if (claudeAgreed) console.log(green("\n  ✔ Claude agrees"));
  DB.logMessage(state.proposalId, "claude", claudeResponse, { phase:"debate", round:1 });

  currentPlan = claudeResponse;

  while (!gptAgreed || !claudeAgreed) {
    if (round >= MAX_ROUNDS) {
      console.log(yellow(`\n  ⚠ Max rounds (${MAX_ROUNDS}) reached. Moving to synthesis.`));
      break;
    }

    const ctrl = await roundControls({ round, claudeMsgs, prevPlan, currentPlan });

    if (ctrl.action === "accept")  return { done:true, reason:"accepted", round, gptMsgs };
    if (ctrl.action === "restart") return { done:false, newDirection: ctrl.newDirection };

    round++;
    console.log(""); console.log(bold(`  Round ${round}`)); console.log(hr("·"));

    const steer = ctrl.steering ? `\n\n[User direction: ${ctrl.steering}]` : "";
    if (ctrl.steering) DB.logMessage(state.proposalId, "user", ctrl.steering, { phase:"debate", round });

    gptMsgs.push({ role:"user", content:`${state.claudeModel} responded:\n${claudeResponse}${steer}\n\nRefine and push back. Say "${CONVERGENCE_PHRASE}" when you fully agree.` });
    process.stdout.write(dim("  GPT thinking..."));
    gptResponse = await askGPT(gptMsgs);
    process.stdout.write("\r                    \r");
    gptMsgs.push({ role:"assistant", content: gptResponse });
    gptAgreed = hasConverged(gptResponse);
    console.log(""); console.log(bold(yellow(`  ▶ GPT (${state.gptModel})`))); console.log("");
    gptResponse.split("\n").forEach(l => console.log(`    ${l}`));
    if (gptAgreed) console.log(green("\n  ✔ GPT agrees"));
    DB.logMessage(state.proposalId, "gpt", gptResponse, { phase:"debate", round });

    const prevClaudeResponse = claudeResponse;
    claudeMsgs.push({ role:"user", content:`${state.gptModel} responded:\n${gptResponse}${steer}\n\nRefine and push back. Say "${CONVERGENCE_PHRASE}" when you fully agree.` });
    process.stdout.write(dim("  Claude thinking..."));
    claudeResponse = await askClaude(claudeMsgs);
    process.stdout.write("\r                    \r");
    claudeMsgs.push({ role:"assistant", content: claudeResponse });
    claudeAgreed = hasConverged(claudeResponse);
    console.log(""); console.log(bold(blue(`  ▶ Claude (${state.claudeModel})`))); console.log("");
    claudeResponse.split("\n").forEach(l => console.log(`    ${l}`));
    if (claudeAgreed) console.log(green("\n  ✔ Claude agrees"));
    DB.logMessage(state.proposalId, "claude", claudeResponse, { phase:"debate", round });

    prevPlan    = prevClaudeResponse;
    currentPlan = claudeResponse;
  }

  return { done:true, reason:"converged", round, gptMsgs };
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

async function synthesise(gptMsgs) {
  gptMsgs.push({
    role:"user",
    content:"The debate is over. Write a clean, final, actionable plan. Use clear sections and numbered steps. No commentary — just the plan, ready for a developer.",
  });
  const plan = await askGPT(gptMsgs);
  DB.logMessage(state.proposalId, "gpt", plan, { phase:"synthesis" });
  return plan;
}

// ── Commit spec (user-gated) ──────────────────────────────────────────────────

async function offerCommitSpec(task, finalPlan, round) {
  if (!state.repoPath || !inGitRepo(state.repoPath)) return;

  console.log("");
  const save = await confirm("  💾 Commit this plan as a spec file to the repo?");
  if (!save) { crucibleSay("No problem — the plan is saved in the database."); return; }

  const slug  = task.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,50);
  const stamp = new Date().toISOString().slice(0,10);
  const fname = `specs/${stamp}-${slug}.md`;
  const specsDir = join(state.repoPath, "specs");

  if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });

  writeFileSync(join(state.repoPath, fname), [
    `# Spec: ${task}`, ``,
    `> crucible — ${new Date().toISOString()}`,
    `> ${state.gptModel} vs ${state.claudeModel} — ${round} round(s)`,
    `> Project: ${state.project || "unspecified"}`,
    ``, `---`, ``, finalPlan,
  ].join("\n"));

  // Log action but don't execute yet
  const actionId = DB.logAction(state.proposalId, state.sessionId, "commit", `spec: ${task.slice(0,72)}`, { file: fname });

  const branchAns = await ask(`  Branch:`, { defaultVal: currentBranch(state.repoPath) });
  let target;
  try {
    target = validateBranchName(branchAns.trim() || currentBranch(state.repoPath));
  } catch (e) {
    crucibleSay(red(`Invalid branch name: ${e.message}`)); return;
  }

  if (target !== currentBranch(state.repoPath)) {
    if (gitq(state.repoPath, ["branch", "--list", target])) {
      gitExec(state.repoPath, ["checkout", target]);
    } else {
      gitExec(state.repoPath, ["checkout", "-b", target]);
      console.log(green(`  ✔ Created branch: ${target}`));
      DB.logAction(state.proposalId, state.sessionId, "branch", `Created branch ${target}`, { branch: target });
    }
  }

  gitExec(state.repoPath, ["add", fname]);
  gitExec(state.repoPath, ["commit", "-m", `spec: ${task.slice(0,72)}`]);
  DB.executeAction(actionId);
  console.log(green(`  ✔ Committed: ${fname}`));

  const push = await confirm("  Push now?");
  if (push) {
    const pushActionId = DB.logAction(state.proposalId, state.sessionId, "push", `Push ${target}`, { branch: target });
    gitExec(state.repoPath, ["push", "-u", "origin", currentBranch(state.repoPath)]);
    DB.executeAction(pushActionId);
    console.log(green("  ✔ Pushed"));

    if (ghInstalled()) {
      const pr = await confirm("  Open a PR for this spec?");
      if (pr) {
        const prActionId = DB.logAction(state.proposalId, state.sessionId, "pr", `PR: spec: ${task.slice(0,72)}`, { base:"main" });
        ghExec(["pr", "create", "--title", `spec: ${task.slice(0,72)}`,
                "--body", "Auto-generated spec from crucible debate.", "--base", "main"]);
        DB.executeAction(prActionId);
        console.log(green("  ✔ PR created"));
      }
    }
  }
}

// ── Merge to main (user-gated) ────────────────────────────────────────────────

async function offerMergeToMain() {
  if (!state.repoPath || !inGitRepo(state.repoPath)) return;
  const branch = currentBranch(state.repoPath);
  if (branch === "main" || branch === "master") {
    crucibleSay("Already on main — nothing to merge."); return;
  }

  const go = await confirm(`  Merge ${yellow(branch)} into main?`);
  if (!go) return;

  if (ghInstalled() && state.repoUrl) {
    const prActionId = DB.logAction(state.proposalId, state.sessionId, "merge", `Squash-merge ${branch} → main`, { branch, base:"main" });
    // Try to find an open PR for this branch, otherwise create + merge
    const existingPR = ghq(["pr", "list", "--head", branch, "--json", "number", "-q", ".[0].number"]);
    if (existingPR) {
      ghExec(["pr", "merge", existingPR, "--squash", "--delete-branch"]);
    } else {
      ghExec(["pr", "create", "--title", `Merge ${branch}`, "--body", "", "--base", "main"]);
      const prNum = ghq(["pr", "list", "--head", branch, "--json", "number", "-q", ".[0].number"]);
      ghExec(["pr", "merge", prNum, "--squash", "--delete-branch"]);
    }
    DB.executeAction(prActionId);
    console.log(green(`  ✔ Merged ${branch} → main`));
  } else {
    gitExec(state.repoPath, ["checkout", "main"]);
    gitExec(state.repoPath, ["merge", "--squash", branch]);
    gitExec(state.repoPath, ["commit", "-m", `Merge ${branch}`]);
    DB.logAction(state.proposalId, state.sessionId, "merge", `Merged ${branch} → main`, { branch, base:"main" });
    console.log(green(`  ✔ Merged locally. Push main when ready.`));
  }
}

// ── Commit staged files (user-gated) ─────────────────────────────────────────

async function commitStagedFiles(title, stagedPaths, rounds) {
  if (!state.repoPath || !inGitRepo(state.repoPath)) return;
  if (!stagedPaths.length) return;

  console.log("");
  const go = await confirm(`  Commit ${stagedPaths.length} staged file(s)?`);
  if (!go) { crucibleSay("Files remain staged — commit when ready."); return; }

  const branchAns = await ask("  Branch:", { defaultVal: currentBranch(state.repoPath) });
  let target;
  try {
    target = validateBranchName(branchAns.trim() || currentBranch(state.repoPath));
  } catch (e) {
    crucibleSay(red(`Invalid branch name: ${e.message}`)); return;
  }

  if (target !== currentBranch(state.repoPath)) {
    if (gitq(state.repoPath, ["branch", "--list", target])) {
      gitExec(state.repoPath, ["checkout", target]);
    } else {
      gitExec(state.repoPath, ["checkout", "-b", target]);
      console.log(green(`  ✔ Created branch: ${target}`));
      DB.logAction(state.proposalId, state.sessionId, "branch", `Created branch ${target}`, { branch: target });
    }
  }

  const msg = `feat: ${title.slice(0, 72)}`;
  const actionId = DB.logAction(state.proposalId, state.sessionId, "commit", msg, { files: stagedPaths });
  gitExec(state.repoPath, ["commit", "-m", msg]);
  DB.executeAction(actionId);
  console.log(green(`  ✔ Committed ${stagedPaths.length} file(s)`));

  const push = await confirm("  Push now?");
  if (push) {
    const remote = gitq(state.repoPath, ["remote"]) || "origin";
    const pushId = DB.logAction(state.proposalId, state.sessionId, "push", `Push ${target}`, { branch: target });
    gitExec(state.repoPath, ["push", "-u", remote, currentBranch(state.repoPath)]);
    DB.executeAction(pushId);
    console.log(green("  ✔ Pushed"));
  }
}

// ── Stage + commit after a debate ─────────────────────────────────────────────

async function offerStagingAndCommit(task, finalPlan, round) {
  if (!state.repoPath || !inGitRepo(state.repoPath)) {
    await offerCommitSpec(task, finalPlan, round);
    return;
  }

  const stage = await confirm("  Stage and implement these changes in the repo?");
  if (stage) {
    const r = await runStagingFlow({
      proposalId:       state.proposalId,
      repoPath:         state.repoPath,
      plan:             finalPlan,
      repoUnderstanding: state.repoContext,
      onStatus:         msg => systemMsg(msg),
    });
    if (r.staged.length) await commitStagedFiles(task, r.staged, round);
  } else {
    await offerCommitSpec(task, finalPlan, round);
  }
}

// ── Proposal flow ─────────────────────────────────────────────────────────────

async function proposalFlow() {
  console.log("");
  crucibleSay("What's your proposal? Describe what you want to build or change.");
  console.log(dim("  (As rough or detailed as you like — GPT and Claude will refine it together first)"));
  console.log("");

  const rawProposal = await ask("  ›");
  if (!rawProposal.trim()) return;

  DB.logMessage(state.proposalId, "user", rawProposal, { phase: "proposal" });
  DB.updateProposal(state.proposalId, { title: rawProposal.slice(0, 80) });

  // ── Refinement phase: GPT critique → Claude response → GPT synthesis ─────────

  const refinement = await refineProposal(rawProposal);

  if (!refinement.accepted) {
    crucibleSay("Proposal saved — come back to it any time.");
    return;
  }

  const proposalForDebate = refinement.refined;
  const taskContext = [
    `Project: ${state.project || "unspecified"}`,
    ``,
    `Proposal (refined):`,
    proposalForDebate,
    rawProposal !== proposalForDebate
      ? `\nOriginal rough idea:\n${rawProposal}`
      : "",
  ].filter(Boolean).join("\n");

  // ── Debate loop ───────────────────────────────────────────────────────────────

  let currentContext = taskContext;

  while (true) {
    const result = await runDebate(currentContext);

    if (result.done) {
      console.log(""); console.log(hr("═"));
      console.log(bold(green(`\n  ✅ Plan ${result.reason} after ${result.round} round(s). Writing final plan...\n`)));

      const finalPlan = await synthesise(result.gptMsgs);

      console.log(hr("═")); console.log(bold(mag("\n  Final Plan\n")));
      finalPlan.split("\n").forEach(l => console.log(`  ${l}`));
      console.log(""); console.log(hr("═")); console.log("");

      DB.updateProposal(state.proposalId, { finalPlan, status: "complete", rounds: result.round });

      await offerStagingAndCommit(proposalForDebate.slice(0, 60), finalPlan, result.round);
      await offerMergeToMain();
      break;
    }

    console.log(bold(yellow(`\n  ↺ Restarting with: ${result.newDirection}\n`)));
    currentContext = `${taskContext}\n\nUser restarted with new direction: ${result.newDirection}`;
    DB.logMessage(state.proposalId, "user", `Restart: ${result.newDirection}`, { phase: "debate" });
  }
}

// ── History viewer ────────────────────────────────────────────────────────────

async function cmdHistory() {
  console.log("");
  console.log(`  ${cyan("1")}  Recent sessions`);
  console.log(`  ${cyan("2")}  All proposals`);
  console.log(`  ${cyan("3")}  All actions`);
  console.log(`  ${cyan("0")}  Back`);
  console.log("");

  const ans = (await ask("  ›")).trim();

  if (ans === "1") {
    const sessions = DB.listSessions();
    console.log("");
    if (!sessions.length) { console.log(dim("  No sessions yet.")); }
    else {
      sessions.forEach(s => {
        console.log(`  ${dim(s.started_at.slice(0,16))}  ${bold(s.project||"(untitled)")}  ${dim(s.repo_path||"")}`);
      });
    }
  }

  if (ans === "2") {
    const proposals = DB.allProposals();
    console.log("");
    if (!proposals.length) { console.log(dim("  No proposals yet.")); }
    else {
      proposals.forEach(p => {
        const status = p.status === "complete" ? green("✔") : yellow("○");
        console.log(`  ${status}  ${dim(p.created_at.slice(0,16))}  ${bold(p.title)}  ${dim(p.project||"")}`);
      });
    }
  }

  if (ans === "3") {
    const actions = DB.allActions();
    console.log("");
    if (!actions.length) { console.log(dim("  No actions yet.")); }
    else {
      actions.forEach(a => {
        const icon = a.status === "executed" ? green("✔") : a.status === "skipped" ? dim("–") : yellow("○");
        console.log(`  ${icon}  ${dim(a.created_at.slice(0,16))}  ${bold(a.type.padEnd(12))}  ${a.description||""}`);
      });
    }
  }

  console.log("");
  done();
}


// ── Repo info & change log ────────────────────────────────────────────────────

async function cmdRepoInfo() {
  if (!state.repoPath) {
    crucibleSay("No repo loaded — use option 5 to set one first.");
    return;
  }

  const summary = getRepoSummary(state.repoPath);
  if (!summary) {
    crucibleSay("No cached understanding yet — enter the repo first.");
    return;
  }

  console.log("");
  console.log(hr("═"));
  console.log(bold(cyan("\n  Repo Understanding\n")));
  console.log(`  ${dim("Path:")}     ${state.repoPath}`);
  console.log(`  ${dim("Stack:")}    ${summary.stackSummary || "unknown"}`);
  console.log(`  ${dim("Language:")} ${summary.primaryLanguage || "unknown"}`);
  console.log(`  ${dim("Files:")}    ${summary.fileCount || "?"}`);
  console.log(`  ${dim("Commits logged:")} ${summary.changeCount}`);
  console.log(`  ${dim("Last accessed:")}  ${summary.lastAccessed}`);
  console.log(`  ${dim("Last commit:")}    ${summary.lastCommitHash?.slice(0,8) || "unknown"}`);
  console.log("");
  console.log(hr("·"));
  console.log("");
  summary.understanding.split("\n").forEach(l => console.log(`  ${l}`));
  console.log("");

  console.log(hr("·"));
  console.log(bold(cyan("\n  Change Log\n")));

  const changes = getChangeLog(state.repoPath, 30);
  if (!changes.length) {
    console.log(dim("  No changes recorded yet."));
  } else {
    for (const ch of changes) {
      const hash  = ch.commit_hash?.slice(0, 8) || "????????";
      const date  = ch.commit_date?.slice(0, 16) || "unknown date";
      const files = ch.filesChanged?.length ? dim(` [${ch.filesChanged.length} file(s)]`) : "";
      console.log(`  ${dim(date)}  ${yellow(hash)}  ${ch.message}${files}`);
      if (ch.diff_summary && ch.diff_summary !== ch.message) {
        console.log(`             ${dim(ch.diff_summary.slice(0, 80))}`);
      }
    }
    if (changes.length === 30) console.log(dim("\n  (showing latest 30 — full log in crucible.db)"));
  }
  console.log("");
  console.log(hr("═"));
  console.log("");

  // Sub-menu
  console.log(`  ${cyan("1")}  Refresh understanding now`);
  console.log(`  ${cyan("0")}  Back`);
  console.log("");
  const ans = (await ask("  ›")).trim();
  if (ans === "1") {
    state.repoContext = await loadRepoContext(state.repoPath, state.repoUrl);
  }
}

// ── Git menu ──────────────────────────────────────────────────────────────────

async function cmdGit() {
  const repoPath = state.repoPath || process.cwd();
  if (!inGitRepo(repoPath)) { crucibleSay(red("Not inside a git repo.")); done(); return; }
  if (!ghInstalled())       { crucibleSay(red("Run setup-crucible-git.sh first.")); done(); return; }

  let running = true;
  while (running) {
    const branch = currentBranch(repoPath);
    console.log(""); console.log(hr());
    const repoRemote = gitq(repoPath, ["remote", "get-url", "origin"]) || "(no remote)";
    console.log(`  ${dim("repo:")} ${repoRemote}   ${dim("branch:")} ${yellow(branch)}`);
    console.log(hr());

    const items = ["Switch branch","Create new branch","Pull latest","Push current branch","Clone a repo","View open PRs","Create pull request","Squash & merge a PR","Merge current branch to main"];
    console.log(bold(cyan("\n  Git\n")));
    items.forEach((o,i) => console.log(`  ${bold(cyan(String(i+1)))}  ${o}`));
    console.log(`  ${bold(cyan("0"))}  Exit`); console.log("");
    const choice = parseInt((await ask("  ›")).trim());
    if (!choice || choice === 0) { running = false; break; }

    switch (choice - 1) {
      case 0: {
        const branches = gitq(repoPath, ["branch", "-a", "--format=%(refname:short)"])
          .split("\n").filter(b=>b&&b!==branch).map(b=>b.replace(/^origin\//,"")).filter((b,i,a)=>a.indexOf(b)===i);
        if (!branches.length) { console.log(yellow("\n  No other branches.\n")); break; }
        branches.forEach((b,i)=>console.log(`  ${cyan(String(i+1))}  ${b}`));
        const p = parseInt((await ask("  ›")).trim()) - 1;
        if (p >= 0 && p < branches.length) {
          gitExec(repoPath, ["checkout", branches[p]]);
          DB.logAction(state.proposalId, state.sessionId, "branch", `Switched to ${branches[p]}`, { branch: branches[p] });
          console.log(green(`\n  ✔ Switched to ${branches[p]}\n`));
        }
        break;
      }
      case 1: {
        const nameRaw = await ask("  New branch name:");
        if (nameRaw.trim()) {
          let safeName;
          try { safeName = validateBranchName(nameRaw.trim()); }
          catch (e) { console.log(red(`\n  ${e.message}\n`)); break; }
          gitExec(repoPath, ["checkout", "-b", safeName]);
          DB.logAction(state.proposalId, state.sessionId, "branch", `Created ${safeName}`, { branch: safeName });
          console.log(green(`\n  ✔ Created ${safeName}\n`));
        }
        break;
      }
      case 2: gitExec(repoPath, ["pull"]); console.log(green("\n  ✔ Pulled\n")); break;
      case 3: {
        const remote = gitq(repoPath, ["remote"]) || "origin";
        gitExec(repoPath, ["push", "-u", remote, currentBranch(repoPath)]);
        DB.logAction(state.proposalId, state.sessionId, "push", `Pushed ${currentBranch(repoPath)}`, {});
        console.log(green("\n  ✔ Pushed\n")); break;
      }
      case 4: {
        const url = await ask("  Repo URL:");
        if (url.trim()) { ghExec(["repo", "clone", url.trim()]); console.log(green("\n  ✔ Cloned\n")); }
        break;
      }
      case 5: console.log(""); ghExec(["pr", "list"]); console.log(""); break;
      case 6: {
        const title = await ask("  PR title:");
        const body  = await ask("  Description:");
        const base  = await ask("  Base branch:", { defaultVal:"main" });
        if (title.trim()) {
          ghExec(["pr", "create", "--title", title.trim(), "--body", body.trim(), "--base", base.trim() || "main"]);
          DB.logAction(state.proposalId, state.sessionId, "pr", title.trim(), { base });
          console.log(green("\n  ✔ PR created\n"));
        }
        break;
      }
      case 7: {
        const prs = ghq(["pr", "list", "--json", "number,title,headRefName",
          "--template", "{{range .}}{{.number}}|{{.title}}|{{.headRefName}}\n{{end}}"
        ]).split("\n").filter(Boolean);
        if (!prs.length) { console.log(yellow("  No open PRs.\n")); break; }
        prs.forEach((p,i)=>{ const [num,,head]=p.split("|"); console.log(`  ${cyan(String(i+1))}  #${num} — ${head}`); });
        const p = parseInt((await ask("  ›")).trim()) - 1;
        if (p >= 0 && p < prs.length) {
          const prNum = prs[p].split("|")[0];
          ghExec(["pr", "merge", prNum, "--squash", "--delete-branch"]);
          DB.logAction(state.proposalId, state.sessionId, "merge", `Squash-merged PR #${prNum}`, { pr: prNum });
          console.log(green(`\n  ✔ PR #${prNum} squash-merged\n`));
        }
        break;
      }
      case 8: await offerMergeToMain(); break;
    }
  }
  done();
}

// ── Interactive session ───────────────────────────────────────────────────────

async function interactiveSession() {
  console.log("");
  box([
    bold("  crucible"),
    dim("  AI-powered planning with Claude & GPT"),
  ]);

  process.stdout.write(dim("\n  Loading models..."));
  const [gptModel, claudeModel] = await Promise.all([getLatestGPTModel(), getLatestClaudeModel()]);
  process.stdout.write("\r                  \r");

  state.gptModel    = gptModel;
  state.claudeModel = claudeModel;

  console.log(`  ${bold("GPT:")}    ${yellow(gptModel)}`);
  console.log(`  ${bold("Claude:")} ${blue(claudeModel)}`);
  console.log("");

  // Start session in DB
  state.sessionId = DB.createSession({ gptModel, claudeModel });

  // Project name
  crucibleSay("What project are we working on?");
  console.log("");
  const project = await ask("  ›");
  state.project = project.trim() || "Untitled project";
  DB.updateSession(state.sessionId, { project: state.project });

  console.log("");

  // Repo setup
  const wantsRepo = await confirm("  Do you have a repo to work with?", true);
  if (wantsRepo) await setupRepo();

  // Main loop
  let running = true;
  while (running) {
    console.log("");
    console.log(hr());
    console.log(bold(cyan(`\n  ${state.project}  ${state.repoPath ? dim("· " + state.repoPath) : ""}\n`)));
    console.log(`  ${cyan("1")}  New proposal`);
    console.log(`  ${cyan("2")}  Git / GitHub`);
    console.log(`  ${cyan("3")}  History`);
    console.log(`  ${cyan("4")}  Repo — understanding & change log`);
    console.log(`  ${cyan("5")}  Stage files from a previous plan`);
    console.log(`  ${cyan("6")}  Switch repo`);
    console.log(`  ${cyan("0")}  Exit`);
    console.log("");

    const ans = (await ask("  ›")).trim();

    if (ans === "1") {
      state.proposalId = DB.createProposal(state.sessionId, state.project, null);
      await proposalFlow();
    }
    else if (ans === "2") await cmdGit();
    else if (ans === "3") await cmdHistory();
    else if (ans === "4") await cmdRepoInfo();
    else if (ans === "5") {
      const props = DB.allProposals().filter(p => p.status === "complete" && p.repo_path === state.repoPath).slice(0, 8);
      if (!props.length) { crucibleSay("No completed proposals for this repo yet."); continue; }
      console.log("\n  Proposals:\n");
      props.forEach((p,i) => console.log(`  ${cyan(String(i+1))}  ${dim(p.created_at.slice(0,10))}  ${p.title}`));
      console.log(`  ${cyan("0")}  Cancel\n`);
      const pick = parseInt((await ask("  ›")).trim()) - 1;
      if (pick >= 0 && pick < props.length) {
        const p = props[pick];
        state.proposalId = p.id;
        const rewrites = await restageApproved(p.id, state.repoPath, { bold, dim, cyan, green, yellow, red, blue, hr });
        if (rewrites.length) {
          await commitStagedFiles(p.title, rewrites, p.rounds||0);
        } else if (p.final_plan) {
          const r = await runStagingFlow({ proposalId: p.id, repoPath: state.repoPath, plan: p.final_plan, repoUnderstanding: state.repoContext, onStatus: msg => systemMsg(msg) });
          if (r.staged.length) await commitStagedFiles(p.title, r.staged, p.rounds||0);
        }
      }
    }
    else if (ans === "6") await setupRepo();
    else if (ans === "0" || ans === "q" || ans === "exit") {
      DB.endSession(state.sessionId);
      crucibleSay("Session saved. See you next time.");
      running = false;
    }
    else {
      console.log(dim("  Enter 0–4."));
    }
  }

  done();
}

// ── models ────────────────────────────────────────────────────────────────────

async function cmdModels() {
  process.stdout.write("  Detecting...");
  const [gpt, claude] = await Promise.all([getLatestGPTModel(), getLatestClaudeModel()]);
  process.stdout.write("\r              \r");
  console.log(`\n  ${bold("GPT:")}    ${yellow(gpt)}\n  ${bold("Claude:")} ${blue(claude)}\n`);
  done();
}

// ── keys status ───────────────────────────────────────────────────────────────

function cmdKeysStatus() {
  const SERVICES = [
    { id: SERVICE_OPENAI,    label: "OpenAI   " },
    { id: SERVICE_ANTHROPIC, label: "Anthropic" },
  ];
  console.log(`\n  ${bold(cyan("crucible keys status"))}\n`);
  for (const { id, label } of SERVICES) {
    const src = getKeySource(id);
    const indicator = src === "not-set"
      ? red("✗ not set")
      : src === "env"       ? yellow("env var (legacy)")
      : src === "keychain"  ? green("keychain")
      : src === "file"      ? yellow("file (~/.config/crucible/keys/)")
      : src === "cache"     ? green("loaded (cache)")
      : src === "session-only" ? cyan("session-only (in memory)")
      : dim(src);
    console.log(`    ${bold(label)}  ${indicator}`);
  }
  console.log();
  done();
}

// ── help ──────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
  ${bold(cyan("crucible"))} — AI-powered planning sessions

  ${bold("Commands:")}
    ${bold("crucible")}              open interactive planning session
    ${bold("crucible plan")} ${dim('"task"')}  start a plan directly
    ${bold("crucible debate")} ${dim('"task"')} raw debate with inter-round controls
    ${bold("crucible git")}          GitHub/git menu
    ${bold("crucible history")}      browse past sessions, proposals, actions
    ${bold("crucible repo refresh")} force-rebuild repo knowledge for current dir
    ${bold("crucible keys status")}  show API key storage source (no values shown)
    ${bold("crucible models")}       show current model versions
    ${bold("crucible help")}         show this help

  ${bold("Database:")} ~/.local/share/crucible/crucible.db

  ${bold("Between debate rounds:")}
    1 continue   2 agreed summary   3 diff
    4 steer      5 accept early     6 reject & restart
  `);
  done();
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;
const arg = rest.join(" ");

switch (cmd) {
  case undefined:
  case "session":  await interactiveSession(); break;
  case "plan":     {
    // Quick-start plan mode: still needs models + session
    process.stdout.write(dim("  Loading..."));
    const [gm, cm] = await Promise.all([getLatestGPTModel(), getLatestClaudeModel()]);
    process.stdout.write("\r          \r");
    state.gptModel = gm; state.claudeModel = cm;
    state.sessionId  = DB.createSession({ gptModel: gm, claudeModel: cm, project: arg.slice(0,60) });
    state.proposalId = DB.createProposal(state.sessionId, arg.slice(0,60), null);
    if (!arg) { console.error(red('\n  Usage: crucible plan "task"\n')); done(); process.exit(1); }
    // Clarification phase then debate
    const claudeMsgsClarify = [{ role:"user", content:`You are opening a technical planning session. Ask 3–5 focused clarifying questions about the task. Number them. Do not start planning yet.\n\nTask: ${arg}` }];
    process.stdout.write(dim("  Claude thinking..."));
    const qs = await askClaude(claudeMsgsClarify);
    process.stdout.write("\r                    \r");
    console.log(""); console.log(bold(blue("  Claude:"))); console.log("");
    qs.split("\n").forEach(l => console.log(`    ${l}`)); console.log("");
    DB.logMessage(state.proposalId, "claude", qs, { phase:"clarification" });
    const answers = await ask("  Your answers:\n  ›");
    DB.logMessage(state.proposalId, "user", answers, { phase:"clarification" });
    let context = `Task: ${arg}\n\nClarifications: ${answers}`;
    while (true) {
      const result = await runDebate(context);
      if (result.done) {
        const plan = await synthesise(result.gptMsgs);
        console.log(hr("═")); console.log(bold(mag("\n  Final Plan\n")));
        plan.split("\n").forEach(l => console.log(`  ${l}`));
        console.log(""); console.log(hr("═")); console.log("");
        DB.updateProposal(state.proposalId, { finalPlan: plan, status:"complete", rounds: result.round });
        if (inGitRepo(process.cwd())) { state.repoPath = process.cwd(); await offerStagingAndCommit(arg.slice(0,60), plan, result.round); }
        break;
      }
      context = `Task: ${arg}\n\nUser restarted: ${result.newDirection}`;
    }
    DB.endSession(state.sessionId);
    done(); break;
  }
  case "debate":   {
    if (!arg) { console.error(red('\n  Usage: crucible debate "task"\n')); done(); process.exit(1); }
    process.stdout.write(dim("  Loading..."));
    const [gm, cm] = await Promise.all([getLatestGPTModel(), getLatestClaudeModel()]);
    process.stdout.write("\r          \r");
    state.gptModel = gm; state.claudeModel = cm;
    state.sessionId  = DB.createSession({ gptModel: gm, claudeModel: cm });
    state.proposalId = DB.createProposal(state.sessionId, arg.slice(0,60), null);
    const result = await runDebate(`Task: ${arg}`);
    if (result.done) {
      const plan = await synthesise(result.gptMsgs);
      console.log(hr("═")); console.log(bold(mag("\n  Final Plan\n")));
      plan.split("\n").forEach(l => console.log(`  ${l}`));
      console.log(""); console.log(hr("═")); console.log("");
      DB.updateProposal(state.proposalId, { finalPlan: plan, status:"complete", rounds: result.round });
      if (inGitRepo(process.cwd())) { state.repoPath = process.cwd(); await offerStagingAndCommit(arg.slice(0,60), plan, result.round); }
    }
    DB.endSession(state.sessionId);
    done(); break;
  }
  case "git":      { state.gptModel=""; state.claudeModel=""; await cmdGit(); break; }
  case "stage": {
    // Standalone staging: pick a recent proposal and (re-)run staging on it
    process.stdout.write(dim("  Loading..."));
    const [gm, cm] = await Promise.all([getLatestGPTModel(), getLatestClaudeModel()]);
    process.stdout.write("\r          \r");
    state.gptModel = gm; state.claudeModel = cm;
    // Show recent proposals
    const props = DB.allProposals().filter(p => p.status === "complete").slice(0, 10);
    if (!props.length) { console.log(red("\n  No completed proposals found.\n")); done(); break; }
    console.log("\n  Recent completed proposals:\n");
    props.forEach((p, i) => console.log(`  ${cyan(String(i+1))}  ${dim(p.created_at.slice(0,16))}  ${p.title}  ${dim(p.repo_path||"")}`));
    console.log(`  ${cyan("0")}  Cancel\n`);
    const pick = parseInt((await ask("  ›")).trim()) - 1;
    if (pick >= 0 && pick < props.length) {
      const p = props[pick];
      state.proposalId = p.id;
      state.repoPath   = p.repo_path || process.cwd();
      state.repoContext = DB.getRepoKnowledge ? DB.getRepoKnowledge?.(state.repoPath)?.understanding : null;
      const plan = p.final_plan;
      if (!plan) { console.log(red("\n  No final plan stored for this proposal.\n")); done(); break; }
      // Check for already-approved-but-unwritten files first
      const rewrites = await restageApproved(p.id, state.repoPath, { bold, dim, cyan, green, yellow, red, blue, hr });
      if (rewrites.length) {
        await commitStagedFiles(p.title, rewrites, p.rounds || 0);
      } else {
        await runStagingFlow({
          proposalId: p.id,
          repoPath:   state.repoPath,
          plan,
          repoUnderstanding: state.repoContext,
          onStatus: msg => systemMsg(msg),
        }).then(async r => {
          if (r.staged.length) await commitStagedFiles(p.title, r.staged, p.rounds || 0);
        });
      }
    }
    done(); break;
  }
  case "repo": {
    // crucible repo refresh [path]
    const subCmd = rest[0];
    if (subCmd === "refresh") {
      const repoPath = rest[1] ? resolve(rest[1]) : process.cwd();
      if (!inGitRepo(repoPath)) {
        console.error(red(`\n  Not a git repo: ${repoPath}\n`)); done(); process.exit(1);
      }
      process.stdout.write(dim("  Clearing cached understanding..."));
      clearRepoKnowledge(repoPath);
      process.stdout.write("\r                                  \r");
      // Need Claude model for re-analysis
      const cm = await getLatestClaudeModel();
      state.claudeModel = cm;
      crucibleSay(`Rebuilding understanding for ${yellow(repoPath)}...`);
      try {
        const result = await analyseRepo(repoPath, null, {
          claudeModel: cm,
          onStatus: msg => systemMsg(msg),
        });
        crucibleSay(`Done — ${dim(result.stackSummary || "understanding rebuilt")}`);
      } catch (e) {
        console.error(red(`\n  Repo analysis failed: ${e.message}\n`));
        done(); process.exit(1);
      }
    } else {
      console.error(red(`\n  Usage: crucible repo refresh [path]\n`));
      process.exit(1);
    }
    done(); break;
  }
  case "keys": {
    if (rest[0] === "status") { cmdKeysStatus(); break; }
    console.error(red(`\n  Usage: crucible keys status\n`)); process.exit(1);
  }
  case "history":  await cmdHistory(); break;
  case "models":   await cmdModels(); break;
  case "help": case "--help": case "-h": cmdHelp(); break;
  default:
    console.error(red(`\n  Unknown command: ${cmd}\n`)); cmdHelp(); process.exit(1);
}
