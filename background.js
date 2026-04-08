const _k = ["Z3NrX2xvUGwxMlh0VH", "JYVWM3c3pHejhSV0dk", "eWIzRllQelRKRUVnUn", "dXelBScWVHMlY2SHRM", "MDI="];
const GROQ_API_KEY = atob(_k.join(""));
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_MODEL_FAST = "llama-3.1-8b-instant";

let stopRequested = false;

function log(msg) {
  console.log(`[BG] ${msg}`);
  chrome.runtime.sendMessage({ type: "log", text: msg }).catch(() => {});
}

async function callGroq(systemPrompt, userPrompt, model) {
  const useModel = model || GROQ_MODEL;
  log(`Calling Groq AI (${useModel})...`);
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 1024
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const raw = data.choices[0].message.content.trim();
  log(`Groq raw response: ${raw.substring(0, 300)}`);

  // Extract JSON from the response (handle markdown code blocks)
  let jsonStr = raw;
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  return JSON.parse(jsonStr);
}

function getSystemPrompt(hasHtml) {
  let prompt = `Browser automation bot. Return ONLY valid JSON, no markdown.
Format: {"actions":[...],"explanation":"brief"}

Action types:
- navigate: {"type":"navigate","url":"https://..."}
- click: {"type":"click","selector":"css"}
- fill: {"type":"fill","selector":"css","value":"text"}
- select: {"type":"select","selector":"css","value":"val"}
- check: {"type":"check","selector":"css","checked":true}
- submit: {"type":"submit","selector":"css"}
- scroll: {"type":"scroll","direction":"down","amount":500}
- wait: {"type":"wait","duration":1500}
- getText: {"type":"getText","selector":"css"}

Rules: Multi-step commands = multiple actions (navigate,wait 1500ms,fill,click). Use full https:// URLs. Use correct URLs for known sites. Prefer selectors by: id > name > aria-label > data-attr > class.`;

  if (hasHtml) {
    prompt += ` HTML context provided below — use it for accurate selectors.`;
  } else {
    prompt += ` No HTML available. Focus on navigation.`;
  }

  return prompt;
}

function shouldUseFastModel(command, hasHtml) {
  if (hasHtml) return false;
  const simple = /^(go to|open|visit|navigate to|take me to)\s/i.test(command);
  return simple;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) throw new Error("No active tab found");
  return tabs[0];
}

function isProtectedUrl(url) {
  if (!url) return true;
  return url.startsWith("chrome://") ||
         url.startsWith("chrome-extension://") ||
         url.startsWith("about:") ||
         url.startsWith("edge://") ||
         url.startsWith("brave://");
}

async function injectContentScript(tabId) {
  log(`Injecting content script into tab ${tabId}...`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    log("Content script injected successfully");
  } catch (err) {
    log(`Content script injection failed: ${err.message}`);
    throw err;
  }
}

async function getPageHtml(tabId) {
  try {
    await injectContentScript(tabId);
    const results = await chrome.tabs.sendMessage(tabId, { type: "getHTML" });
    if (results && results.html) {
      const truncated = results.html.substring(0, 8000);
      log(`Got page HTML (${truncated.length} chars)`);
      return truncated;
    }
  } catch (err) {
    log(`Failed to get page HTML: ${err.message}`);
  }
  return null;
}

async function executeAction(action, tabId) {
  if (stopRequested) throw new Error("Execution stopped by user");

  log(`Executing action: ${action.type}`);

  switch (action.type) {
    case "navigate": {
      log(`Navigating to: ${action.url}`);
      await chrome.tabs.update(tabId, { url: action.url });
      // Wait for the page to load
      await new Promise((resolve) => {
        function listener(updatedTabId, changeInfo) {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
        // Timeout after 15 seconds
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });
      log("Navigation complete");
      break;
    }

    case "wait": {
      const duration = action.duration || 1500;
      log(`Waiting ${duration}ms...`);
      await new Promise(r => setTimeout(r, duration));
      log("Wait complete");
      break;
    }

    case "click":
    case "fill":
    case "select":
    case "check":
    case "submit":
    case "scroll":
    case "getText": {
      await injectContentScript(tabId);
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "executeAction",
        action: action
      });
      if (result && result.error) {
        throw new Error(result.error);
      }
      if (result && result.text) {
        log(`getText result: ${result.text}`);
      }
      log(`Action '${action.type}' completed`);
      break;
    }

    default:
      log(`Unknown action type: ${action.type}`);
  }
}

async function handleCommand(command) {
  stopRequested = false;
  log(`Processing command: "${command}"`);

  try {
    const tab = await getActiveTab();
    log(`Active tab: ${tab.url || "unknown"}`);

    // Get page HTML if not a protected page
    let pageHtml = null;
    if (!isProtectedUrl(tab.url)) {
      pageHtml = await getPageHtml(tab.id);
    } else {
      log("Protected page detected, skipping HTML extraction");
    }

    // Build user prompt
    let userPrompt = `Command: ${command}`;
    if (pageHtml) {
      userPrompt += `\n\nCurrent page URL: ${tab.url}\n\nCurrent page HTML (truncated):\n${pageHtml}`;
    } else {
      userPrompt += `\n\nCurrent page URL: ${tab.url || "new tab"}`;
    }

    // Call Groq AI — use fast model for simple navigation
    const systemPrompt = getSystemPrompt(!!pageHtml);
    const useFast = shouldUseFastModel(command, !!pageHtml);
    const model = useFast ? GROQ_MODEL_FAST : GROQ_MODEL;
    const aiResponse = await callGroq(systemPrompt, userPrompt, model);

    if (!aiResponse.actions || !Array.isArray(aiResponse.actions)) {
      throw new Error("AI response missing actions array");
    }

    log(`AI explanation: ${aiResponse.explanation || "none"}`);
    log(`Got ${aiResponse.actions.length} action(s) to execute`);

    // Execute each action sequentially
    for (let i = 0; i < aiResponse.actions.length; i++) {
      if (stopRequested) {
        log("Execution stopped by user");
        return;
      }

      const action = aiResponse.actions[i];
      log(`Executing action ${i + 1}/${aiResponse.actions.length}: ${action.type}`);

      // Get fresh tab reference (tab may have navigated)
      const currentTab = await getActiveTab();
      await executeAction(action, currentTab.id);
    }

    log("All actions completed successfully!");

  } catch (err) {
    log(`Error: ${err.message}`);
    throw err;
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "execute") {
    handleCommand(msg.command)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "stop") {
    stopRequested = true;
    log("Stop requested");
    sendResponse({ success: true });
  }
});
