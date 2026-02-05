// Configuration
const CHUNK_SIZE = 64 * 1024; // 64KB safe chunk size
const PARALLEL_CHUNKS = 4; // Slightly increased parallelism
let ENCRYPTION_KEY = "";

// State
let ws = null;
let currentMode = null;
let sessionCode = null;
let selectedFiles = [];
let receiverCount = 0;
let fileStates = new Map();
let messages = [];
let currentTab = "files";

// Initialize WebSocket connection
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      log("Connected to server", "success");
      updateConnectionStatus(true);
      resolve();
    };

    ws.onclose = () => {
      log("Disconnected from server", "error");
      updateConnectionStatus(false);
      // Only reconnect if we were in a session
      if (sessionCode) {
        setTimeout(connectWebSocket, 3000);
      }
    };

    ws.onerror = (error) => {
      log("Connection error", "error");
      updateConnectionStatus(false);
      reject(error);
    };

    ws.onmessage = handleMessage;
  });
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  if (dot && text) {
    if (connected) {
      dot.classList.add("connected");
      text.textContent = "Connected";
    } else {
      dot.classList.remove("connected");
      text.textContent = "Disconnected";
    }
  }
}

function handleMessage(event) {
  try {
    const data = JSON.parse(event.data);
    // Don't log every chunk to avoid console spam
    if (data.type !== "chunk") {
      log(`Received: ${data.type}`, "info");
    }

    switch (data.type) {
      case "code":
        handleCodeReceived(data);
        break;
      case "joined":
        handleJoined(data);
        break;
      case "connected":
      case "sender_connected":
        handleSenderConnectedToReceiver();
        break;
      case "receiver_count":
        updateReceiverCount(data.receivers);
        break;
      case "metadata":
        handleMetadata(data);
        break;
      case "chunk":
        handleChunk(data);
        break;
      case "done":
        handleFileDone(data);
        break;
      case "all_done":
        handleAllDone();
        break;
      case "text_message":
        handleTextMessage(data);
        break;
      case "text_ack":
        handleTextAck(data);
        break;
      case "error":
        handleError(data);
        break;
      case "sender_disconnected":
        log("Sender disconnected", "error");
        showNotification("Sender disconnected", "error");
        break;
    }
  } catch (e) {
    console.error("Error processing message:", e);
  }
}

function log(message, type = "info") {
  console.log(`[${type.toUpperCase()}] ${message}`);
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement("div");
  logEntry.className = `log-entry ${type}`;
  logEntry.textContent = `[${timestamp}] ${message}`;

  const logContainer = document.querySelector(".log");
  if (logContainer) {
    logContainer.insertBefore(logEntry, logContainer.firstChild);
    // Limit log entries
    if (logContainer.children.length > 50) {
      logContainer.removeChild(logContainer.lastChild);
    }
  }
}

// ... [startReceiving and startSending functions remain mostly the same] ...
// Re-implementing startReceiving and startSending to ensure context is clear

async function startReceiving() {
  currentMode = "receive";
  messages = [];
  if (!ws || ws.readyState !== WebSocket.OPEN) await connectWebSocket();

  document.getElementById("app").innerHTML = `
    <div class="card">
      <h2>📥 Join Session</h2>
      <div class="input-group">
        <label>Enter Sender Code</label>
        <input type="text" id="codeInput" maxlength="6" placeholder="6-digit code">
      </div>
      <div style="display:flex;gap:1rem;">
        <button class="btn" onclick="joinSession()">Join</button>
        <button class="btn" onclick="scanQR()">📷 Scan QR</button>
      </div>
      <div id="qr-reader" style="width:300px;margin-top:1rem;"></div>
    </div>
    <div class="card">
      <div class="tab-container">
        <button class="tab-btn active" onclick="switchTab('files',this)">📁 Files</button>
        <button class="tab-btn" onclick="switchTab('messages',this)">💬 Messages</button>
      </div>
      <div id="filesTab" class="tab-content active">
        <div class="progress-container" id="progressContainer"></div>
      </div>
      <div id="messagesTab" class="tab-content">
        <div class="messages-display" id="messagesDisplay"></div>
      </div>
    </div>
    <div class="card"><div class="log"></div></div>
  `;
}

