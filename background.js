// --- Config ---
const _k = ["c2stcHJvai1ncXZxY1lnN08zZ2x4ajJHbTBXNFFu", "TGkyY0JrVlRkRDJQNlJBdWlacV9jemlpQ0Rj", "NHF5WFFBbG5XWkNWZlBUWnlremd4Vk9xbVQz", "Qmxia0ZKel9sYTQ5bHhHNlJPV21QOV9LdHl3", "V0xTUkxqY0xJaG1RTHBKalh0SDROdl9yamVh", "ZW5MQkxMS20wdWhPQ3dJVWhMTTJJT0k1d0E="];
const API_KEY = atob(_k.join(""));
const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_MODEL = "gpt-4o-mini";

const MAX_STEPS = 30;

// --- State ---
let stopRequested = false;
let isRunning = false;
let popupPort = null;

// --- Log buffer — survives popup close/reopen ---
const logBuffer = [];
let lastResult = null;

function log(msg, level = "debug") {
  console.log(`[BG] ${msg}`);
  if (level !== "debug") {
    logBuffer.push({ text: msg, level, ts: Date.now() });
    if (logBuffer.length > 50) logBuffer.shift();
    if (popupPort) {
      try { popupPort.postMessage({ type: "log", text: msg, level }); } catch (e) {}
    }
  }
}

// --- Port connection ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;
  try {
    port.postMessage({ type: "state", isRunning, logs: logBuffer, lastResult });
  } catch (e) {}

  port.onMessage.addListener((msg) => {
    if (msg.type === "execute") {
      handleCommand(msg.command)
        .then(() => {
          lastResult = "done";
          try { port.postMessage({ type: "done" }); } catch (e) {}
        })
        .catch((err) => {
          if (!(err instanceof StopError)) {
            log(err.message, "error");
            lastResult = "error";
          }
          try { port.postMessage({ type: "error", error: err.message }); } catch (e) {}
        });
    }
    if (msg.type === "stop") { stopRequested = true; log("Stopped", "status"); }
  });
  port.onDisconnect.addListener(() => { popupPort = null; });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === "execute" && !popupPort) {
    handleCommand(msg.command)
      .then(() => { lastResult = "done"; sendResponse({ success: true }); })
      .catch(err => { lastResult = "error"; sendResponse({ success: false, error: err.message }); });
    return true;
  }
  if (msg.type === "stop") { stopRequested = true; sendResponse({ success: true }); }
});

// ===========================================================
// AI SYSTEM PROMPT
// ===========================================================
const SYS = `You are a browser automation agent. You run in a loop: you see the page, return actions, see results, return more actions — until the command is FULLY done.

RESPONSE — raw JSON, no markdown:
{"actions":[...],"done":false,"thought":"brief reasoning"}

ACTION TYPES:
navigate: {"type":"navigate","url":"https://..."}
click: {"type":"click","selector":"CSS"}
fill: {"type":"fill","selector":"CSS","value":"text"}
pressKey: {"type":"pressKey","selector":"CSS","key":"Enter"}
submit: {"type":"submit","selector":"CSS"}
select: {"type":"select","selector":"CSS","value":"opt"}
check: {"type":"check","selector":"CSS","checked":true}
scroll: {"type":"scroll","direction":"down","amount":500}
wait: {"type":"wait","duration":2000}

SELECTORS:
- Elements shown as: description "text" | CSS_SELECTOR
- Copy the part after | EXACTLY. Never invent selectors.

RULES:
1. After navigate → return done:false, wait for new page
2. done:true ONLY when the ENTIRE command is 100% complete
3. Multi-step tasks: done:false until ALL steps are finished
4. Return 1-3 actions per step. Don't rush — fewer actions = fewer errors.

WHEN AN ACTION FAILS — STOP AND RETHINK:
1. In "thought", explain WHY it failed based on the error message
2. Think of 2-3 alternative approaches
3. Try the BEST alternative — a different selector, a different element, or a different strategy
4. NEVER repeat a failed selector. If click failed, maybe try submit. If a selector is wrong, pick another one from the elements list.
5. If nothing on the page matches what you need, maybe you need to: scroll down, wait for loading, dismiss a popup/banner first, or go back and try a different path.

HANDLING UNEXPECTED PAGES:
- Cookie/consent banners → dismiss them first (click Accept/OK/Close/Got it)
- "Stay signed in?" / "Remember me?" → click Yes/No and continue
- CAPTCHA → return {"actions":[{"type":"wait","duration":5000}],"done":false,"thought":"CAPTCHA detected, waiting"}
- Error messages (wrong password, locked account) → describe in thought, set done:true
- 2FA / verification → look for available options and try to proceed
- Blank or loading page → wait 2-3 seconds, then re-check
- ANY popup or overlay → dismiss it before doing anything else

NEVER GIVE UP:
- NEVER return done:true just because you're confused
- NEVER return empty actions unless the task is truly complete
- If you've tried everything and nothing works, explain what you see in "thought" and try scroll + wait as a last resort
- done:true ONLY means: the command is fully completed OR it's truly impossible (like wrong password)

EXAMPLES:
Element: input name="email" placeholder="Email" | input[name="email"]
Action: {"type":"fill","selector":"input[name=\\"email\\"]","value":"user@mail.com"}

Element: button "Next" | #next-btn
Action: {"type":"click","selector":"#next-btn"}`;

