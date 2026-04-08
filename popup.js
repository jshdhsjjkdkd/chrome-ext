const commandInput = document.getElementById("commandInput");
const executeBtn = document.getElementById("executeBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const statusLog = document.getElementById("statusLog");
const charCount = document.getElementById("charCount");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");

let running = false;
let port = null;

// --- Persistent port connection to background ---
function connectPort() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "log") addLog(msg.text, msg.level || "info");
    if (msg.type === "done") setRunning(false, "done");
    if (msg.type === "error") setRunning(false, "error");
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // Reconnect if popup is still open
    setTimeout(() => { if (!port) connectPort(); }, 500);
  });
}
connectPort();

// --- Logging ---
function addLog(text, level) {
  const entry = document.createElement("div");
  entry.classList.add("log-entry");
  if (level) entry.classList.add(level);

  const ts = new Date().toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });

  entry.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(text)}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;

  // Keep log from growing too large
  while (statusLog.children.length > 200) {
    statusLog.removeChild(statusLog.firstChild);
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// --- State ---
function setRunning(isRunning, reason) {
  running = isRunning;
  executeBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  commandInput.disabled = isRunning;

  statusIndicator.className = "";
  if (isRunning) {
    statusIndicator.classList.add("running");
    statusText.textContent = "Running...";
  } else if (reason === "error") {
    statusIndicator.classList.add("error");
    statusText.textContent = "Error";
  } else {
    statusText.textContent = "Ready";
  }
}

// --- Execute ---
function executeCommand() {
  const command = commandInput.value.trim();
  if (!command || running) return;

  addLog(`> ${command}`, "cmd");
  saveHistory(command);
  setRunning(true);

  if (port) {
    port.postMessage({ type: "execute", command });
  } else {
    // Fallback to one-shot message
    chrome.runtime.sendMessage({ type: "execute", command }, (response) => {
      if (chrome.runtime.lastError) {
        addLog(`Connection error: ${chrome.runtime.lastError.message}`, "error");
        setRunning(false, "error");
      } else if (response && !response.success) {
        addLog(`Error: ${response.error}`, "error");
        setRunning(false, "error");
      } else {
        setRunning(false, "done");
      }
    });
  }
}

// --- Event listeners ---
executeBtn.addEventListener("click", executeCommand);

commandInput.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+Enter to execute
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    executeCommand();
    return;
  }
  // Plain Enter on single-line also executes
  if (e.key === "Enter" && !e.shiftKey && commandInput.value.indexOf("\n") === -1) {
    e.preventDefault();
    executeCommand();
  }
  // Up arrow when empty loads last command
  if (e.key === "ArrowUp" && commandInput.value === "") {
    e.preventDefault();
    loadLastHistory();
  }
});

commandInput.addEventListener("input", () => {
  charCount.textContent = commandInput.value.length;
  // Auto-resize
  commandInput.style.height = "auto";
  commandInput.style.height = Math.min(commandInput.scrollHeight, 120) + "px";
});

stopBtn.addEventListener("click", () => {
  if (port) port.postMessage({ type: "stop" });
  else chrome.runtime.sendMessage({ type: "stop" });
  addLog("Stop requested", "retry");
  setRunning(false);
});

clearBtn.addEventListener("click", () => {
  statusLog.innerHTML = "";
  addLog("Log cleared", "info");
});

// --- Command history (chrome.storage.local) ---
function saveHistory(cmd) {
  chrome.storage.local.get({ history: [] }, (data) => {
    const h = data.history.filter(c => c !== cmd);
    h.unshift(cmd);
    chrome.storage.local.set({ history: h.slice(0, 30) });
  });
}

function loadLastHistory() {
  chrome.storage.local.get({ history: [] }, (data) => {
    if (data.history.length > 0) {
      commandInput.value = data.history[0];
      charCount.textContent = commandInput.value.length;
    }
  });
}

addLog("Ready. Type a command and press Enter or click Execute.", "info");