async function startSending() {
  currentMode = "send";
  messages = [];
  if (!ws || ws.readyState !== WebSocket.OPEN) await connectWebSocket();

  document.getElementById("app").innerHTML = `
    <div class="card">
        <h2>📤 Sending Mode</h2>
        <div class="input-group">
            <div class="qr-container">
                <div class="join-code" id="joinCode">------</div>
                <canvas id="qrcode"></canvas>
                <div class="status-badge info"><span>⏳</span><span>Waiting for receivers...</span></div>
            </div>
            <div class="receiver-count hidden" id="receiverCountContainer">
                <div class="receiver-count-number" id="receiverCountNumber">0</div>
                <div class="receiver-count-label">receivers connected</div>
            </div>
        </div>
    </div>
    <div class="card">
        <div class="tab-container">
            <button class="tab-btn active" onclick="switchTab('files',this)">📁 Files</button>
            <button class="tab-btn" onclick="switchTab('messages',this)">💬 Messages</button>
        </div>
        <div id="filesTab" class="tab-content active">
            <h3>Send Files</h3>
            <div class="input-group">
                <label for="fileInput">Select Files</label>
                <input type="file" id="fileInput" multiple onchange="handleFileSelection(event)">
            </div>
            <div class="file-list" id="fileList"></div>
            <button class="btn" onclick="startTransfer()" id="sendBtn" disabled style="margin-top: 1rem;">
                <span>🚀</span><span>Send Files</span>
            </button>
            <div class="progress-container" id="progressContainer" style="margin-top: 1.5rem;"></div>
        </div>
        <div id="messagesTab" class="tab-content">
            <h3>Send Text Message</h3>
            <div class="text-message-container">
                <div class="text-input-area">
                    <textarea class="text-input" id="textInput" placeholder="Type encrypted message..." maxlength="100000" oninput="updateCharCount()"></textarea>
                    <div class="text-input-controls">
                        <span class="text-char-count" id="charCount">0 / 100,000</span>
                        <div class="text-actions">
                            <button class="btn-icon" onclick="pasteText()"><span>📋</span><span>Paste</span></button>
                            <button class="btn" onclick="sendTextMessage()" id="sendTextBtn" disabled><span>📤</span><span>Send</span></button>
                        </div>
                    </div>
                </div>
                <div class="messages-display" id="messagesDisplay"><div class="empty-messages">No messages sent yet</div></div>
            </div>
        </div>
    </div>
    <div class="card"><h3>Activity Log</h3><div class="log"></div></div>
  `;
  ws.send(JSON.stringify({ type: "create_session" }));
}

function handleFileSelection(event) {
  selectedFiles = Array.from(event.target.files);
  updateFileList();
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.disabled = !(selectedFiles.length > 0 && sessionCode);
}

function updateFileList() {
  const fileList = document.getElementById("fileList");
  if (!fileList) return;
  fileList.innerHTML = selectedFiles
    .map(
      (file, index) => `
    <div class="file-item">
      <div class="file-info">
        <span class="file-icon">📄</span>
        <div class="file-details">
          <div class="file-name">${file.name}</div>
          <div class="file-size">${formatBytes(file.size)}</div>
        </div>
      </div>
      <button class="file-remove" onclick="removeFile(${index})">Remove</button>
    </div>`,
    )
    .join("");
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  updateFileList();
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.disabled = selectedFiles.length === 0;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024,
    sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function updateReceiverCount(count) {
  receiverCount = count;
  const container = document.getElementById("receiverCountContainer");
  const number = document.getElementById("receiverCountNumber");
  if (container && number) {
    container.classList.remove("hidden");
    number.textContent = count;
  }
}

// --- Transfer Logic ---

async function startTransfer() {
  if (selectedFiles.length === 0) return;
  document.getElementById("sendBtn").disabled = true;
  document.getElementById("progressContainer").innerHTML = "";

  for (let i = 0; i < selectedFiles.length; i++) {
    await transferFile(
      selectedFiles[i],
      `file_${Date.now()}_${i}`,
      i,
      selectedFiles.length,
    );
  }

  ws.send(JSON.stringify({ type: "all_done", code: sessionCode }));
  log("All files transferred!", "success");
  document.getElementById("sendBtn").disabled = false;
}

async function transferFile(file, fileId, fileIndex, totalFiles) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Create UI
  const progressItem = document.createElement("div");
  progressItem.className = "progress-item";
  progressItem.id = `progress_${fileId}`;
  progressItem.innerHTML = `
    <div class="progress-header">
      <span class="progress-title">${file.name}</span>
      <span class="progress-percentage">0%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
  `;
  document.getElementById("progressContainer").appendChild(progressItem);

  ws.send(
    JSON.stringify({
      type: "metadata",
      code: sessionCode,
      name: file.name,
      size: file.size,
      totalChunks: totalChunks,
      fileId: fileId,
      fileIndex: fileIndex,
      totalFiles: totalFiles,
    }),
  );

  // Batch process chunks
  for (let i = 0; i < totalChunks; i += PARALLEL_CHUNKS) {
    const chunkPromises = [];
    for (let j = 0; j < PARALLEL_CHUNKS && i + j < totalChunks; j++) {
      chunkPromises.push(sendChunk(file, fileId, i + j));
    }
    await Promise.all(chunkPromises);
    updateProgress(
      fileId,
      Math.min(((i + PARALLEL_CHUNKS) / totalChunks) * 100, 100),
    );
  }

  ws.send(
    JSON.stringify({
      type: "done",
      code: sessionCode,
      name: file.name,
      fileId: fileId,
    }),
  );

  updateProgress(fileId, 100);
}

