// Content script for AI Task Automator
// Injected dynamically via chrome.scripting.executeScript

(function() {
  // Prevent double-injection
  if (window.__aiTaskAutomatorInjected) return;
  window.__aiTaskAutomatorInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getHTML") {
      try {
        const html = extractPageStructure();
        sendResponse({ html: html });
      } catch (err) {
        sendResponse({ html: document.title || "", error: err.message });
      }
      return true;
    }

    if (msg.type === "executeAction") {
      executeAction(msg.action)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
  });

  // Extract only meaningful, interactive elements from the page
  // instead of dumping raw outerHTML full of scripts/styles/SVGs
  function extractPageStructure() {
    const parts = [];
    parts.push(`<title>${document.title}</title>`);
    parts.push(`<url>${location.href}</url>`);

    // Collect all interactive and meaningful elements
    const selectors = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='search']",
      "[onclick]",
      "[data-action]",
      "form",
      "label",
      "nav",
      "h1", "h2", "h3",
      "[aria-label]",
      "[contenteditable]"
    ];

    const seen = new Set();
    const elements = document.querySelectorAll(selectors.join(","));

    for (const el of elements) {
      // Skip hidden elements
      if (el.offsetParent === null && el.tagName !== "INPUT" && el.getAttribute("type") !== "hidden") continue;

      const tag = el.tagName.toLowerCase();
      const attrs = [];

      // Collect useful attributes only
      if (el.id) attrs.push(`id="${el.id}"`);
      if (el.name) attrs.push(`name="${el.name}"`);
      if (el.className && typeof el.className === "string") {
        const cls = el.className.trim().split(/\s+/).slice(0, 3).join(" ");
        if (cls) attrs.push(`class="${cls}"`);
      }
      if (el.type) attrs.push(`type="${el.type}"`);
      if (el.href) {
        const href = el.getAttribute("href");
        if (href && !href.startsWith("javascript:")) attrs.push(`href="${href.substring(0, 100)}"`);
      }
      if (el.getAttribute("aria-label")) attrs.push(`aria-label="${el.getAttribute("aria-label")}"`);
      if (el.getAttribute("role")) attrs.push(`role="${el.getAttribute("role")}"`);
      if (el.getAttribute("placeholder")) attrs.push(`placeholder="${el.getAttribute("placeholder")}"`);
      if (el.getAttribute("data-testid")) attrs.push(`data-testid="${el.getAttribute("data-testid")}"`);
      if (el.getAttribute("for")) attrs.push(`for="${el.getAttribute("for")}"`);
      if (el.getAttribute("value") && tag === "input") attrs.push(`value="${el.getAttribute("value").substring(0, 50)}"`);
      if (el.getAttribute("action") && tag === "form") attrs.push(`action="${el.getAttribute("action").substring(0, 100)}"`);
      if (el.getAttribute("method") && tag === "form") attrs.push(`method="${el.getAttribute("method")}"`);

      // Get visible text (short)
      let text = "";
      if (tag !== "input" && tag !== "textarea" && tag !== "select" && tag !== "form" && tag !== "nav") {
        text = (el.textContent || "").trim().replace(/\s+/g, " ").substring(0, 60);
      }

      const line = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${text ? text : ""}</${tag}>`;

      // Deduplicate
      if (seen.has(line)) continue;
      seen.add(line);
      parts.push(line);

      // Stop if we're getting too long
      if (parts.join("\n").length > 7500) break;
    }

    return parts.join("\n");
  }

  async function executeAction(action) {
    switch (action.type) {
      case "click": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        el.click();
        return { success: true };
      }

      case "fill": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        // Set value directly then dispatch events for framework compat
        el.value = action.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // Also try native input event setter for React
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, action.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { success: true };
      }

      case "select": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };
      }

      case "check": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        const shouldCheck = action.checked !== undefined ? action.checked : true;
        if (el.checked !== shouldCheck) {
          el.click();
        }
        return { success: true };
      }

      case "submit": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        if (el.tagName === "FORM") {
          el.submit();
        } else {
          const form = el.closest("form");
          if (form) form.submit();
          else el.click();
        }
        return { success: true };
      }

      case "scroll": {
        const amount = action.amount || 500;
        const dir = action.direction || "down";
        let x = 0, y = 0;
        switch (dir) {
          case "down":  y = amount; break;
          case "up":    y = -amount; break;
          case "right": x = amount; break;
          case "left":  x = -amount; break;
        }
        window.scrollBy({ left: x, top: y, behavior: "smooth" });
        return { success: true };
      }

      case "getText": {
        const el = findElement(action);
        if (!el) return { error: `Element not found: ${action.selector}`, availableElements: getSimilarElements(action) };
        return { success: true, text: el.textContent.trim() };
      }

      default:
        return { error: `Unknown action type: ${action.type}` };
    }
  }

  // Smart element finder — tries selector first, then falls back to text matching
  function findElement(action) {
    // Try the CSS selector first
    if (action.selector) {
      try {
        const el = document.querySelector(action.selector);
        if (el) return el;
      } catch (e) { /* invalid selector */ }
    }

    // Fallback: try to find by text content if the selector looks like it has text clues
    if (action.selector) {
      const textHint = action.selector
        .replace(/[\[\](){}='"~^$*>+#.:,]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      if (textHint.length > 2) {
        // Search buttons and links by text
        const candidates = document.querySelectorAll("a, button, [role='button'], input[type='submit'], input[type='button']");
        for (const el of candidates) {
          const elText = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase();
          if (elText.includes(textHint) || textHint.includes(elText.trim())) {
            return el;
          }
        }
      }
    }

    return null;
  }

  // When element not found, report what similar elements exist so AI can retry
  function getSimilarElements(action) {
    const tag = (action.selector || "").match(/^(\w+)/)?.[1] || "";
    const searchTags = tag ? tag : "a,button,[role='button'],input,textarea";
    const elements = [];
    try {
      const els = document.querySelectorAll(searchTags);
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const desc = describeElement(el);
        if (desc) elements.push(desc);
        if (elements.length >= 15) break;
      }
    } catch (e) {
      // If tag selector fails, search common interactive elements
      const els = document.querySelectorAll("a,button,[role='button'],input");
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const desc = describeElement(el);
        if (desc) elements.push(desc);
        if (elements.length >= 15) break;
      }
    }
    return elements.join("\n");
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const parts = [tag];
    if (el.id) parts.push(`id="${el.id}"`);
    if (el.className && typeof el.className === "string") parts.push(`class="${el.className.trim().split(/\s+/).slice(0, 2).join(" ")}"`);
    if (el.getAttribute("aria-label")) parts.push(`aria-label="${el.getAttribute("aria-label")}"`);
    if (el.href) parts.push(`href="${el.getAttribute("href")?.substring(0, 60)}"`);
    const text = (el.textContent || "").trim().substring(0, 40);
    if (text) parts.push(`"${text}"`);
    return parts.join(" ");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
