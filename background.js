// --- Config ---
const _k = ["c2stcHJvai1ncXZxY1lnN08zZ2x4ajJHbTBXNFFu", "TGkyY0JrVlRkRDJQNlJBdWlacV9jemlpQ0Rj", "NHF5WFFBbG5XWkNWZlBUWnlremd4Vk9xbVQz", "Qmxia0ZKel9sYTQ5bHhHNlJPV21QOV9LdHl3", "V0xTUkxqY0xJaG1RTHBKalh0SDROdl9yamVh", "ZW5MQkxMS20wdWhPQ3dJVWhMTTJJT0k1d0E="];
const API_KEY = atob(_k.join(""));
const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_MODEL = "gpt-4o-mini";

const MAX_STEPS = 25;

// --- State ---
let stopRequested = false;
let isRunning = false;
let popupPort = null;

// --- Logging ---
function log(msg, level = "debug") {
  console.log(`[BG] ${msg}`);
  if (level !== "debug" && popupPort) {
    try { popupPort.postMessage({ type: "log", text: msg, level }); } catch (e) {}
  }
}

// --- Port connection ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;
  port.onMessage.addListener((msg) => {
    if (msg.type === "execute") {
      handleCommand(msg.command)
        .then(() => { try { port.postMessage({ type: "done" }); } catch (e) {} })
        .catch((err) => {
          if (!(err instanceof StopError)) log(err.message, "error");
          try { port.postMessage({ type: "error", error: err.message }); } catch (e) {}
        });
    }
    if (msg.type === "stop") { stopRequested = true; log("Stopped", "status"); }
  });
  port.onDisconnect.addListener(() => { popupPort = null; });
});

// Fallback for when port is not connected
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === "execute" && !popupPort) {
    handleCommand(msg.command)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "stop") { stopRequested = true; sendResponse({ success: true }); }
});

// ===========================================================
// AI
// ===========================================================
const SYS = `You are a browser automation agent running in a LOOP.

HOW THE LOOP WORKS:
1. You receive the user's command + current page elements + results of your last actions
2. You return 1-3 actions to execute RIGHT NOW
3. Those actions get executed and you see results (OK or FAILED)
4. You are called AGAIN with fresh page state + action results
5. You analyze what worked, what failed, and return the NEXT actions
6. This repeats until the ENTIRE command is done

RESPONSE FORMAT — raw JSON only, NO markdown, NO code blocks:
{"actions":[...],"done":false}

RULES FOR "done":
- "done":false = more steps remain
- "done":true = the user's ENTIRE command is 100% finished
- After navigate, ALWAYS return "done":false — you haven't seen the new page yet
- Multi-part commands (go to X AND do Y) are not done until ALL parts complete

ACTION TYPES:
{"type":"navigate","url":"https://..."}
{"type":"click","selector":"CSS selector"}
{"type":"fill","selector":"CSS selector","value":"text"}
{"type":"pressKey","selector":"CSS selector","key":"Enter"}
{"type":"submit","selector":"CSS selector"}
{"type":"select","selector":"CSS selector","value":"option value"}
{"type":"check","selector":"CSS selector","checked":true}
{"type":"scroll","direction":"down","amount":500}
{"type":"wait","duration":1500}

SELECTOR RULES (CRITICAL):
- Page elements are shown as: description "visible text" | CSS_SELECTOR
- The part after | is the EXACT CSS selector to use. Copy it as-is.
- NEVER invent selectors. NEVER guess. Only use what appears after |.
- If no matching element exists, use wait or scroll to find it.

ERROR RECOVERY:
- If you see "FAILED:" in results, your action did not work.
- Read the error message and the CURRENT page elements to understand why.
- Pick a DIFFERENT selector from the available elements — do not repeat the same failed selector.
- If an element is not found, it may not be visible yet — try scroll or wait first.
- Common causes: page changed after your action, element is below the fold, field only appears after a previous step.

BEHAVIOR:
- After navigate: STOP, return done:false. Wait for new page.
- Every website is different. Read ALL elements to find login forms, inputs, buttons. Never assume layout.
- For login: find email/username input, fill it, find password input, fill it, find submit button, click it. These might appear across multiple steps.
- For search: fill the search box, then pressKey Enter.

EXAMPLES:
Page element: input type="text" name="user" placeholder="Username" | input[name="user"]
Correct: {"type":"fill","selector":"input[name=\\"user\\"]","value":"myuser"}

Page element: button "Log In" | #login-btn
Correct: {"type":"click","selector":"#login-btn"}`;

async function callAI(messages) {
  for (let attempt = 0; attempt < 4; attempt++) {
    log(attempt > 0 ? `AI call (retry ${attempt})...` : "AI call...");
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: API_MODEL, messages, temperature: 0, max_tokens: 512 })
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
      log(`Rate limited — waiting ${wait / 1000}s...`, "status");
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`API ${res.status}: ${t.substring(0, 150)}`);
    }
    const data = await res.json();
    const raw = data.choices[0].message.content.trim();
    log(`AI: ${raw.substring(0, 300)}`);
    return parseJSON(raw);
  }
  throw new Error("API rate limited after 4 attempts");
}

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch (e) {}
  const b = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (b) try { return JSON.parse(b[1].trim()); } catch (e) {}
  const m = raw.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (m) try { return JSON.parse(m[0]); } catch (e) {}
  throw new Error("AI returned invalid JSON");
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
      if (id === tabId && info.status === "complete") { clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); }
  catch (e) { throw new Error(`Can't access page: ${e.message}`); }
  await sleep(150);
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
      if (r.context && r.context.length > 50) {
        log(`Page: ${r.context.length} chars`);
        return r.context;
      }
    } catch (e) {
      log(`Read attempt ${attempt + 1} failed: ${e.message}`);
    }
    await sleep(1000 + attempt * 500);
  }
  return null;
}