async function sendChunk(file, fileId, chunkIndex) {
  const start = chunkIndex * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  const chunkBlob = file.slice(start, end);

  const buffer = await chunkBlob.arrayBuffer();
  const encrypted = await encryptChunk(buffer);

  ws.send(
    JSON.stringify({
      type: "chunk",
      code: sessionCode,
      index: chunkIndex,
      content: encrypted,
      fileId: fileId,
    }),
  );

  // Micro-task delay to keep UI responsive
  await new Promise((r) => setTimeout(r, 5));
}

function updateProgress(fileId, percentage) {
  const el = document.getElementById(`progress_${fileId}`);
  if (el) {
    el.querySelector(".progress-fill").style.width = `${percentage}%`;
    el.querySelector(".progress-percentage").textContent =
      `${Math.round(percentage)}%`;
  }
}

// --- Encryption/Decryption ---

async function encryptChunk(buffer) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ENCRYPTION_KEY.padEnd(16, "0").slice(0, 16)),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    buffer,
  );

  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return arrayBufferToBase64(result);
}

async function decryptChunk(base64) {
  const bytes = base64ToArrayBuffer(base64);
  const iv = bytes.slice(0, 16);
  const data = bytes.slice(16);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ENCRYPTION_KEY.padEnd(16, "0").slice(0, 16)),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  return await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data);
}

// --- Receiver Logic ---

function handleMetadata(data) {
  fileStates.set(data.fileId, {
    name: data.name,
    size: data.size,
    totalChunks: data.totalChunks,
    chunks: new Array(data.totalChunks), // Pre-allocate
    receivedCount: 0,
  });

  const progressItem = document.createElement("div");
  progressItem.className = "progress-item";
  progressItem.id = `progress_${data.fileId}`;
  progressItem.innerHTML = `
    <div class="progress-header">
      <span class="progress-title">${data.name} (${data.fileIndex + 1}/${data.totalFiles})</span>
      <span class="progress-percentage">0%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width: 0%"></div></div>
  `;
  const container = document.getElementById("progressContainer");
  if (container) container.appendChild(progressItem);
}

function handleChunk(data) {
  const fileState = fileStates.get(data.fileId);
  if (!fileState) return;

  // FIX: data.index might be 0, which is falsy, but Valid.
  // The undefined check is safer.
  if (data.index === undefined || data.index === null) {
    console.warn("Received chunk with missing index", data);
    return;
  }

  fileState.chunks[data.index] = data.content;
  fileState.receivedCount++;

  const progress = (fileState.receivedCount / fileState.totalChunks) * 100;
  updateProgress(data.fileId, progress);
}

async function handleFileDone(data) {
  const fileState = fileStates.get(data.fileId);
  if (!fileState) {
    console.error("Received DONE for unknown file", data.fileId);
    return;
  }

  log(`Processing ${data.name}...`);
  updateProgress(data.fileId, 100);

  try {
    const decryptedChunks = [];
    for (let i = 0; i < fileState.chunks.length; i++) {
      if (!fileState.chunks[i]) {
        throw new Error(`Missing chunk ${i} for ${data.name}`);
      }
      decryptedChunks.push(await decryptChunk(fileState.chunks[i]));
    }

    const blob = new Blob(decryptedChunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`Downloaded: ${data.name}`, "success");
    fileStates.delete(data.fileId); // Cleanup memory
  } catch (error) {
    log(`Error: ${error.message}`, "error");
    alert(`Failed to save ${data.name}: ${error.message}`);
  }
}

function handleAllDone() {
  log("All files received successfully", "success");
  showNotification("All files received!", "success");
}

// --- Utils ---

function handleCodeReceived(data) {
  sessionCode = data.code;
  const joinEl = document.getElementById("joinCode");
  const qrEl = document.getElementById("qrcode");
  if (joinEl) joinEl.textContent = sessionCode;
  if (qrEl) QRCode.toCanvas(qrEl, sessionCode, { width: 200 });

  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn && selectedFiles.length > 0) sendBtn.disabled = false;
  log(`Session created: ${sessionCode}`, "success");
}

function handleSenderConnectedToReceiver() {
  log("Sender connected!", "success");
  const badge = document.querySelector(".qr-container .status-badge");
  if (badge) {
    badge.className = "status-badge success";
    badge.innerHTML = "<span>✓</span><span>Sender connected</span>";
  }
}

