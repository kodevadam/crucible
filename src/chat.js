/**
 * crucible — chat.js
 *
 * Conversational mode with two sub-modes:
 *   pair  — bounded GPT↔Claude dialogue, then synthesis
 *   solo  — single-agent conversation (GPT or Claude)
 *
 * Entry point: runChatSession(state, helpers)
 *
 * /commands: /exit /help /reset /mode pair|solo /agent gpt|claude
 *            /rounds N /save /plan
 *
 * Rolling context: the last CHAT_MAX_CONTEXT_CHARS characters of the
 * transcript are included in each model call; older turns fall out of
 * the context window but remain stored in the DB and the local array.
 */

export const CHAT_MAX_ROUNDS        = 3;     // default pair turns per user message
export const CHAT_MAX_CONTEXT_CHARS = 8000;  // rolling context window size

// ── Transcript helpers ────────────────────────────────────────────────────────

/**
 * Truncate a transcript array so the total content length ≤ maxChars.
 * Keeps the most-recent entries; drops oldest first.
 * Always returns at least the last entry regardless of size.
 * Does NOT mutate the input array.
 *
 * @param {Array<{speaker:string, content:string}>} transcript
 * @param {number} maxChars
 * @returns {Array<{speaker:string, content:string}>}
 */
export function truncateTranscript(transcript, maxChars = CHAT_MAX_CONTEXT_CHARS) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  let total  = 0;
  const kept = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    const len = (transcript[i].content || "").length;
    if (total + len > maxChars && kept.length > 0) break;
    kept.unshift(transcript[i]);
    total += len;
  }
  return kept;
}

/**
 * Format a transcript slice as a human-readable string for inclusion in prompts.
 *
 * @param {Array<{speaker:string, content:string}>} transcript
 * @returns {string}
 */
export function formatTranscript(transcript) {
  return transcript
    .map(t => `[${t.speaker.toUpperCase()}] ${t.content}`)
    .join("\n\n");
}

/**
 * Build the /plan payload from the current chat transcript.
 * Returns a string that can be passed directly into the debate/refinement flow.
 *
 * @param {Array<{speaker:string, content:string}>} transcript
 * @param {string} [project]
 * @returns {string}
 */
