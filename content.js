// Content script — injected dynamically by background.js
(function() {
  // Always replace old listener for reliable re-injection
  if (window.__aiTaskAutomatorFn) {
    try { chrome.runtime.onMessage.removeListener(window.__aiTaskAutomatorFn); } catch (e) {}
  }

  function listener(msg, sender, sendResponse) {
    if (msg.type === "getPageContext") {
      try {
        sendResponse({ context: extractPageContext() });
      } catch (err) {
        sendResponse({ context: `TITLE:${document.title}\nURL:${location.href}`, error: err.message });
      }
      return true;
    }
    if (msg.type === "executeAction") {
      runAction(msg.action)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }
  }

  window.__aiTaskAutomatorFn = listener;
  chrome.runtime.onMessage.addListener(listener);

  // =========================================================
  // PAGE CONTEXT — clean format, no quote conflicts
  // Format: description | CSS_SELECTOR
  // The AI copies the part after | as the CSS selector
  // =========================================================
  function extractPageContext() {
    const lines = [];
    lines.push(`TITLE: ${document.title}`);
    lines.push(`URL: ${location.href}`);
    lines.push("ELEMENTS (use the value after | as your CSS selector):");

    const INTERACTIVE = [
      "a[href]", "button", "input", "textarea", "select",
      "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
      "[role='search']", "[role='textbox']", "[role='combobox']",
      "[contenteditable='true']", "[onclick]",
      "form", "label[for]", "h1", "h2", "h3"
    ];

    const seen = new Set();
    const all = document.querySelectorAll(INTERACTIVE.join(","));
    let totalLen = 0;

    for (const el of all) {
      if (totalLen > 7000) break;
      if (!isVisible(el) && !(el.tagName === "INPUT" && el.type === "hidden")) continue;

      const selector = buildSelector(el);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);

      const tag = el.tagName.toLowerCase();
      const desc = buildDescription(el, tag);
      const text = getVisibleText(el, tag);

      const line = text
        ? `${desc} "${text}" | ${selector}`
        : `${desc} | ${selector}`;

      lines.push(line);
      totalLen += line.length;
    }

    return lines.join("\n");
  }

  function isVisible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // Build a human-readable description of the element
  function buildDescription(el, tag) {
    const parts = [tag];
    if (el.type && (tag === "input" || tag === "button")) parts.push(`type="${el.type}"`);
    if (el.name) parts.push(`name="${el.name}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder.substring(0, 40)}"`);
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(`aria-label="${aria.substring(0, 40)}"`);
    const role = el.getAttribute("role");
    if (role) parts.push(`role="${role}"`);
    if (el.href) {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`href="${href.substring(0, 60)}"`);
    }
    if (tag === "input" && el.type !== "password" && el.value) {
      parts.push(`value="${el.value.substring(0, 30)}"`);
    }
    return parts.join(" ");
  }

  // Build a unique CSS selector — NO CSS.escape on attribute values
  // CSS.escape only needed for IDs (which can start with digits etc.)
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const tag = el.tagName.toLowerCase();

    // name attribute (for inputs)
    if (el.name && (tag === "input" || tag === "textarea" || tag === "select")) {
      const sel = `${tag}[name="${el.name}"]`;
      if (isUnique(sel)) return sel;
    }

    // aria-label
    const aria = el.getAttribute("aria-label");
    if (aria) {
      const sel = `[aria-label="${aria}"]`;
      if (isUnique(sel)) return sel;
    }

    // data-testid
    const testId = el.getAttribute("data-testid");
    if (testId) {
      const sel = `[data-testid="${testId}"]`;
      if (isUnique(sel)) return sel;
    }

    // placeholder
    if (el.placeholder) {
      const sel = `${tag}[placeholder="${el.placeholder}"]`;
      if (isUnique(sel)) return sel;
    }

    // type for inputs
    if (tag === "input" && el.type) {
      const sel = `input[type="${el.type}"]`;
      if (isUnique(sel)) return sel;
    }

    // role
    const role = el.getAttribute("role");
    if (role) {
      const sel = `[role="${role}"]`;
      if (isUnique(sel)) return sel;
    }

    // value for submit buttons
    if (tag === "input" && el.value) {
      const sel = `input[value="${el.value}"]`;
      if (isUnique(sel)) return sel;
    }

    // button type
    if (tag === "button" && el.type) {
      const sel = `button[type="${el.type}"]`;
      if (isUnique(sel)) return sel;
    }

    // Path-based fallback
    return buildPathSelector(el);
  }

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; }
    catch (e) { return false; }
  }

  function buildPathSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 4) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    const sel = parts.join(" > ");
    try { if (document.querySelector(sel) === el) return sel; } catch (e) {}
    return null;
  }

  function getVisibleText(el, tag) {
    if (["input", "textarea", "select", "form"].includes(tag)) return "";
    return (el.textContent || "").trim().replace(/\s+/g, " ").substring(0, 50);
  }

  // =========================================================
  // ACTION EXECUTION
  // =========================================================
  async function runAction(action) {
    switch (action.type) {
      case "click": return doClick(action);
      case "fill": return doFill(action);
      case "pressKey": return doPressKey(action);
      case "submit": return doSubmit(action);
      case "select": return doSelect(action);
      case "check": return doCheck(action);
      case "scroll": return doScroll(action);
      case "getText": return doGetText(action);
      default: return { error: `Unknown action: ${action.type}` };
    }
  }

  function findEl(action) {
    if (action.selector) {
      try {
        const el = document.querySelector(action.selector);
        if (el) return el;
      } catch (e) {}
    }

    // Fuzzy text fallback
    if (action.selector) {
      const hint = action.selector.replace(/[[\](){}='"~^$*>+#.:,\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (hint.length > 1) {
        const all = document.querySelectorAll("a, button, [role='button'], [role='link'], input[type='submit'], input[type='button']");
        for (const el of all) {
          if (!isVisible(el)) continue;
          const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (t === hint) return el;
        }
        for (const el of all) {
          if (!isVisible(el)) continue;
          const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (t.includes(hint) || hint.includes(t)) return el;
        }
      }
    }
    return null;
  }

  function notFound(action) {
    return { error: `Element not found: ${action.selector}`, availableElements: listAvailable() };
  }

  function listAvailable() {
    const lines = [];
    const els = document.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='link']");
    for (const el of els) {
      if (!isVisible(el)) continue;
      const sel = buildSelector(el);
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().substring(0, 40);
      lines.push(`${tag} "${text}" | ${sel}`);
      if (lines.length >= 25) break;
    }
    return lines.join("\n");
  }

  async function doClick(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200);
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return { success: true };
  }

  async function doFill(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Clear
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Set via native setter for React/Angular/Vue
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, action.value);
    else el.value = action.value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // Keyboard events for sites that need them
    for (const char of action.value.slice(0, 20)) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }
    return { success: true };
  }

  async function doPressKey(action) {
    const el = action.selector ? findEl(action) : document.activeElement;
    if (!el) return notFound(action);
    const key = action.key || "Enter";
    const keyCode = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key, keyCode, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, keyCode, bubbles: true }));
    if (key === "Enter") {
      const form = el.closest("form");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    return { success: true };
  }

  async function doSubmit(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    const form = el.tagName === "FORM" ? el : el.closest("form");
    if (form) {
      const btn = form.querySelector("[type='submit'], button:not([type='button'])");
      if (btn) btn.click();
      else if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    } else {
      el.click();
    }
    return { success: true };
  }

  async function doSelect(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(el, action.value);
    else el.value = action.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true };
  }

  async function doCheck(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    if (el.checked !== (action.checked !== false)) el.click();
    return { success: true };
  }

  async function doScroll(action) {
    const amt = action.amount || 500;
    const map = { down: [0, amt], up: [0, -amt], right: [amt, 0], left: [-amt, 0] };
    const [x, y] = map[action.direction || "down"] || [0, amt];
    window.scrollBy({ left: x, top: y, behavior: "smooth" });
    return { success: true };
  }

  async function doGetText(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    return { success: true, text: el.textContent.trim().substring(0, 2000) };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