function handleError(data) {
  log(data.error || "Error", "error");
  alert(data.error);
}

function switchTab(name, btn) {
  currentTab = name;
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document
    .querySelectorAll(".tab-content")
    .forEach((c) => c.classList.remove("active"));
  document.getElementById(`${name}Tab`).classList.add("active");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
}

// --- Text Messaging ---
// (Kept largely the same, just ensuring encryption helpers are used correctly)
function updateCharCount() {
  const input = document.getElementById("textInput");
  const countDisplay = document.getElementById("charCount");
  const sendBtn = document.getElementById("sendTextBtn");
  if (input && countDisplay) {
    countDisplay.textContent = `${input.value.length.toLocaleString()} / 100,000`;
    if (sendBtn) sendBtn.disabled = !sessionCode || input.value.length === 0;
  }
}

async function pasteText() {
  try {
    const text = await navigator.clipboard.readText();
    const input = document.getElementById("textInput");
    if (input) {
      input.value = text;
      updateCharCount();
    }
  } catch (e) {
    showNotification("Clipboard access denied", "error");
  }
}

async function sendTextMessage() {
  const text = document.getElementById("textInput").value.trim();
  if (!text || !sessionCode) return;
  try {
    const encrypted = await encryptText(text); // Uses AES-GCM
    const msgId = `msg_${Date.now()}`;
    ws.send(
      JSON.stringify({
        type: "text_message",
        code: sessionCode,
        text: encrypted,
        messageId: msgId,
      }),
    );
    messages.push({ id: msgId, text: text, timestamp: Date.now(), sent: true });
    updateMessagesDisplay();
    document.getElementById("textInput").value = "";
    updateCharCount();
  } catch (e) {
    log("Send error", "error");
  }
}

async function handleTextMessage(data) {
  try {
    const text = await decryptText(data.text);
    messages.push({
      id: data.messageId,
      text: text,
      timestamp: data.timestamp * 1000,
      sent: false,
    });
    updateMessagesDisplay();
    showNotification("New message received", "success");
  } catch (e) {
    log("Decrypt error", "error");
  }
}

function handleTextAck(data) {
  log(`Message delivered to ${data.receivers} devices`, "success");
}

function updateMessagesDisplay() {
  const display = document.getElementById("messagesDisplay");
  if (!display) return;
  if (messages.length === 0) {
    display.innerHTML = '<div class="empty-messages">No messages yet</div>';
    return;
  }
  display.innerHTML = messages
    .map(
      (msg) => `
        <div class="message-item ${msg.sent ? "sent" : ""}">
            <div class="message-header">
                <span class="message-type">${msg.sent ? "Sent" : "Received"}</span>
                <span class="message-time">${new Date(msg.timestamp).toLocaleString()}</span>
            </div>
            <div class="message-content">${escapeHtml(msg.text)}</div>
        </div>`,
    )
    .reverse()
    .join("");
}

// AES-GCM for text
async function encryptText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ENCRYPTION_KEY.padEnd(16, "0").slice(0, 16)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return arrayBufferToBase64(result);
}

async function decryptText(base64) {
  const bytes = base64ToArrayBuffer(base64);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ENCRYPTION_KEY.padEnd(16, "0").slice(0, 16)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  return new TextDecoder().decode(decrypted);
}

function showNotification(msg, type = "success") {
  const n = document.createElement("div");
  n.className = `notification ${type}`;
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3000);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

window.onload = async () => {
  // --- ADD THIS BLOCK ---
  if (!window.crypto || !window.crypto.subtle) {
    const errorMsg =
      "⚠️ Critical Error: Web Crypto API is missing.\n\n" +
      "Browsers require HTTPS to use encryption features.\n" +
      "If you are on a local network, please use localhost or set up HTTPS (e.g., via ngrok).";

    alert(errorMsg);
    document.body.innerHTML = `<div style="padding:2rem; color:white; text-align:center;">${errorMsg.replace(/\n/g, "<br>")}</div>`;
    return;
  }
  // ---------------------

  const res = await fetch("/config");
  const cfg = await res.json();
  ENCRYPTION_KEY = cfg.key;

  await connectWebSocket();
};

function scanQR() {
  const qr = new Html5Qrcode("qr-reader");
  qr.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (txt) => {
    document.getElementById("codeInput").value = txt;
    qr.stop();
    joinSession();
  });
}

function joinSession() {
  const code = document.getElementById("codeInput").value.trim();
  if (code.length === 6) {
    sessionCode = code;
    ws.send(JSON.stringify({ type: "join", code }));
  } else {
    alert("Invalid code");
  }
}
