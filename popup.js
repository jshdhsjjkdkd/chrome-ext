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
let reconnectAttempts = 0;

function connectPort() {
  if (reconnectAttempts >= 10) return;

  try {
    port = chrome.runtime.connect({ name: "popup" });
  } catch (e) {
    reconnectAttempts++;
    return;
  }

  reconnectAttempts = 0;

  port.onMessage.addListener((msg) => {
    // Restore state when popup reopens — background sends logs + running status
    if (msg.type === "state") {
      if (msg.logs && msg.logs.length > 0) {
        for (const entry of msg.logs) {
          addLogWithTime(entry.text, entry.level, entry.ts);
        }
      }
      if (msg.isRunning) {
        setRunning(true);
      } else if (msg.lastResult === "done") {
        setRunning(false, "done");
      } else if (msg.lastResult === "error") {
        setRunning(false, "error");
      }
      return;
    }
    if (msg.type === "log") addLog(msg.text, msg.level);
    if (msg.type === "done") {
      addLog("Done", "success");
      setRunning(false, "done");
    }
    if (msg.type === "error") setRunning(false, "error");
  });
  port.onDisconnect.addListener(() => {
    port = null;
    reconnectAttempts++;
    const delay = Math.min(500 * reconnectAttempts, 5000);
    setTimeout(() => { if (!port) connectPort(); }, delay);
  });
}
connectPort();

function addLog(text, level) {
  const ts = new Date().toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  appendLogEntry(text, level, ts);
}

function addLogWithTime(text, level, timestamp) {
  const ts = new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  appendLogEntry(text, level, ts);
}

function appendLogEntry(text, level, ts) {
  const entry = document.createElement("div");
  entry.classList.add("log-entry");
  if (level) entry.classList.add(level);
  entry.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(text)}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
  while (statusLog.children.length > 100) statusLog.removeChild(statusLog.firstChild);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function setRunning(isRunning, reason) {
  running = isRunning;
  executeBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  commandInput.disabled = isRunning;

  statusIndicator.className = "";
  if (isRunning) {
    statusIndicator.classList.add("running");
    statusText.textContent = "Working...";
  } else if (reason === "error") {
    statusIndicator.classList.add("error");
    statusText.textContent = "Error";
  } else {
    statusText.textContent = "Ready";
  }
}

function executeCommand() {
  const command = commandInput.value.trim();
  if (!command || running) return;

  reconnectAttempts = 0;

  addLog(`> ${command}`, "cmd");
  saveHistory(command);
  setRunning(true);

  if (port) {
    port.postMessage({ type: "execute", command });
  } else {
    chrome.runtime.sendMessage({ type: "execute", command }, (response) => {
      if (chrome.runtime.lastError) {
        addLog(chrome.runtime.lastError.message, "error");
        setRunning(false, "error");
      } else if (response && !response.success) {
        addLog(response.error, "error");
        setRunning(false, "error");
      } else {
        addLog("Done", "success");
        setRunning(false, "done");
      }
    });
  }
}

executeBtn.addEventListener("click", executeCommand);

commandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); executeCommand(); return; }
  if (e.key === "Enter" && !e.shiftKey && !commandInput.value.includes("\n")) { e.preventDefault(); executeCommand(); }
  if (e.key === "ArrowUp" && commandInput.value === "") { e.preventDefault(); loadLastHistory(); }
});

commandInput.addEventListener("input", () => {
  charCount.textContent = commandInput.value.length;
  commandInput.style.height = "auto";
  commandInput.style.height = Math.min(commandInput.scrollHeight, 120) + "px";
});

stopBtn.addEventListener("click", () => {
  if (port) port.postMessage({ type: "stop" });
  else chrome.runtime.sendMessage({ type: "stop" });
  addLog("Stopped", "retry");
  setRunning(false);
});

clearBtn.addEventListener("click", () => {
  statusLog.innerHTML = "";
});

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
