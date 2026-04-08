// Content script for AI Task Automator
// Injected dynamically via chrome.scripting.executeScript

(function() {
  // Prevent double-injection
  if (window.__aiTaskAutomatorInjected) return;
  window.__aiTaskAutomatorInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getHTML") {
      try {
        const html = document.documentElement.outerHTML;
        sendResponse({ html: html });
      } catch (err) {
        sendResponse({ html: null, error: err.message });
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

  async function executeAction(action) {
    switch (action.type) {
      case "click": {
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(300);
        el.click();
        return { success: true };
      }

      case "fill": {
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
        el.value = "";
        // Dispatch events to trigger frameworks (React, Angular, etc.)
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        for (const char of action.value) {
          el.value += char;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };
      }

      case "select": {
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true };
      }

      case "check": {
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        const shouldCheck = action.checked !== undefined ? action.checked : true;
        if (el.checked !== shouldCheck) {
          el.click();
        }
        return { success: true };
      }

      case "submit": {
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        if (el.tagName === "FORM") {
          el.submit();
        } else {
          // Try to find a parent form
          const form = el.closest("form");
          if (form) {
            form.submit();
          } else {
            el.click();
          }
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
        const el = document.querySelector(action.selector);
        if (!el) return { error: `Element not found: ${action.selector}` };
        return { success: true, text: el.textContent.trim() };
      }

      default:
        return { error: `Unknown action type in content script: ${action.type}` };
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
