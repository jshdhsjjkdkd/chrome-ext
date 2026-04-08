// Content script — injected dynamically by background.js
(function() {
  if (window.__aiTaskAutomator) return;
  window.__aiTaskAutomator = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getPageContext") {
      try {
        sendResponse({ context: extractPageContext() });
      } catch (err) {
        sendResponse({ context: `<title>${document.title}</title>`, error: err.message });
      }
      return true;
    }

    if (msg.type === "executeAction") {
      runAction(msg.action)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    }
  });

  // =========================================================
  // PAGE CONTEXT EXTRACTION
  // Builds a clean, concise summary of all interactive elements
  // with unique selectors the AI can directly use
  // =========================================================
  function extractPageContext() {
    const lines = [];
    lines.push(`TITLE: ${document.title}`);
    lines.push(`URL: ${location.href}`);
    lines.push("---ELEMENTS---");

    const INTERACTIVE = [
      "a[href]", "button", "input", "textarea", "select",
      "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
      "[role='search']", "[role='textbox']", "[role='combobox']",
      "[contenteditable='true']", "[onclick]", "[data-action]",
      "form", "label[for]",
      "h1", "h2", "h3"
    ];

    const seen = new Set();
    const all = document.querySelectorAll(INTERACTIVE.join(","));
    let totalLen = 0;

    for (const el of all) {
      if (totalLen > 7000) break;

      // Skip invisible elements (but keep hidden inputs)
      if (!isVisible(el) && !(el.tagName === "INPUT" && el.type === "hidden")) continue;

      const selector = buildUniqueSelector(el);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);

      const tag = el.tagName.toLowerCase();
      const parts = [`<${tag}`];

      // Key attributes
      const attrs = getKeyAttributes(el, tag);
      if (attrs) parts.push(attrs);
      parts.push(`sel="${selector}"`);

      // Visible text
      const text = getVisibleText(el, tag);
      if (text) {
        parts.push(`>${text}</${tag}>`);
      } else {
        parts.push(`/>`);
      }

      const line = parts.join(" ");
      lines.push(line);
      totalLen += line.length;
    }

    return lines.join("\n");
  }

  function isVisible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function buildUniqueSelector(el) {
    // Priority: id > name > unique aria-label > data-testid > computed path
    if (el.id) return `#${CSS.escape(el.id)}`;

    const tag = el.tagName.toLowerCase();

    if (el.name && (tag === "input" || tag === "textarea" || tag === "select")) {
      const sel = `${tag}[name="${CSS.escape(el.name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      const sel = `[aria-label="${CSS.escape(ariaLabel)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const testId = el.getAttribute("data-testid");
    if (testId) {
      const sel = `[data-testid="${CSS.escape(testId)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      const sel = `${tag}[placeholder="${CSS.escape(placeholder)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const role = el.getAttribute("role");
    if (role) {
      const sel = `[role="${CSS.escape(role)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    if (tag === "input" && el.type) {
      const sel = `input[type="${el.type}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Build a path-based selector
    return buildPathSelector(el);
  }

  function buildPathSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 4) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)} `);
        break;
      }
      // Add nth-of-type if needed
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    const sel = parts.join(" > ").replace(/\s+/g, " ").trim();
    try {
      if (document.querySelector(sel) === el) return sel;
    } catch (e) {}
    return null;
  }

  function getKeyAttributes(el, tag) {
    const parts = [];
    if (el.type && tag === "input") parts.push(`type="${el.type}"`);
    if (el.name) parts.push(`name="${el.name}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder.substring(0, 50)}"`);
    if (el.getAttribute("aria-label")) parts.push(`aria-label="${el.getAttribute("aria-label").substring(0, 50)}"`);
    if (el.getAttribute("role")) parts.push(`role="${el.getAttribute("role")}"`);
    if (el.href) {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`href="${href.substring(0, 80)}"`);
    }
    if (el.getAttribute("value") && tag === "input" && el.type !== "password") {
      parts.push(`value="${el.getAttribute("value").substring(0, 30)}"`);
    }
    if (el.getAttribute("action") && tag === "form") parts.push(`action="${el.getAttribute("action").substring(0, 80)}"`);
    return parts.length ? parts.join(" ") : "";
  }

  function getVisibleText(el, tag) {
    if (["input", "textarea", "select", "form"].includes(tag)) return "";
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    return text.substring(0, 60);
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
    // 1. Try the exact selector
    if (action.selector) {
      try {
        const el = document.querySelector(action.selector);
        if (el) return el;
      } catch (e) {}
    }

    // 2. Try fuzzy text match on interactive elements
    if (action.selector) {
      const hint = action.selector
        .replace(/[[\](){}='"~^$*>+#.:,\\]/g, " ")
        .replace(/\s+/g, " ").trim().toLowerCase();

      if (hint.length > 1) {
        const candidates = document.querySelectorAll(
          "a, button, [role='button'], [role='link'], input[type='submit'], input[type='button']"
        );
        // Exact text match first
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (t === hint) return el;
        }
        // Partial match
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (t.includes(hint) || hint.includes(t)) return el;
        }
      }
    }

    return null;
  }

  function notFound(action) {
    return {
      error: `Element not found: ${action.selector}`,
      availableElements: collectAvailableElements()
    };
  }

  function collectAvailableElements() {
    const lines = [];
    const els = document.querySelectorAll(
      "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='tab']"
    );
    for (const el of els) {
      if (!isVisible(el)) continue;
      const sel = buildUniqueSelector(el);
      const text = (el.textContent || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().substring(0, 50);
      const tag = el.tagName.toLowerCase();
      lines.push(`${tag} sel="${sel}" "${text}"`);
      if (lines.length >= 25) break;
    }
    return lines.join("\n");
  }

  // --- Individual actions ---

  async function doClick(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200);
    // Simulate real click sequence
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

    // Focus
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Clear existing value
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Set value using native setter (works with React/Angular/Vue)
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) {
      nativeSetter.call(el, action.value);
    } else {
      el.value = action.value;
    }

    // Fire events that frameworks listen for
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // Also dispatch keyboard events for sites that need them
    for (const char of action.value) {
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

    el.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key}`, keyCode, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key, code: `Key${key}`, keyCode, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, code: `Key${key}`, keyCode, bubbles: true }));

    // For Enter on forms, also try to submit
    if (key === "Enter") {
      const form = el.closest("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }

    return { success: true };
  }

  async function doSubmit(action) {
    const el = findEl(action);
    if (!el) return notFound(action);

    const form = el.tagName === "FORM" ? el : el.closest("form");
    if (form) {
      const submitBtn = form.querySelector("[type='submit'], button:not([type='button'])");
      if (submitBtn) submitBtn.click();
      else form.requestSubmit ? form.requestSubmit() : form.submit();
    } else {
      el.click();
    }
    return { success: true };
  }

  async function doSelect(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, action.value);
    else el.value = action.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true };
  }

  async function doCheck(action) {
    const el = findEl(action);
    if (!el) return notFound(action);
    const want = action.checked !== undefined ? action.checked : true;
    if (el.checked !== want) el.click();
    return { success: true };
  }

  async function doScroll(action) {
    const amount = action.amount || 500;
    const map = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
    const [x, y] = map[action.direction || "down"] || [0, amount];
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