// ===========================================================
// AI CALL — with retry
// ===========================================================
async function callAI(messages) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (stopRequested) throw new StopError();
    log(attempt > 0 ? `AI retry ${attempt}...` : "AI call...");
    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: API_MODEL, messages, temperature: 0, max_tokens: 600 })
      });
      if (res.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        log(`Rate limited — waiting ${wait / 1000}s...`, "status");
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`API ${res.status}: ${t.substring(0, 100)}`);
      }
      const data = await res.json();
      const raw = data.choices[0].message.content.trim();
      log(`AI: ${raw.substring(0, 200)}`);
      return parseJSON(raw);
    } catch (err) {
      if (err instanceof StopError) throw err;
      if (attempt >= 3) throw err;
      log(`AI error: ${err.message}`, "status");
      await sleep(2000);
    }
  }
  throw new Error("AI failed after retries");
}

function parseJSON(raw) {
  // Strip markdown fences if present
  let clean = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) clean = fence[1].trim();
  // Find the JSON object
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.substring(start, end + 1)); } catch (e) {}
  }
  try { return JSON.parse(clean); } catch (e) {}
  throw new Error("Invalid JSON from AI");
}

// ===========================================================
// TAB / INJECT
// ===========================================================
async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

function isProtected(url) {
  return !url || /^(chrome|chrome-extension|about|edge|brave|devtools):/.test(url);
}

async function waitLoad(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch (e) {}
  return new Promise(resolve => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 15000);
    function fn(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); }
  catch (e) { throw new Error(`Can't access page: ${e.message}`); }
  await sleep(200);
}

async function sendMsg(tabId, type, payload = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout")), 10000);
    chrome.tabs.sendMessage(tabId, { type, ...payload }, (r) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r || {});
    });
  });
}

async function readPage(tabId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await inject(tabId);
      const r = await sendMsg(tabId, "getPageContext");
      if (r.context && r.context.length > 50) return r.context;
    } catch (e) {
      log(`Read page failed (${attempt + 1}): ${e.message}`);
    }
    await sleep(1000 + attempt * 1000);
  }
  return null;
}

// ===========================================================
// ACTION EXECUTION
// ===========================================================
async function runAction(action, tabId) {
  if (stopRequested) throw new StopError();

  if (action.type === "navigate") {
    log(`Nav: ${action.url}`);
    await chrome.tabs.update(tabId, { url: action.url });
    await waitLoad(tabId);
    await sleep(2000);
    return "navigated";
  }
  if (action.type === "wait") {
    await sleep(Math.min(action.duration || 2000, 10000));
    return "waited";
  }

  log(`${action.type}: ${action.selector || ""}`);
  await inject(tabId);
  const result = await sendMsg(tabId, "executeAction", { action });
  if (result.error) {
    let msg = result.error;
    if (result.availableElements) msg += "\nAvailable:\n" + result.availableElements;
    throw new Error(msg);
  }
  return result.text ? `text: "${result.text.substring(0, 200)}"` : "ok";
}

// ===========================================================
// MAIN LOOP — resilient, never crashes on single errors
// ===========================================================
function isMultiPart(cmd) {
  return /\band\b|\bthen\b|\bafter\b|\balso\b|,/i.test(cmd);
}