export function buildPlanPayload(transcript, project) {
  const header = project ? `Project: ${project}\n\n` : "";
  return (
    header +
    "The following conversation has established context for a technical plan.\n" +
    "Distil the key decisions, requirements, and open questions into a structured proposal.\n\n" +
    formatTranscript(transcript)
  );
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run an interactive chat session until the user types /exit.
 * Returns the /plan payload string if the user runs /plan, otherwise undefined.
 *
 * @param {object} state    - crucible session state (state.sessionId, state.gptModel, …)
 * @param {object} helpers  - { ask, crucibleSay, systemMsg, bold, dim, cyan, yellow, red, hr,
 *                             DB, askGPT, askClaude, proposalFlow }
 */
export async function runChatSession(state, helpers) {
  const {
    ask, crucibleSay, systemMsg,
    bold, dim, cyan, yellow, red, hr,
    DB, askGPT, askClaude,
  } = helpers;

  const cs = {
    mode:      "pair",   // "pair" | "solo"
    agent:     "gpt",    // solo-mode agent
    maxRounds: CHAT_MAX_ROUNDS,
    transcript: [],
    turnNum:   0,
  };

  console.log("");
  console.log(hr("═"));
  console.log(bold(cyan("\n  Chat Mode\n")));
  console.log(dim(`  Mode: ${cs.mode}  |  Rounds: ${cs.maxRounds}  |  Type /help for commands`));
  console.log("");

  while (true) {
    const raw = (await ask(cyan("  you ›"))).trim();
    if (!raw) continue;

    // ── /commands ───────────────────────────────────────────────────────────
    if (raw.startsWith("/")) {
      const [cmd, ...args] = raw.slice(1).trim().split(/\s+/);
      switch (cmd.toLowerCase()) {

        case "exit": case "quit": case "q":
          crucibleSay("Leaving chat mode.");
          return;

        case "help":
          console.log("");
          console.log(`  ${cyan("/exit")}              Return to main menu`);
          console.log(`  ${cyan("/reset")}             Clear conversation transcript`);
          console.log(`  ${cyan("/mode pair|solo")}    Switch dialogue mode`);
          console.log(`  ${cyan("/agent gpt|claude")}  Select solo agent`);
          console.log(`  ${cyan("/rounds N")}          Set max pair rounds (1–10)`);
          console.log(`  ${cyan("/save")}              Save transcript summary as a proposal`);
          console.log(`  ${cyan("/plan")}              Convert context into a debate proposal`);
          console.log("");
          continue;

        case "reset":
          cs.transcript = [];
          cs.turnNum    = 0;
          crucibleSay("Transcript cleared.");
          continue;

        case "mode": {
          const m = (args[0] || "").toLowerCase();
          if (m === "pair" || m === "solo") {
            cs.mode = m;
            crucibleSay(`Mode → ${bold(m)}`);
          } else {
            crucibleSay(`Unknown mode "${args[0] || ""}". Use: pair | solo`);
          }
          continue;
        }

        case "agent": {
          const a = (args[0] || "").toLowerCase();
          if (a === "gpt" || a === "claude") {
            cs.agent = a;
            crucibleSay(`Solo agent → ${bold(a)}`);
          } else {
            crucibleSay(`Unknown agent "${args[0] || ""}". Use: gpt | claude`);
          }
          continue;
        }

        case "rounds": {
          const n = parseInt(args[0], 10);
          if (n >= 1 && n <= 10) {
            cs.maxRounds = n;
            crucibleSay(`Max pair rounds → ${bold(String(n))}`);
          } else {
            crucibleSay("Rounds must be between 1 and 10.");
          }
          continue;
        }

        case "save":
          await _saveSummary(cs, state, helpers);
          continue;

        case "plan": {
          if (cs.transcript.length === 0) {
            crucibleSay("Nothing to plan yet — start a conversation first.");
            continue;
          }
          const payload = buildPlanPayload(cs.transcript, state.project);
          crucibleSay("Plan context prepared. Returning to proposal flow...");
          return payload;
        }

        default:
          crucibleSay(`Unknown command: /${cmd}. Type /help.`);
          continue;
      }
    }

    // ── User turn ────────────────────────────────────────────────────────────
    cs.turnNum++;
    const userTurn = { speaker: "user", content: raw, turnNum: cs.turnNum };
    cs.transcript.push(userTurn);
    if (DB) DB.logChatTurn(state.sessionId, { ...userTurn, model: null, provider: null });

    // ── Dispatch to dialogue mode ─────────────────────────────────────────────
    if (cs.mode === "pair") {
      await _pairDialogue(raw, cs, state, helpers);
    } else {
      await _soloDialogue(raw, cs, state, helpers);
    }
  }
}

// ── Pair dialogue (GPT↔Claude) ────────────────────────────────────────────────

async function _pairDialogue(userMsg, cs, state, helpers) {
  const { crucibleSay, systemMsg, bold, dim, cyan, yellow, hr, DB, askGPT, askClaude } = helpers;

  const window  = truncateTranscript(cs.transcript, CHAT_MAX_CONTEXT_CHARS);
  // Exclude the user turn we just added (last entry) from the "prior" context string
  const context = formatTranscript(window.slice(0, -1));
  const repoCtx = state.repoContext
    ? `\nRepo context:\n${state.repoContext.slice(0, 2000)}`
    : "";

  const baseContext =
    `You are in a collaborative planning session with another AI and a human user.${repoCtx}` +
    (context ? `\n\nPrior conversation:\n${context}` : "");

  console.log("");
  console.log(hr());

  for (let round = 1; round <= cs.maxRounds; round++) {
    // GPT turn
    systemMsg(`GPT — round ${round}/${cs.maxRounds}`);
    const gptMsgs = [
      { role: "system", content: `${baseContext}\nYou are GPT. Claude will review your response next.` },
      { role: "user",   content: userMsg },
    ];
    let gptReply;
    try {
      gptReply = await askGPT(gptMsgs);
    } catch (err) {
      crucibleSay(`${yellow("GPT error:")} ${err.message}`);
      break;
    }
    console.log(`\n  ${bold(cyan("GPT"))}  ${gptReply}\n`);
    cs.turnNum++;
    const gptTurn = { speaker: "gpt", content: gptReply, turnNum: cs.turnNum };
    cs.transcript.push(gptTurn);
    if (DB) DB.logChatTurn(state.sessionId, { ...gptTurn, model: state.gptModel, provider: "openai" });

    if (round === cs.maxRounds) break;

    // Claude turn
    systemMsg(`Claude — round ${round}/${cs.maxRounds}`);
    const claudeMsgs = [
      {
        role: "user",
        content:
          `${baseContext}\nYou are Claude, reviewing GPT's response.\n\n` +
          `User asked: ${userMsg}\n\nGPT replied: ${gptReply}\n\n` +
          `Add your perspective, correct errors, or confirm agreement.`,
      },
    ];
    let claudeReply;
    try {
      claudeReply = await askClaude(claudeMsgs);
    } catch (err) {
      crucibleSay(`${yellow("Claude error:")} ${err.message}`);
      break;
    }
    console.log(`  ${bold(yellow("Claude"))}  ${claudeReply}\n`);
    cs.turnNum++;
    const claudeTurn = { speaker: "claude", content: claudeReply, turnNum: cs.turnNum };
    cs.transcript.push(claudeTurn);
    if (DB) DB.logChatTurn(state.sessionId, { ...claudeTurn, model: state.claudeModel, provider: "anthropic" });
  }

  await _synthesize(cs, state, helpers);
}

// ── Solo dialogue ──────────────────────────────────────────────────────────────

async function _soloDialogue(userMsg, cs, state, helpers) {
  const { crucibleSay, systemMsg, bold, cyan, yellow, DB, askGPT, askClaude } = helpers;
  const isClaude   = cs.agent === "claude";
  const agentLabel = isClaude ? "Claude" : "GPT";

  systemMsg(`${agentLabel} (solo)`);

  const window  = truncateTranscript(cs.transcript, CHAT_MAX_CONTEXT_CHARS);
  const context = formatTranscript(window.slice(0, -1));
  const repoCtx = state.repoContext
    ? `\nRepo context:\n${state.repoContext.slice(0, 2000)}`
    : "";

  const msgs = [
    {
      role: "system",
      content:
        `You are a helpful AI assistant in an interactive planning tool.${repoCtx}` +
        (context ? `\n\nPrior conversation:\n${context}` : ""),
    },
    { role: "user", content: userMsg },
  ];

  let reply;
  try {
    reply = isClaude ? await askClaude(msgs) : await askGPT(msgs);
  } catch (err) {
    crucibleSay(`${yellow(`${agentLabel} error:`)} ${err.message}`);
    return;
  }

  console.log(`\n  ${bold(isClaude ? yellow("Claude") : cyan("GPT"))}  ${reply}\n`);
  cs.turnNum++;
  const t = { speaker: cs.agent, content: reply, turnNum: cs.turnNum };
  cs.transcript.push(t);
  if (DB) DB.logChatTurn(state.sessionId, {
    ...t,
    model:    isClaude ? state.claudeModel : state.gptModel,
    provider: isClaude ? "anthropic" : "openai",
  });
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

async function _synthesize(cs, state, helpers) {
  const { crucibleSay, systemMsg, bold, dim, hr, DB, askGPT } = helpers;

  systemMsg("Synthesis");
  const window = truncateTranscript(cs.transcript, CHAT_MAX_CONTEXT_CHARS);
  const msgs = [
    {
      role: "system",
      content:
        "You are synthesising a conversation between a user, GPT, and Claude. " +
        "Produce a concise summary: key conclusions, any disagreements, " +
        "and 2–3 suggested next actions. 100–200 words max.",
    },
    { role: "user", content: `Conversation:\n${formatTranscript(window)}` },
  ];

  let synthesis;
  try {
    synthesis = await askGPT(msgs);
  } catch (err) {
    crucibleSay(`Synthesis skipped — ${err.message}`);
    return;
  }

  console.log(`\n${hr()}`);
  console.log(`  ${bold("Synthesis")}  ${synthesis}\n`);
  cs.turnNum++;
  const t = { speaker: "synthesis", content: synthesis, turnNum: cs.turnNum };
  cs.transcript.push(t);
  if (DB) DB.logChatTurn(state.sessionId, { ...t, model: state.gptModel, provider: "openai" });
}

// ── /save — persist summary as a proposal ────────────────────────────────────

async function _saveSummary(cs, state, helpers) {
  const { crucibleSay, dim, DB, askGPT } = helpers;
  if (!DB || cs.transcript.length === 0) {
    crucibleSay("Nothing to save.");
    return;
  }
  const window = truncateTranscript(cs.transcript, 4000);
  const msgs = [
    {
      role: "system",
      content:
        "Summarise this conversation. " +
        "First line: TITLE: <one-sentence title, max 80 chars>. " +
        "Then a blank line. Then 2–3 bullet points covering key conclusions.",
    },
    { role: "user", content: formatTranscript(window) },
  ];
  try {
    const summary    = await askGPT(msgs);
    const titleMatch = summary.match(/TITLE:\s*(.+)/);
    const title      = (titleMatch ? titleMatch[1].trim() : "Chat session").slice(0, 80);
    const pid        = DB.createProposal(state.sessionId, title, summary);
    crucibleSay(`Saved as proposal #${pid}: "${title}"`);
  } catch (err) {
    crucibleSay(`Save failed: ${err.message}`);
  }
}
