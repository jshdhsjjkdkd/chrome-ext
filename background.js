// --- Config ---
const _k = ["c2stcHJvai1ncXZxY1lnN08zZ2x4ajJHbTBXNFFu", "TGkyY0JrVlRkRDJQNlJBdWlacV9jemlpQ0Rj", "NHF5WFFBbG5XWkNWZlBUWnlremd4Vk9xbVQz", "Qmxia0ZKel9sYTQ5bHhHNlJPV21QOV9LdHl3", "V0xTUkxqY0xJaG1RTHBKalh0SDROdl9yamVh", "ZW5MQkxMS20wdWhPQ3dJVWhMTTJJT0k1d0E="];
const API_KEY = atob(_k.join(""));
const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_MODEL = "gpt-4o";

const MAX_STEPS = 20;
const MAX_RETRIES = 2;

// --- State ---
let stopRequested = false;
let popupPort = null;

// --- Logging: "status" shown in popup, "debug" console only ---
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

// Fallback
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
1. You receive the user's command and the current page state
2. You return 1-4 actions to execute RIGHT NOW
3. Those actions get executed
4. You are called AGAIN with the NEW page state
5. You return the NEXT actions
6. This repeats until the ENTIRE command is done

RESPONSE FORMAT — JSON only, no markdown:
{"actions":[...],"done":false}

CRITICAL RULES FOR "done":
- "done":false means "I have more steps to do after these actions complete"
- "done":true means "the user's ENTIRE command is 100% finished, every single part"
- After a navigate action, ALWAYS return "done":false — you haven't seen the new page yet
- If the command says "go to X AND do Y", done is false until Y is also completed
- If the command has multiple parts (login, fill form, go somewhere), done is false until ALL parts are finished
- Only return "done":true with an empty actions array when everything is complete

ACTION TYPES:
{"type":"navigate","url":"https://..."}
{"type":"click","selector":"css selector"}
{"type":"fill","selector":"css selector","value":"text"}
{"type":"pressKey","selector":"css selector","key":"Enter"}
{"type":"submit","selector":"css selector"}
{"type":"select","selector":"css selector","value":"option"}
{"type":"check","selector":"css selector","checked":true}
{"type":"scroll","direction":"down","amount":500}
{"type":"wait","duration":1500}
{"type":"getText","selector":"css selector"}

SELECTOR RULES:
- Each page element has a sel="..." attribute. Use that EXACT value as your CSS selector.
- NEVER invent or guess selectors. Only use what you see in the page elements.

BEHAVIOR:
- After navigate, STOP and return "done":false. You'll get the new page next call.
- For search: fill the search box, then pressKey Enter on it.
- For login: fill username/email, fill password, click the login/submit button.
- When no page elements are shown, only navigate actions are possible.

EXAMPLE LOOP for "go to youtube and search for cats":
Call 1 → {"actions":[{"type":"navigate","url":"https://www.youtube.com"}],"done":false}
Call 2 (sees youtube page) → {"actions":[{"type":"fill","selector":"input#search","value":"cats"},{"type":"pressKey","selector":"input#search","key":"Enter"}],"done":false}
Call 3 (sees search results) → {"actions":[],"done":true}`;

async function callAI(messages) {
  log("AI call...");
  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: API_MODEL, messages, temperature: 0, max_tokens: 512 })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API ${res.status}: ${t.substring(0, 150)}`);
  }
  const data = await res.json();
  const raw = data.choices[0].message.content.trim();
  log(`AI: ${raw.substring(0, 300)}`);
  return parseJSON(raw);
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
  // Try up to 2 times in case page isn't ready yet
  for (let attempt = 0; attempt < 2; attempt++) {
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
    // Wait before retry — page might still be loading
    await sleep(1500);
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
    await sleep(1500);
    return { navigated: true };
  }
  if (action.type === "wait") {
    await sleep(Math.min(action.duration || 1500, 10000));
    return {};
  }

  log(`${action.type}: ${action.selector || ""}`);
  await inject(tabId);
  const result = await sendMsg(tabId, "executeAction", { action });
  if (result.error) {
    const err = new ElementError(result.error);
    err.available = result.availableElements || "";
    throw err;
  }
  return result;
}

