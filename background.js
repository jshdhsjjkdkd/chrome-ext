// --- Config ---
const _k = ["c2stcHJvai1ncXZxY1lnN08zZ2x4ajJHbTBXNFFu", "TGkyY0JrVlRkRDJQNlJBdWlacV9jemlpQ0Rj", "NHF5WFFBbG5XWkNWZlBUWnlremd4Vk9xbVQz", "Qmxia0ZKel9sYTQ5bHhHNlJPV21QOV9LdHl3", "V0xTUkxqY0xJaG1RTHBKalh0SDROdl9yamVh", "ZW5MQkxMS20wdWhPQ3dJVWhMTTJJT0k1d0E="];
const API_KEY = atob(_k.join(""));
const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const API_MODEL = "gpt-4o";

const MAX_LOOP_STEPS = 20;
const MAX_SELECTOR_RETRIES = 2;

// --- State ---
let stopRequested = false;
let popupPort = null;

// --- Logging (only via port, no broadcast duplication) ---
function log(msg, level = "info") {
  console.log(`[BG] ${msg}`);
  if (popupPort) {
    try { popupPort.postMessage({ type: "log", text: msg, level }); } catch (e) {}
  }
}

// --- Port connection from popup ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;

  port.onMessage.addListener((msg) => {
    if (msg.type === "execute") {
      handleCommand(msg.command)
        .then(() => {
          try { port.postMessage({ type: "done" }); } catch (e) {}
        })
        .catch((err) => {
          if (!(err instanceof StopError)) log(`Error: ${err.message}`, "error");
          try { port.postMessage({ type: "error", error: err.message }); } catch (e) {}
        });
    }
    if (msg.type === "stop") {
      stopRequested = true;
      log("Stopped by user", "retry");
    }
  });

  port.onDisconnect.addListener(() => { popupPort = null; });
});

// Fallback one-shot listener (only if port is not connected)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === "execute" && !popupPort) {
    handleCommand(msg.command)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "stop") {
    stopRequested = true;
    sendResponse({ success: true });
  }
});

// ===========================================================
// GROQ AI
// ===========================================================
const SYSTEM_PROMPT = `You are a browser automation agent. You work in a LOOP: each call you see the CURRENT page and return the NEXT batch of actions to perform. You will be called again after those actions complete with the updated page state.

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no extra text:
{"actions":[...],"explanation":"brief","done":false}

Set "done":true ONLY when the user's ENTIRE command has been fully completed (all steps finished, final page reached). Otherwise always set "done":false.

ACTION TYPES:
navigate   {"type":"navigate","url":"https://..."}
click      {"type":"click","selector":"css"}
fill       {"type":"fill","selector":"css","value":"text"}
pressKey   {"type":"pressKey","selector":"css","key":"Enter"}
submit     {"type":"submit","selector":"css"}
select     {"type":"select","selector":"css","value":"val"}
check      {"type":"check","selector":"css","checked":true}
scroll     {"type":"scroll","direction":"down|up","amount":500}
wait       {"type":"wait","duration":1500}
getText    {"type":"getText","selector":"css"}

SELECTOR RULES:
- ONLY use selectors you can see in the provided page elements. NEVER guess.
- Each element in the page context has a sel="..." attribute — use that exact selector.
- Priority: #id > [name] > [aria-label] > [data-testid] > [placeholder] > sel attribute.

BEHAVIOR RULES:
- Return 1-4 actions per step. Do NOT try to do everything in one call.
- After a navigate action, STOP and return. You'll get the new page in the next call.
- For search: fill the search input, then pressKey Enter on it.
- For login: fill email/username, fill password, then click/submit the login button.
- For forms: fill fields one at a time in a single batch, then submit.
- If the page has not changed and you already tried an action, try a different approach.
- If no page elements are provided, you can only return navigate actions.
- When all steps of the user's command are done, return {"actions":[],"explanation":"All done","done":true}.`;

async function callGroq(conversationMessages) {
  log("Thinking...", "ai");

  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: API_MODEL,
      messages: conversationMessages,
      temperature: 0,
      max_tokens: 1024
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices[0].message.content.trim();
  log(`AI: ${raw.substring(0, 150)}...`, "ai");
  return parseJSON(raw);
}

function parseJSON(raw) {
  // Direct parse
  try { return JSON.parse(raw); } catch (e) {}
  // Code block
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) try { return JSON.parse(block[1].trim()); } catch (e) {}
  // Find JSON object
  const obj = raw.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch (e) {}
  throw new Error("AI returned invalid JSON");
}

// ===========================================================
// TAB HELPERS
// ===========================================================
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

function isProtected(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|about|edge|brave|devtools):/.test(url);
}

async function waitForLoad(tabId, timeout = 15000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      resolve();
    }, timeout);
    function fn(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// ===========================================================
// CONTENT SCRIPT BRIDGE
// ===========================================================
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    throw new Error(`Cannot access page: ${err.message}`);
  }
  await sleep(100);
}

async function sendToContent(tabId, type, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Content script timeout")), 10000);
    chrome.tabs.sendMessage(tabId, { type, ...payload }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp || {});
    });
  });
}

async function readPage(tabId) {
  try {
    await inject(tabId);
    const r = await sendToContent(tabId, "getPageContext");
    if (r.context) {
      log(`Read page (${r.context.length} chars)`, "info");
      return r.context;
    }
  } catch (err) {
    log(`Page read failed: ${err.message}`, "error");
  }
  return null;
}