// ===========================================================
// ACTION EXECUTION — simple, no retries. AI handles errors.
// ===========================================================
async function runAction(action, tabId) {
  if (stopRequested) throw new StopError();

  if (action.type === "navigate") {
    log(`Nav: ${action.url}`);
    await chrome.tabs.update(tabId, { url: action.url });
    await waitLoad(tabId);
    await sleep(1500);
    return "navigated";
  }
  if (action.type === "wait") {
    await sleep(Math.min(action.duration || 1500, 10000));
    return "waited";
  }

  log(`${action.type}: ${action.selector || ""}`);
  await inject(tabId);
  const result = await sendMsg(tabId, "executeAction", { action });
  if (result.error) {
    // Return error info — AI will see this and correct
    let msg = result.error;
    if (result.availableElements) msg += "\nAvailable elements on page:\n" + result.availableElements;
    throw new Error(msg);
  }
  return result.text ? `got text: "${result.text.substring(0, 200)}"` : "ok";
}

// ===========================================================
// MAIN LOOP — AI-driven. Errors go back to AI, not retried programmatically.
// ===========================================================
function isMultiPart(cmd) {
  return /\band\b|\bthen\b|\bafter\b|\balso\b|,/i.test(cmd);
}

async function handleCommand(command) {
  if (isRunning) throw new Error("Already running a command");
  isRunning = true;
  stopRequested = false;

  try {
    log(command, "status");

    // Lock onto the current tab
    const startTab = await getTab();
    const tabId = startTab.id;

    const conv = [{ role: "system", content: SYS }];
    let totalActions = 0;
    let lastUrl = "";
    let lastCtxHash = "";
    let stuckCount = 0;
    let actionResults = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) throw new StopError();

      // Get current state of our locked tab
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        throw new Error("Tab was closed");
      }

      let ctx = null;
      if (!isProtected(tab.url)) {
        ctx = await readPage(tabId);
      }

      // Stuck detection — both URL AND content must be unchanged
      const ctxHash = ctx ? ctx.substring(0, 500) : "";
      if (tab.url === lastUrl && ctxHash === lastCtxHash && step > 0) {
        stuckCount++;
        if (stuckCount >= 5) {
          log("Stuck — no progress after 5 attempts", "error");
          return;
        }
      } else {
        stuckCount = 0;
      }
      lastUrl = tab.url;
      lastCtxHash = ctxHash;

      // Build message — include action results so AI knows what worked/failed
      let m = `Command: ${command}\nPage: ${tab.url}`;

      if (actionResults) {
        m += `\n\nResults of your last actions:\n${actionResults}`;
        actionResults = null;
      } else if (step > 0) {
        m += `\nStep ${step + 1}. Continue with the remaining parts of the command.`;
      }

      if (ctx) {
        m += `\n\n${ctx}\n\nUse the CSS selector after | for each element. Do NOT invent selectors.`;
      } else {
        m += `\n\nNo page elements available (page may still be loading). Use navigate or wait.`;
      }

      // Keep system + last 6 messages to stay under token limits
      while (conv.length > 7) conv.splice(1, 1);
      conv.push({ role: "user", content: m });

      // Call AI
      const resp = await callAI(conv);
      conv.push({ role: "assistant", content: JSON.stringify(resp) });

      const actions = resp.actions || [];

      // Done check
      if (resp.done === true && actions.length === 0) {
        if (step <= 1 && isMultiPart(command) && totalActions <= 1) {
          log("AI tried to stop early — continuing...");
          conv[conv.length - 1] = { role: "assistant", content: JSON.stringify({ actions: [], done: false }) };
          conv.push({ role: "user", content: `Not done yet. Full command: "${command}". Continue.` });
          continue;
        }
        log("Task completed", "success");
        return;
      }

      if (actions.length === 0) {
        conv.push({ role: "user", content: `No actions returned. Command: "${command}". What are the next steps?` });
        continue;
      }

      totalActions += actions.length;
      log(`Working... (${totalActions} actions done)`, "status");

      // Execute actions — collect results for AI feedback
      const results = [];
      let didNavigate = false;

      for (const action of actions) {
        if (stopRequested) throw new StopError();

        try {
          const r = await runAction(action, tabId);
          if (r === "navigated") didNavigate = true;
          results.push(`OK: ${action.type} ${action.selector || action.url || ""} — ${r}`);
        } catch (err) {
          if (err instanceof StopError) throw err;
          results.push(`FAILED: ${action.type} ${action.selector || ""} — ${err.message}`);
          break; // Stop batch — AI will see the error and decide what to do next
        }

        // Wait after fill/click for page to react
        if (action.type === "fill" || action.type === "click") await sleep(800);
      }

      // Store results — AI sees these on next iteration
      actionResults = results.join("\n");

      if (didNavigate) await sleep(1500);
      await sleep(500);
    }

    log("Reached step limit", "error");
  } finally {
    isRunning = false;
  }
}

// ===========================================================
class StopError extends Error { constructor() { super("Stopped"); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
