const commandInput = document.getElementById("commandInput");
const executeBtn = document.getElementById("executeBtn");
const stopBtn = document.getElementById("stopBtn");
const statusLog = document.getElementById("statusLog");

let running = false;

function addLog(text) {
  const entry = document.createElement("div");
  entry.classList.add("log-entry");

  if (text.startsWith("Error")) {
    entry.classList.add("error");
  } else if (text.startsWith("Executing action") || text.startsWith("Navigating")) {
    entry.classList.add("action");
  } else {
    entry.classList.add("info");
  }

  const timestamp = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  entry.textContent = `[${timestamp}] ${text}`;
  statusLog.appendChild(entry);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function setRunning(isRunning) {
  running = isRunning;
  executeBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  commandInput.disabled = isRunning;
}

function executeCommand() {
  const command = commandInput.value.trim();
  if (!command) return;

  addLog(`Command: "${command}"`);
  setRunning(true);

  chrome.runtime.sendMessage({ type: "execute", command }, (response) => {
    if (chrome.runtime.lastError) {
      addLog(`Error: ${chrome.runtime.lastError.message}`);
    } else if (response && !response.success) {
      addLog(`Error: ${response.error}`);
    } else {
      addLog("Done!");
    }
    setRunning(false);
  });
}

executeBtn.addEventListener("click", executeCommand);

commandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !running) {
    executeCommand();
  }
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" }, () => {
    addLog("Stop requested");
    setRunning(false);
  });
});

// Listen for log messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "log") {
    addLog(msg.text);
  }
});

addLog("Ready. Enter a command and click Execute.");