async function runWithRetry(action, tabId, command) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await runAction(action, tabId);
    } catch (err) {
      if (err instanceof StopError) throw err;
      if (err instanceof ElementError && i < MAX_RETRIES) {
        log(`Retry ${i + 1}...`);
        const tab = await getTab();
        const ctx = isProtected(tab.url) ? null : await readPage(tab.id);
        const fix = await callAI([
          { role: "system", content: SYS },
          { role: "user", content: `Fix failed action. Command:"${command}" Page:${tab.url}\n${ctx ? "Page elements:\n" + ctx : ""}\nFailed:${JSON.stringify(action)} Error:${err.message}\n${err.available ? "Available elements:\n" + err.available : ""}\nReturn {"actions":[corrected action],"done":false}` }
        ]);
        if (fix.actions?.[0]) { action = fix.actions[0]; }
        else throw new Error("AI can't fix selector");
      } else throw err;
    }
  }
}

// ===========================================================
// MAIN LOOP
// ===========================================================

// Check if a command likely has multiple parts
function isMultiPart(cmd) {
  const lower = cmd.toLowerCase();
  return /\band\b|\bthen\b|\bafter\b|\balso\b|,/.test(lower);
}

async function handleCommand(command) {
  stopRequested = false;
  log(command, "status");

  const conv = [{ role: "system", content: SYS }];
  let totalActions = 0;
  let lastUrl = "";
  let didNavigate = false;
  let stuckCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (stopRequested) throw new StopError();

    // 1. Read current page
    const tab = await getTab();
    let ctx = null;
    if (!isProtected(tab.url)) {
      ctx = await readPage(tab.id);
    }

    // Detect if we're stuck on the same page with no progress
    if (tab.url === lastUrl && step > 0 && !didNavigate) {
      stuckCount++;
      if (stuckCount >= 3) {
        log("Stuck — no progress after 3 attempts", "error");
        return;
      }
    } else {
      stuckCount = 0;
    }
    lastUrl = tab.url;
    didNavigate = false;

    // 2. Build message
    let m = `Command: ${command}\nCurrent page: ${tab.url}`;
    if (step > 0) m += `\nStep ${step + 1}. Previous actions completed. Continue with the remaining parts of the command.`;
    if (ctx) {
      m += `\n\nPage elements:\n${ctx}`;
    } else {
      m += `\n\nNo page elements available. Only navigate actions are possible.`;
    }

    // Trim conversation — keep system + last 3 exchanges
    while (conv.length > 7) conv.splice(1, 2);
    conv.push({ role: "user", content: m });

    // 3. Call AI
    const resp = await callAI(conv);
    conv.push({ role: "assistant", content: JSON.stringify(resp) });

    // 4. Check done — but protect against premature done
    const actions = resp.actions || [];

    if (resp.done === true && actions.length === 0) {
      // Safety: if this is step 0 or 1 and the command has multiple parts,
      // the AI probably quit too early — force continue
      if (step <= 1 && isMultiPart(command) && totalActions <= 1) {
        log("AI tried to stop early — continuing...");
        // Replace the done response in conversation so AI sees it should keep going
        conv[conv.length - 1] = {
          role: "assistant",
          content: JSON.stringify({ actions: [], done: false })
        };
        conv.push({
          role: "user",
          content: `No, the command is NOT done yet. The full command is: "${command}". You only completed the first part. Continue with the remaining steps. Look at the current page and decide what to do next.`
        });
        continue;
      }

      log("Task completed", "success");
      return;
    }

    if (actions.length === 0) {
      // No actions but done is false — AI is confused, nudge it
      conv.push({
        role: "user",
        content: `You returned no actions but the task is not done. The command is: "${command}". Look at the page elements and return the next actions.`
      });
      continue;
    }

    totalActions += actions.length;
    log(`Working... (${totalActions} actions done)`, "status");

    // 5. Execute all actions in this batch
    for (const action of actions) {
      if (stopRequested) throw new StopError();
      const t = await getTab();
      const r = await runWithRetry(action, t.id, command);
      if (r.navigated) didNavigate = true;
    }

    // 6. Wait for page to settle
    if (didNavigate) await sleep(1000);
    await sleep(300);
  }

  log("Reached step limit", "error");
}

// ===========================================================
class ElementError extends Error { constructor(m) { super(m); this.available = ""; } }
class StopError extends Error { constructor() { super("Stopped"); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
