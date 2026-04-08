const _k = ["Z3NrX2xvUGwxMlh0VH", "JYVWM3c3pHejhSV0dk", "eWIzRllQelRKRUVnUn", "dXelBScWVHMlY2SHRM", "MDI="];
const GROQ_API_KEY = atob(_k.join(""));
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

let stopRequested = false;

function log(msg) {
  console.log(`[BG] ${msg}`);
  chrome.runtime.sendMessage({ type: "log", text: msg }).catch(() => {});
}

async function callGroq(systemPrompt, userPrompt) {
  log("Calling Groq AI...");
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 2048
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
  let prompt = `You are a browser automation assistant. The user gives natural language commands and you return JSON actions to execute.

You MUST respond with valid JSON only, no markdown, no explanation outside JSON. Use this exact format:
{
  "actions": [ ... ],
  "explanation": "brief explanation"
}

Available action types:

1. navigate - Go to a URL
   { "type": "navigate", "url": "https://example.com" }

2. click - Click an element by CSS selector
   { "type": "click", "selector": "button.login" }

3. fill - Type text into an input field
   { "type": "fill", "selector": "input[name='search']", "value": "search text" }

4. select - Select an option from a dropdown
   { "type": "select", "selector": "select#country", "value": "US" }

5. check - Check/uncheck a checkbox
   { "type": "check", "selector": "input[type='checkbox']", "checked": true }

6. submit - Submit a form
   { "type": "submit", "selector": "form#login" }

7. scroll - Scroll the page
   { "type": "scroll", "direction": "down", "amount": 500 }

8. wait - Wait for a specified time in milliseconds
   { "type": "wait", "duration": 1500 }

9. getText - Get text content of an element
   { "type": "getText", "selector": ".result" }

Rules:
- For multi-step commands like "go to youtube and search for cats", return multiple actions: navigate, then wait (1500ms for page load), then fill the search input, then click search or submit.
- Always use full URLs with https:// for navigation.
- For well-known sites, use their correct URLs (e.g. youtube.com, gmail.com, xbox.com, twitter.com, etc).
- When you need to interact with elements on a page, use the provided HTML context to find accurate CSS selectors.
- Prefer stable selectors: name attributes, IDs, aria-labels, data attributes, then tag+class combos.
- If no HTML context is provided, you may still return navigate actions or your best guess for common sites.`;

  if (hasHtml) {
    prompt += `\n\nThe user has provided the current page HTML. Use it to determine accurate CSS selectors for interaction actions.`;
  } else {
    prompt += `\n\nNo page HTML is available (the page may be a protected browser page or a new tab). Focus on navigation actions.`;
  }

  return prompt;
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

    // Call Groq AI
    const systemPrompt = getSystemPrompt(!!pageHtml);
    const aiResponse = await callGroq(systemPrompt, userPrompt);

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
