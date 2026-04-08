const _k = ["Z3NrX2xvUGwxMlh0VH", "JYVWM3c3pHejhSV0dk", "eWIzRllQelRKRUVnUn", "dXelBScWVHMlY2SHRM", "MDI="];
const GROQ_API_KEY = atob(_k.join(""));
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_MODEL_FAST = "llama-3.1-8b-instant";

let stopRequested = false;

class ElementNotFoundError extends Error {
  constructor(message, availableElements) {
    super(message);
    this.availableElements = availableElements;
  }
}

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
    // Small delay to let page settle after navigation
    await new Promise(r => setTimeout(r, 500));
    const results = await chrome.tabs.sendMessage(tabId, { type: "getHTML" });
    if (results && results.html) {
      log(`Got page structure (${results.html.length} chars)`);
      return results.html;
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
        // Element not found — return error info for retry logic
        throw new ElementNotFoundError(result.error, result.availableElements || "");
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

    // If AI returned actions without HTML but some actions need page interaction,
    // check if there's a navigate first — we'll re-read HTML after it
    const hasNavigate = aiResponse.actions.some(a => a.type === "navigate");
    const hasInteraction = aiResponse.actions.some(a =>
      ["click","fill","select","check","submit","getText"].includes(a.type)
    );

    // If we have navigate + interaction but AI had no HTML context,
    // we need to re-ask AI after navigation with fresh HTML for accurate selectors
    let needsSecondPass = hasNavigate && hasInteraction && !pageHtml;

    // Execute each action sequentially with retry on element-not-found
    for (let i = 0; i < aiResponse.actions.length; i++) {
      if (stopRequested) {
        log("Execution stopped by user");
        return;
      }

      let action = aiResponse.actions[i];
      log(`Executing action ${i + 1}/${aiResponse.actions.length}: ${action.type}`);

      // Get fresh tab reference (tab may have navigated)
      let currentTab = await getActiveTab();

      // After navigation, if we need interaction, re-ask AI with fresh page HTML
      if (action.type === "navigate" && needsSecondPass) {
        await executeAction(action, currentTab.id);
        log("Re-reading page after navigation for accurate selectors...");
        currentTab = await getActiveTab();
        const freshHtml = isProtectedUrl(currentTab.url) ? null : await getPageHtml(currentTab.id);
        if (freshHtml) {
          const secondPrompt = `Command: ${command}\n\nI already navigated to ${currentTab.url}. Now I need to perform the remaining interactions.\n\nCurrent page HTML structure:\n${freshHtml}`;
          const secondResponse = await callGroq(getSystemPrompt(true), secondPrompt);
          if (secondResponse.actions && secondResponse.actions.length > 0) {
            // Replace remaining actions with AI's new ones (skip any navigate actions since we're already there)
            const newActions = secondResponse.actions.filter(a => a.type !== "navigate");
            aiResponse.actions.splice(i + 1, aiResponse.actions.length, ...newActions);
            log(`AI provided ${newActions.length} updated interaction action(s) with page context`);
          }
        }
        needsSecondPass = false;
        continue;
      }

      let retries = 0;
      const maxRetries = 2;

      while (true) {
        try {
          await executeAction(action, currentTab.id);
          break; // success
        } catch (err) {
          if (err instanceof ElementNotFoundError && retries < maxRetries) {
            retries++;
            log(`Element not found, retrying with AI correction (attempt ${retries}/${maxRetries})...`);

            // Re-read the page HTML to give AI fresh context
            currentTab = await getActiveTab();
            const freshHtml = isProtectedUrl(currentTab.url) ? null : await getPageHtml(currentTab.id);

            const retryPrompt = `The previous action FAILED because the selector "${action.selector}" was not found on the page.
Original command: ${command}
Failed action: ${JSON.stringify(action)}

${err.availableElements ? `Here are some elements actually on the page:\n${err.availableElements}\n` : ""}
${freshHtml ? `Current page HTML structure:\n${freshHtml}` : `Current page URL: ${currentTab.url}`}

Return a corrected single action with a working selector. Use ONLY elements from the HTML above. Return JSON: {"actions":[<one corrected action>],"explanation":"..."}`;

            const corrected = await callGroq(getSystemPrompt(!!freshHtml), retryPrompt);
            if (corrected.actions && corrected.actions.length > 0) {
              action = corrected.actions[0];
              log(`AI corrected selector to: ${action.selector || "(no selector)"}`);
            } else {
              throw new Error(`AI could not find a valid selector after retry`);
            }
          } else {
            throw err;
          }
        }
      }
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