// ===========================================================
// ACTION EXECUTION
// ===========================================================
async function runAction(action, tabId) {
  if (stopRequested) throw new StopError();

  if (action.type === "navigate") {
    log(`Navigate: ${action.url}`, "action");
    await chrome.tabs.update(tabId, { url: action.url });
    await waitForLoad(tabId);
    await sleep(1200);
    log("Page loaded", "success");
    return { navigated: true };
  }

  if (action.type === "wait") {
    const ms = Math.min(action.duration || 1500, 10000);
    log(`Wait ${ms}ms`, "info");
    await sleep(ms);
    return {};
  }

  // DOM actions
  const label = `${action.type}${action.selector ? ": " + action.selector : ""}${action.value ? " = " + action.value : ""}${action.key ? " [" + action.key + "]" : ""}`;
  log(label, "action");

  await inject(tabId);
  const result = await sendToContent(tabId, "executeAction", { action });

  if (result.error) {
    const err = new ElementError(result.error);
    err.available = result.availableElements || "";
    throw err;
  }

  if (result.text) log(`Text: ${result.text}`, "success");
  else log("OK", "success");
  return result;
}

async function runActionWithRetry(action, tabId, command) {
  for (let attempt = 0; attempt <= MAX_SELECTOR_RETRIES; attempt++) {
    try {
      return await runAction(action, tabId);
    } catch (err) {
      if (err instanceof StopError) throw err;

      if (err instanceof ElementError && attempt < MAX_SELECTOR_RETRIES) {
        log(`Selector failed, asking AI to fix (retry ${attempt + 1})...`, "retry");

        const tab = await getActiveTab();
        const ctx = isProtected(tab.url) ? null : await readPage(tab.id);

        const fixMessages = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Fix this failed action. Original command: "${command}"
Page: ${tab.url}
${ctx ? "Page elements:\n" + ctx : ""}

FAILED: ${JSON.stringify(action)}
Error: ${err.message}
${err.available ? "Available elements:\n" + err.available : ""}

Return {"actions":[<one corrected action>],"explanation":"...","done":false}` }
        ];

        const fix = await callGroq(fixMessages);
        if (fix.actions?.[0]) {
          action = fix.actions[0];
          log(`Corrected: ${action.selector || action.type}`, "ai");
        } else {
          throw new Error("AI couldn't fix selector");
        }
      } else {
        throw err;
      }
    }
  }
}

// ===========================================================
// MAIN AGENTIC LOOP
// ===========================================================
async function handleCommand(command) {
  stopRequested = false;
  log(`"${command}"`, "cmd");

  // Conversation history for the AI (keeps context across loop steps)
  const conversation = [{ role: "system", content: SYSTEM_PROMPT }];

  for (let step = 0; step < MAX_LOOP_STEPS; step++) {
    if (stopRequested) throw new StopError();

    // 1. Read current page state
    const tab = await getActiveTab();
    let pageContext = null;
    if (!isProtected(tab.url)) {
      pageContext = await readPage(tab.id);
    }

    // 2. Build the user message for this step
    let stepMsg = "";
    if (step === 0) {
      stepMsg = `FULL COMMAND: ${command}\n\nCurrent page: ${tab.url}`;
    } else {
      stepMsg = `FULL COMMAND (reminder): ${command}\n\nPrevious actions completed. Current page: ${tab.url}`;
    }
    if (pageContext) {
      stepMsg += `\n\nPage elements:\n${pageContext}`;
    } else {
      stepMsg += `\n\nNo page elements available (protected page or new tab). Only navigate actions are possible.`;
    }

    // Keep conversation concise — only system + last 4 exchanges
    if (conversation.length > 9) {
      const sys = conversation[0];
      conversation.splice(1, conversation.length - 5);
      conversation[0] = sys;
    }

    conversation.push({ role: "user", content: stepMsg });

    // 3. Ask AI what to do next
    log(`Step ${step + 1}: asking AI...`, "ai");
    const response = await callGroq(conversation);

    // Add AI response to conversation history
    conversation.push({ role: "assistant", content: JSON.stringify(response) });

    // 4. Check if AI says we're done
    if (response.done === true) {
      if (response.explanation) log(`AI: ${response.explanation}`, "ai");
      log("All steps completed!", "success");
      return;
    }

    if (!response.actions || response.actions.length === 0) {
      log("AI returned no actions — finishing", "info");
      return;
    }

    if (response.explanation) log(`AI: ${response.explanation}`, "ai");
    log(`${response.actions.length} action(s) to execute`, "info");

    // 5. Execute all actions in this batch
    let navigated = false;
    for (const action of response.actions) {
      if (stopRequested) throw new StopError();

      const currentTab = await getActiveTab();
      const result = await runActionWithRetry(action, currentTab.id, command);
      if (result.navigated) navigated = true;
    }

    // 6. After navigation, wait a beat then loop back to read the new page
    if (navigated) {
      await sleep(500);
    }

    // Small delay between loop steps to avoid hammering
    await sleep(300);
  }

  log("Reached max steps limit", "retry");
}

// ===========================================================
// ERROR TYPES
// ===========================================================
class ElementError extends Error {
  constructor(msg) { super(msg); this.available = ""; }
}

class StopError extends Error {
  constructor() { super("Stopped"); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
