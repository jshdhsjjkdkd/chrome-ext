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

// --- Logging ---
// "status" = shown to user (task done, errors only)
// "debug" = console only (verbose, never shown in popup)
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
    if (msg.type === "stop") {
      stopRequested = true;
      log("Stopped", "status");
    }
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
// AI — compact system prompt to save tokens
// ===========================================================
const SYS = `Browser automation agent. Loop: see page, return next actions, repeat until done.
JSON only: {"a":[...],"d":false}
"a"=actions array, "d"=true when ENTIRE command is complete.
Actions: navigate{"t":"nav","u":"url"} click{"t":"click","s":"sel"} fill{"t":"fill","s":"sel","v":"text"} key{"t":"key","s":"sel","k":"Enter"} submit{"t":"sub","s":"sel"} select{"t":"sel","s":"sel","v":"val"} check{"t":"chk","s":"sel","c":true} scroll{"t":"scr","dir":"down","amt":500} wait{"t":"wait","ms":1500} getText{"t":"txt","s":"sel"}
Use sel="" attribute from page elements as CSS selector. Never guess selectors.
After navigate, stop — new page comes next call.
Search: fill input + key Enter. Login: fill fields + click submit.
1-4 actions max per call. When all done: {"a":[],"d":true}`;

// Map compact keys back to full action objects
function expandAction(a) {
  const map = { nav: "navigate", click: "click", fill: "fill", key: "pressKey", sub: "submit", sel: "select", chk: "check", scr: "scroll", wait: "wait", txt: "getText" };
  const action = { type: map[a.t] || a.t };
  if (a.u) action.url = a.u;
  if (a.s) action.selector = a.s;
  if (a.v) action.value = a.v;
  if (a.k) action.key = a.k;
  if (a.c !== undefined) action.checked = a.c;
  if (a.dir) action.direction = a.dir;
  if (a.amt) action.amount = a.amt;
  if (a.ms) action.duration = a.ms;
  return action;
}

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
  log(`AI raw: ${raw.substring(0, 200)}`);
  return parseJSON(raw);
}

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch (e) {}
  const b = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (b) try { return JSON.parse(b[1].trim()); } catch (e) {}
  const m = raw.match(/\{[\s\S]*"a"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (m) try { return JSON.parse(m[0]); } catch (e) {}
  // Try full-name format too (AI might ignore compact format)
  const f = raw.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (f) try { return JSON.parse(f[0]); } catch (e) {}
  throw new Error("AI returned invalid JSON");
}

// Normalize response — handle both compact and full format
function normalizeResponse(resp) {
  const actions = resp.a || resp.actions || [];
  const done = resp.d === true || resp.done === true;
  const expanded = actions.map(a => a.t ? expandAction(a) : a);
  return { actions: expanded, done };
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
  await sleep(100);
}

async function msg(tabId, type, payload = {}) {
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
  try {
    await inject(tabId);
    const r = await msg(tabId, "getPageContext");
    if (r.context) { log(`Page: ${r.context.length} chars`); return r.context; }
  } catch (e) { log(`Read fail: ${e.message}`); }
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
    await sleep(1200);
    return { navigated: true };
  }
  if (action.type === "wait") {
    await sleep(Math.min(action.duration || 1500, 10000));
    return {};
  }

  log(`${action.type}: ${action.selector || ""}`);
  await inject(tabId);
  const result = await msg(tabId, "executeAction", { action });
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
          { role: "user", content: `Fix failed action. Command:"${command}" Page:${tab.url}\n${ctx || ""}\nFailed:${JSON.stringify(action)} Err:${err.message}\n${err.available ? "Available:\n" + err.available : ""}\nReturn corrected action.` }
        ]);
        const norm = normalizeResponse(fix);
        if (norm.actions[0]) { action = norm.actions[0]; }
        else throw new Error("AI can't fix selector");
      } else throw err;
    }
  }
}

// ===========================================================
// MAIN LOOP
// ===========================================================
async function handleCommand(command) {
  stopRequested = false;
  log(command, "status");

  const conv = [{ role: "system", content: SYS }];
  let stepCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (stopRequested) throw new StopError();

    const tab = await getTab();
    const ctx = isProtected(tab.url) ? null : await readPage(tab.id);

    // Build compact user message
    let m = step === 0 ? `CMD:${command}\n` : `CMD:${command}\n`;
    m += `URL:${tab.url}\n`;
    m += ctx ? `ELS:\n${ctx}` : "No page elements. Navigate only.";

    // Keep history tight — system + last 2 exchanges only
    if (conv.length > 5) {
      const sys = conv[0];
      conv.splice(1, conv.length - 3);
      conv[0] = sys;
    }

    conv.push({ role: "user", content: m });
    const resp = normalizeResponse(await callAI(conv));
    conv.push({ role: "assistant", content: JSON.stringify(resp) });

    if (resp.done) {
      log("Task completed", "success");
      return;
    }

    if (!resp.actions.length) {
      log("Task completed", "success");
      return;
    }

    stepCount += resp.actions.length;
    log(`Working... (${stepCount} actions)`, "status");

    let navigated = false;
    for (const action of resp.actions) {
      if (stopRequested) throw new StopError();
      const t = await getTab();
      const r = await runWithRetry(action, t.id, command);
      if (r.navigated) navigated = true;
    }

    if (navigated) await sleep(500);
    await sleep(300);
  }

  log("Reached step limit", "error");
}

// ===========================================================
class ElementError extends Error { constructor(m) { super(m); this.available = ""; } }
class StopError extends Error { constructor() { super("Stopped"); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
