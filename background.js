// --- Config ---
const _k = ["Z3NrX2xvUGwxMlh0VH", "JYVWM3c3pHejhSV0dk", "eWIzRllQelRKRUVnUn", "dXelBScWVHMlY2SHRM", "MDI="];
const GROQ_API_KEY = atob(_k.join(""));
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const MAX_RETRIES = 2;

// --- State ---
let stopRequested = false;
let popupPort = null;

// --- Logging ---
function log(msg, level = "info") {
  console.log(`[BG] ${msg}`);
  // Send via port (reliable) and broadcast (fallback)
  const payload = { type: "log", text: msg, level };
  if (popupPort) {
    try { popupPort.postMessage(payload); } catch (e) { /* port closed */ }
  }
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// --- Port-based connection from popup ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPort = port;
    port.onMessage.addListener((msg) => {
      if (msg.type === "execute") {
        handleCommand(msg.command).then(() => {
          try { port.postMessage({ type: "done" }); } catch (e) {}
        }).catch((err) => {
          log(`Error: ${err.message}`, "error");
          try { port.postMessage({ type: "error", error: err.message }); } catch (e) {}
        });
      }
      if (msg.type === "stop") {
        stopRequested = true;
        log("Execution stopped by user", "retry");
      }
    });
    port.onDisconnect.addListener(() => { popupPort = null; });
  }
});

// Fallback one-shot message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "execute") {
    handleCommand(msg.command)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "stop") {
    stopRequested = true;
    log("Execution stopped by user", "retry");
    sendResponse({ success: true });
  }
});

// --- Groq AI ---
const SYSTEM_PROMPT = `You are a browser automation engine. You receive a user command and page context, and return actions as JSON.

RESPONSE FORMAT (strict — return ONLY this JSON, nothing else):
{"actions":[...],"explanation":"brief"}

ACTION TYPES:
navigate  {"type":"navigate","url":"https://full-url.com"}
click     {"type":"click","selector":"CSS selector"}
fill      {"type":"fill","selector":"CSS selector","value":"text to type"}
submit    {"type":"submit","selector":"CSS selector"}
select    {"type":"select","selector":"CSS selector","value":"option value"}
check     {"type":"check","selector":"CSS selector","checked":true}
scroll    {"type":"scroll","direction":"down|up","amount":500}
wait      {"type":"wait","duration":1500}
getText   {"type":"getText","selector":"CSS selector"}
pressKey  {"type":"pressKey","selector":"CSS selector","key":"Enter"}

SELECTOR PRIORITY (use the first one that works):
1. #id
2. [name="value"]
3. [aria-label="value"]
4. [data-testid="value"]
5. [placeholder="value"]
6. [role="button"] combined with text
7. tag.class

RULES:
- ONLY use selectors from the provided HTML context. NEVER guess selectors.
- For multi-step commands (e.g. "go to youtube and search cats"): return ONLY the navigate action. After navigation, you will be called again with the new page HTML for interaction actions.
- Use full https:// URLs for navigation. Use correct URLs for known sites.
- For search commands after navigation: fill the search input, then pressKey Enter on it.
- Return minimal actions. Do NOT add unnecessary waits.
- If the page HTML shows a search input, prefer filling it and pressing Enter rather than clicking a search button.`;

const RETRY_PROMPT = `The previous selector FAILED. Here is the error and the actual page elements.

FAILED action: {ACTION}
Error: {ERROR}

ACTUAL elements on the page:
{ELEMENTS}

Return a CORRECTED action using ONLY selectors from the elements listed above.
Format: {"actions":[<single corrected action>],"explanation":"why this selector"}`;

async function callGroq(messages) {
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0,
      max_tokens: 1024
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices[0].message.content.trim();
  log(`AI response: ${raw.substring(0, 200)}`, "ai");
  return parseAIResponse(raw);
}

function parseAIResponse(raw) {
  // Try direct parse first
  try { return JSON.parse(raw); } catch (e) {}

  // Try extracting from markdown code block
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (e) {}
  }

  // Try finding JSON object in the text
  const jsonMatch = raw.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch (e) {}
  }

  throw new Error("Could not parse AI response as JSON");
}

// --- Tab helpers ---
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

function isProtectedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|about|edge|brave|devtools):/.test(url);
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Content script injection ---
async function injectAndRun(tabId, msgType, payload) {
  // Always inject fresh — content.js guards against double-init internally
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (err) {
    throw new Error(`Cannot access this page: ${err.message}`);
  }

  // Small delay for script initialization
  await sleep(100);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Content script timed out")), 8000);
    chrome.tabs.sendMessage(tabId, { type: msgType, ...payload }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

async function getPageContext(tabId) {
  try {
    const result = await injectAndRun(tabId, "getPageContext", {});
    if (result && result.context) {
      log(`Page context: ${result.context.length} chars`);
      return result.context;
    }
  } catch (err) {
    log(`Could not read page: ${err.message}`, "error");
  }
  return null;
}

// --- Action execution ---
async function executeAction(action, tabId) {
  if (stopRequested) throw new StopError();

  switch (action.type) {
    case "navigate": {
      log(`Navigating to ${action.url}`, "action");
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      // Extra delay for JS-heavy pages to finish rendering
      await sleep(1000);
      log("Page loaded", "success");
      return { success: true, navigated: true };
    }

    case "wait": {
      const ms = Math.min(action.duration || 1500, 10000);
      log(`Waiting ${ms}ms...`, "info");
      await sleep(ms);
      return { success: true };
    }

    case "click":
    case "fill":
    case "submit":
    case "select":
    case "check":
    case "scroll":
    case "getText":
    case "pressKey": {
      log(`${action.type}: ${action.selector || "page"} ${action.value || action.key || ""}`, "action");
      const result = await injectAndRun(tabId, "executeAction", { action });
      if (result.error) {
        const err = new ElementError(result.error);
        err.availableElements = result.availableElements || "";
        throw err;
      }
      if (result.text) log(`Result: ${result.text}`, "success");
      else log(`Done`, "success");
      return result;
    }

    default:
      log(`Unknown action: ${action.type}`, "error");
      return { success: false };
  }
}

// --- Main command handler ---
async function handleCommand(command) {
  stopRequested = false;
  log(`Command: "${command}"`, "cmd");

  const tab = await getActiveTab();
  log(`Tab: ${tab.url || "new tab"}`, "info");

  // Phase 1: Get page context (if accessible)
  let pageContext = null;
  if (!isProtectedUrl(tab.url)) {
    pageContext = await getPageContext(tab.id);
  } else {
    log("Protected page — skipping page read", "info");
  }

  // Phase 2: Ask AI what to do
  log("Asking AI...", "ai");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(command, tab.url, pageContext) }
  ];
  const aiResponse = await callGroq(messages);

  if (!aiResponse.actions || !Array.isArray(aiResponse.actions) || aiResponse.actions.length === 0) {
    throw new Error("AI returned no actions");
  }

  if (aiResponse.explanation) log(`AI: ${aiResponse.explanation}`, "ai");
  log(`${aiResponse.actions.length} action(s) to run`, "info");

  // Phase 3: Execute actions
  for (let i = 0; i < aiResponse.actions.length; i++) {
    if (stopRequested) throw new StopError();

    const action = aiResponse.actions[i];
    const currentTab = await getActiveTab();

    // Execute with retry
    const result = await executeWithRetry(action, currentTab.id, command, messages);

    // Phase 4: After navigation, ALWAYS re-read page and re-ask AI for remaining interaction actions
    if (result.navigated && i < aiResponse.actions.length - 1) {
      const remainingHasInteraction = aiResponse.actions.slice(i + 1).some(a =>
        ["click", "fill", "submit", "select", "check", "getText", "pressKey"].includes(a.type)
      );

      if (remainingHasInteraction) {
        log("Re-reading page after navigation...", "info");
        const newTab = await getActiveTab();
        const freshContext = isProtectedUrl(newTab.url) ? null : await getPageContext(newTab.id);

        if (freshContext) {
          log("Asking AI for updated actions with page context...", "ai");
          const followUpMessages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(
              command,
              newTab.url,
              freshContext,
              `I already navigated to ${newTab.url}. Now perform the remaining interactions on this page.`
            )}
          ];
          const followUp = await callGroq(followUpMessages);

          if (followUp.actions && followUp.actions.length > 0) {
            const newActions = followUp.actions.filter(a => a.type !== "navigate");
            // Replace all remaining actions with the AI's corrected ones
            aiResponse.actions.splice(i + 1, Infinity, ...newActions);
            log(`AI updated: ${newActions.length} interaction action(s)`, "ai");
          }
        }
      }
    }
  }

  log("All actions completed!", "success");
}

async function executeWithRetry(action, tabId, command, conversationHistory) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await executeAction(action, tabId);
    } catch (err) {
      if (err instanceof StopError) throw err;

      if (err instanceof ElementError && attempt < MAX_RETRIES) {
        log(`Selector failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), asking AI to fix...`, "retry");

        // Re-read page for fresh context
        const currentTab = await getActiveTab();
        const freshContext = isProtectedUrl(currentTab.url) ? null : await getPageContext(currentTab.id);

        const retryText = RETRY_PROMPT
          .replace("{ACTION}", JSON.stringify(action))
          .replace("{ERROR}", err.message)
          .replace("{ELEMENTS}", err.availableElements || freshContext || "No elements available");

        const retryMessages = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Original command: ${command}\nCurrent page: ${currentTab.url}\n${freshContext ? `\nPage context:\n${freshContext}\n` : ""}\n${retryText}` }
        ];

        const corrected = await callGroq(retryMessages);
        if (corrected.actions && corrected.actions.length > 0) {
          action = corrected.actions[0];
          log(`AI corrected: ${action.type} -> ${action.selector || ""}`, "ai");
        } else {
          throw new Error("AI could not correct the selector");
        }
      } else {
        throw err;
      }
    }
  }
}

function buildUserPrompt(command, url, pageContext, extraInstruction) {
  let prompt = `Command: ${command}`;
  if (extraInstruction) prompt += `\n${extraInstruction}`;
  prompt += `\n\nCurrent page: ${url || "new tab"}`;
  if (pageContext) {
    prompt += `\n\nPage elements:\n${pageContext}`;
  } else {
    prompt += `\n\nNo page elements available (protected page or new tab). Only return navigate actions.`;
  }
  return prompt;
}

// --- Error types ---
class ElementError extends Error {
  constructor(message) {
    super(message);
    this.availableElements = "";
  }
}

class StopError extends Error {
  constructor() { super("Stopped by user"); }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