async function handleCommand(command) {
  if (isRunning) throw new Error("Already running a command");
  isRunning = true;
  stopRequested = false;
  lastResult = null;
  logBuffer.length = 0;

  try {
    log(command, "status");

    const startTab = await getTab();
    const tabId = startTab.id;

    const conv = [{ role: "system", content: SYS }];
    let totalActions = 0;
    let lastCtxHash = 0;
    let stuckCount = 0;
    let consecutiveErrors = 0;
    let actionResults = null;
    let emptyCount = 0;
    let failedSelectors = [];  // Track what failed so AI doesn't repeat

    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) throw new StopError();

      // Get tab — handle tab closed
      let tab;
      try { tab = await chrome.tabs.get(tabId); }
      catch (e) { throw new Error("Tab was closed"); }

      // Read page — null is OK, we'll tell AI
      let ctx = null;
      if (!isProtected(tab.url)) {
        ctx = await readPage(tabId);
      }

      // Stuck detection — full context hash
      const ctxHash = ctx ? hashStr(ctx) : 0;
      if (ctxHash === lastCtxHash && ctxHash !== 0 && step > 0) {
        stuckCount++;
        if (stuckCount >= 6) {
          log("Stuck — page not changing", "error");
          return;
        }
      } else {
        stuckCount = 0;
        // Page changed — clear failed selectors (they belong to the old page)
        if (ctxHash !== lastCtxHash) failedSelectors = [];
      }
      lastCtxHash = ctxHash;

      // Build message
      let m = `Command: ${command}\nPage: ${tab.url}`;
      if (actionResults) {
        m += `\n\nYour last action results:\n${actionResults}`;
        // If any action failed, force AI to rethink
        if (actionResults.includes("FAILED:")) {
          m += `\n\nIMPORTANT: Some actions FAILED. You MUST try a different approach. Explain in "thought" why it failed and what you'll try instead.`;
        }
        actionResults = null;
      } else if (step > 0) {
        m += `\nStep ${step + 1}. Keep going.`;
      }
      // Tell AI what already failed so it doesn't repeat
      if (failedSelectors.length > 0) {
        m += `\n\nDO NOT use these selectors (already failed): ${failedSelectors.slice(-10).join(", ")}`;
      }
      if (ctx) {
        m += `\n\n${ctx}\n\nCopy selectors from after | exactly. Do NOT invent selectors.`;
      } else {
        m += `\n\nPage has no readable elements yet. Try wait or navigate.`;
      }

      // Trim to system + last 6 messages
      while (conv.length > 7) conv.splice(1, 1);
      conv.push({ role: "user", content: m });

      // Call AI — errors are caught and retried
      let resp;
      try {
        resp = await callAI(conv);
      } catch (err) {
        if (err instanceof StopError) throw err;
        consecutiveErrors++;
        log(`AI failed: ${err.message}`, "error");
        if (consecutiveErrors >= 3) {
          log("Too many AI errors — stopping", "error");
          return;
        }
        await sleep(3000);
        continue;
      }
      consecutiveErrors = 0;
      conv.push({ role: "assistant", content: JSON.stringify(resp) });

      // Log AI thought if present
      if (resp.thought) log(`AI: ${resp.thought}`, "status");

      const actions = resp.actions || [];

      // Handle done
      if (resp.done === true && actions.length === 0) {
        // Protect against premature done
        if (step <= 2 && isMultiPart(command) && totalActions <= 2) {
          log("AI tried to stop early — pushing it to continue...");
          conv[conv.length - 1] = { role: "assistant", content: '{"actions":[],"done":false,"thought":"continuing"}' };
          conv.push({ role: "user", content: `NOT done. Full command: "${command}". You've only done ${totalActions} actions. Read the page elements and continue.` });
          emptyCount++;
          if (emptyCount >= 3) { log("AI cannot proceed", "error"); return; }
          continue;
        }
        log("Task completed", "success");
        return;
      }

      // Handle no actions but not done — force AI to think harder
      if (actions.length === 0) {
        emptyCount++;
        if (emptyCount >= 4) {
          log("AI cannot figure out the page", "error");
          return;
        }
        const nudge = emptyCount === 1
          ? `You returned no actions but the command "${command}" is not done. Read the page elements carefully and return the next action.`
          : emptyCount === 2
          ? `Still no actions. STOP and THINK: What do you see on this page? Read the VISIBLE TEXT and ELEMENTS above. Is there a popup to dismiss? A button to click? An input to fill? Try ANYTHING that could help proceed with: "${command}"`
          : `Last chance. Describe in "thought" exactly what you see on the page. Then try: 1) scrolling down 2) waiting 3) clicking any promising button/link. The command was: "${command}"`;
        conv.push({ role: "user", content: nudge });
        continue;
      }
      emptyCount = 0;

      totalActions += actions.length;
      log(`Working... (${totalActions} actions done)`, "status");

      // Execute actions — collect ALL results, don't crash
      const results = [];
      let didNavigate = false;

      for (const action of actions) {
        if (stopRequested) throw new StopError();

        try {
          const r = await runAction(action, tabId);
          if (r === "navigated") didNavigate = true;
          results.push(`OK: ${action.type} ${action.selector || action.url || ""}`);
        } catch (err) {
          if (err instanceof StopError) throw err;
          results.push(`FAILED: ${action.type} ${action.selector || ""} — ${err.message}`);
          // Track failed selectors so AI won't repeat them
          if (action.selector) failedSelectors.push(action.selector);
          if (err.message.includes("Can't access page")) break;
        }

        if (action.type === "fill" || action.type === "click" || action.type === "submit") {
          await sleep(1000);
        }
      }

      actionResults = results.join("\n");

      // Extra wait after navigation or clicks for page to settle
      if (didNavigate) await sleep(2000);
      else await sleep(500);
    }

    log("Reached step limit", "error");
  } finally {
    isRunning = false;
  }
}

// ===========================================================
class StopError extends Error { constructor() { super("Stopped"); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; }
