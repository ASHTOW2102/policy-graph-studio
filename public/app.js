const adminTab = document.getElementById("adminTab");
const userTab = document.getElementById("userTab");
const adminScreen = document.getElementById("adminScreen");
const userScreen = document.getElementById("userScreen");
const adminForm = document.getElementById("adminForm");
const fileInput = document.getElementById("fileInput");
const folderInput = document.getElementById("folderInput");
const pathTargets = document.getElementById("pathTargets");
const buildButton = document.getElementById("buildButton");
const refreshKbButton = document.getElementById("refreshKbButton");
const clearKbButton = document.getElementById("clearKbButton");
const kbStats = document.getElementById("kbStats");
const kbMeta = document.getElementById("kbMeta");
const documentList = document.getElementById("documentList");
const ingestLog = document.getElementById("ingestLog");
const queryForm = document.getElementById("queryForm");
const questionInput = document.getElementById("question");
const responseLanguage = document.getElementById("responseLanguage");
const askButton = document.getElementById("askButton");
const recordButton = document.getElementById("recordButton");
const stopButton = document.getElementById("stopButton");
const audioUploadInput = document.getElementById("audioUploadInput");
const sttModel = document.getElementById("sttModel");
const sttMode = document.getElementById("sttMode");
const sttLanguage = document.getElementById("sttLanguage");
const recordingBadge = document.getElementById("recordingBadge");
const recordedAudio = document.getElementById("recordedAudio");
const transcriptBox = document.getElementById("transcriptBox");
const finalAnswer = document.getElementById("finalAnswer");
const speakButton = document.getElementById("speakButton");
const ttsSpeaker = document.getElementById("ttsSpeaker");
const ttsLanguage = document.getElementById("ttsLanguage");
const ttsPace = document.getElementById("ttsPace");
const ttsAudio = document.getElementById("ttsAudio");
const ttsStatus = document.getElementById("ttsStatus");
const contextList = document.getElementById("contextList");
const agentList = document.getElementById("agentList");
const itemCardTemplate = document.getElementById("itemCardTemplate");

let mediaRecorder = null;
let recordedBlob = null;
let recordedMimeType = "audio/webm";
let recordedAudioUrl = "";
let ttsAudioUrl = "";
let lastTtsRequestKey = "";
let uploadedAudioFile = null;

function getSupportedRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }

  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/wav",
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function isLiveRecordingSupported() {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined",
  );
}

function setActiveScreen(target) {
  const adminActive = target === "admin";
  adminTab.classList.toggle("active", adminActive);
  userTab.classList.toggle("active", !adminActive);
  adminScreen.classList.toggle("active", adminActive);
  userScreen.classList.toggle("active", !adminActive);
}

adminTab.addEventListener("click", () => setActiveScreen("admin"));
userTab.addEventListener("click", () => setActiveScreen("user"));

function setMonoBox(element, text, isPlaceholder = false) {
  element.textContent = text;
  element.classList.toggle("placeholder", isPlaceholder);
}

function setRecordingState(isRecording, label) {
  recordingBadge.textContent = label;
  recordingBadge.classList.toggle("live", isRecording);
  recordButton.disabled = isRecording;
  stopButton.disabled = !isRecording;
}

function renderStats(stats) {
  kbStats.innerHTML = "";
  const items = [
    { label: "Documents", value: stats.documentCount || 0 },
    { label: "Chunks", value: stats.chunkCount || 0 },
    { label: "Avg Terms", value: stats.averageChunkLength || 0 },
  ];
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "metric";
    card.innerHTML = `<p class="metric-label">${item.label}</p><p class="metric-value">${item.value}</p>`;
    kbStats.appendChild(card);
  }
}

function createItemCard(title, meta, body) {
  const fragment = itemCardTemplate.content.cloneNode(true);
  fragment.querySelector(".item-title").textContent = title;
  fragment.querySelector(".item-meta").textContent = meta || "";
  fragment.querySelector(".item-body").textContent = body;
  return fragment;
}

function renderDocuments(documents) {
  documentList.innerHTML = "";
  if (!documents.length) {
    documentList.classList.add("empty-state");
    documentList.textContent = "No documents loaded yet.";
    return;
  }
  documentList.classList.remove("empty-state");
  for (const doc of documents) {
    const body = [
      `${doc.relativePath || doc.name}`,
      `${doc.chunkCount || 0} chunks`,
      `${(doc.keywordPreview || []).slice(0, 6).join(", ") || "No keywords"}`,
    ].join("\n");
    documentList.appendChild(createItemCard(doc.name, doc.id, body));
  }
}

function renderContext(contextItems) {
  contextList.innerHTML = "";
  if (!contextItems.length) {
    contextList.classList.add("empty-state");
    contextList.textContent = "No context yet.";
    return;
  }
  contextList.classList.remove("empty-state");
  for (const item of contextItems) {
    const meta = `${item.documentName || "Unknown document"} | score ${item.score}`;
    const body = [`${item.id}`, `${item.sectionHeading || item.type}`, "", item.text].join("\n");
    contextList.appendChild(createItemCard(item.type, meta, body));
  }
}

function renderAgents(agents) {
  agentList.innerHTML = "";
  if (!agents.length) {
    agentList.classList.add("empty-state");
    agentList.textContent = "No agent output yet.";
    return;
  }
  agentList.classList.remove("empty-state");
  for (const agent of agents) {
    agentList.appendChild(createItemCard(agent.name, agent.model || "", agent.content || ""));
  }
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function transcribeSelectedAudio() {
  const sourceBlob = uploadedAudioFile || recordedBlob;
  if (!sourceBlob) {
    return null;
  }

  setMonoBox(transcriptBox, "Transcribing audio...", true);

  const audioBase64 = await blobToBase64(sourceBlob);
  const response = await fetch("/api/speech-to-text", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audioBase64,
      mimeType: sourceBlob.type || recordedMimeType,
      fileName: uploadedAudioFile?.name || "voice-question.webm",
      model: sttModel.value,
      mode: sttMode.value,
      languageCode: sttLanguage.value,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Speech transcription failed.");
  }

  const transcript = data.transcript || "";
  questionInput.value = transcript;
  setMonoBox(
    transcriptBox,
    `${transcript || "No transcript returned."}\n\nLanguage: ${data.languageCode || "unknown"}`,
  );
  return transcript;
}

function resetRecordedAudio() {
  if (recordedAudioUrl) {
    URL.revokeObjectURL(recordedAudioUrl);
    recordedAudioUrl = "";
  }
  recordedBlob = null;
  uploadedAudioFile = null;
  recordedAudio.removeAttribute("src");
  recordedAudio.classList.add("hidden");
  setMonoBox(transcriptBox, "Transcript will appear here.", true);
}

function setSelectedAudio(fileOrBlob, fileName, mimeType) {
  if (recordedAudioUrl) {
    URL.revokeObjectURL(recordedAudioUrl);
  }
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob], { type: mimeType });
  recordedAudioUrl = URL.createObjectURL(blob);
  recordedAudio.src = recordedAudioUrl;
  recordedAudio.classList.remove("hidden");
  setMonoBox(
    transcriptBox,
    `Audio ready: ${fileName || "audio file"}${mimeType ? `\nType: ${mimeType}` : ""}`,
    true,
  );
}

function setTtsAudio(base64, contentType) {
  ttsAudio.pause();
  ttsAudio.currentTime = 0;
  ttsAudio.muted = false;
  ttsAudio.volume = 1;
  ttsAudio.controls = true;
  ttsAudio.setAttribute("playsinline", "true");
  ttsAudio.removeAttribute("src");
  if (ttsAudioUrl) {
    URL.revokeObjectURL(ttsAudioUrl);
    ttsAudioUrl = "";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const blob = new Blob([bytes], { type: contentType || "audio/wav" });
  ttsAudioUrl = URL.createObjectURL(blob);
  ttsAudio.src = ttsAudioUrl;
  ttsAudio.load();
  ttsAudio.classList.remove("hidden");
  ttsAudio.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetTtsAudioState() {
  ttsAudio.pause();
  ttsAudio.currentTime = 0;
  ttsAudio.removeAttribute("src");
  if (ttsAudioUrl) {
    URL.revokeObjectURL(ttsAudioUrl);
    ttsAudioUrl = "";
  }
  lastTtsRequestKey = "";
  ttsAudio.classList.add("hidden");
}

async function collectUploadSources() {
  const files = [...fileInput.files, ...folderInput.files];
  const sources = [];
  for (const file of files) {
    sources.push({
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      contentBase64: await fileToBase64(file),
    });
  }
  return sources;
}

async function refreshKnowledgeBase() {
  try {
    const response = await fetch("/api/knowledge-base");
    const data = await response.json();
    renderStats(data.stats || {});
    renderDocuments(data.documents || []);
    setMonoBox(
      kbMeta,
      data.exists
        ? `Updated ${new Date(data.updatedAt || Date.now()).toLocaleString()}\n${(data.documents || []).length} documents ready`
        : "No knowledge base built yet.",
      !data.exists,
    );
  } catch (error) {
    setMonoBox(kbMeta, error.message || "Failed to load knowledge base.", true);
  }
}

async function refreshHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    renderStats(data.knowledgeBase?.stats || {});
    if (data.knowledgeBase) {
      renderDocuments(data.knowledgeBase.documents || []);
      setMonoBox(
        kbMeta,
        data.knowledgeBase.exists
          ? `Updated ${new Date(data.knowledgeBase.updatedAt || Date.now()).toLocaleString()}\n${(data.knowledgeBase.documents || []).length} documents ready`
          : "No knowledge base built yet.",
        !data.knowledgeBase.exists,
      );
    }
  } catch {
    setMonoBox(kbMeta, "Unable to load the knowledge base.", true);
  }
}

recordButton.addEventListener("click", async () => {
  try {
    if (!isLiveRecordingSupported()) {
      throw new Error("Live recording is not supported on this browser. Use audio upload instead.");
    }

    uploadedAudioFile = null;
    audioUploadInput.value = "";
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl);
      recordedAudioUrl = "";
    }
    recordedBlob = null;
    recordedAudio.removeAttribute("src");
    recordedAudio.classList.add("hidden");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferredMimeType = getSupportedRecordingMimeType();
    recordedMimeType = preferredMimeType || "audio/webm";
    const chunks = [];
    mediaRecorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType })
      : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || recordedMimeType || "audio/webm";
      recordedBlob = new Blob(chunks, { type: mimeType });
      recordedMimeType = mimeType;
      setSelectedAudio(recordedBlob, "recorded audio", mimeType);
      stream.getTracks().forEach((track) => track.stop());
      setRecordingState(false, "Recorded");
    };
    mediaRecorder.start();
    setRecordingState(true, "Recording");
    setMonoBox(transcriptBox, "Recording in progress...", true);
  } catch (error) {
    setRecordingState(false, "Unavailable");
    setMonoBox(transcriptBox, error.message || "Unable to start microphone recording.", true);
  }
});

stopButton.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
});

audioUploadInput.addEventListener("change", () => {
  const file = audioUploadInput.files?.[0] || null;
  uploadedAudioFile = file;
  recordedBlob = null;
  if (!file) {
    resetRecordedAudio();
    return;
  }
  setRecordingState(false, "Uploaded");
  setSelectedAudio(file, file.name, file.type || "audio/*");
});

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  buildButton.disabled = true;
  buildButton.textContent = "Building...";
  setMonoBox(ingestLog, "Building local RAG index...", true);

  try {
    const sources = await collectUploadSources();
    const rawPathTargets = pathTargets.value
      .split(/\r?\n/g)
      .map((item) => item.trim())
      .filter(Boolean);

    const response = await fetch("/api/admin/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sources,
        pathTargets: rawPathTargets,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ingestion failed.");
    }

    const logLines = [];
    logLines.push("Build complete.");
    logLines.push(`${(data.ingestedDocuments || []).length} documents ingested`);
    if (data.warnings?.length) {
      logLines.push("");
      logLines.push("Warnings:");
      for (const warning of data.warnings) {
        logLines.push(`- ${warning}`);
      }
    }

    setMonoBox(ingestLog, logLines.join("\n"));
    await refreshKnowledgeBase();
    setActiveScreen("user");
  } catch (error) {
    setMonoBox(ingestLog, error.message || "Ingestion failed.", true);
  } finally {
    buildButton.disabled = false;
    buildButton.textContent = "Build RAG Index";
  }
});

refreshKbButton.addEventListener("click", refreshKnowledgeBase);

clearKbButton.addEventListener("click", async () => {
  clearKbButton.disabled = true;
  clearKbButton.textContent = "Clearing...";
  try {
    const response = await fetch("/api/admin/clear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Clear failed.");
    }

    setMonoBox(ingestLog, "Knowledge base cleared.");
    renderDocuments([]);
    renderStats(data.knowledgeBase?.stats || {});
    setMonoBox(kbMeta, "No knowledge base built yet.", true);
    setActiveScreen("admin");
  } catch (error) {
    setMonoBox(ingestLog, error.message || "Clear failed.", true);
  } finally {
    clearKbButton.disabled = false;
    clearKbButton.textContent = "Clear KB";
  }
});

queryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const hasAudio = Boolean(uploadedAudioFile || recordedBlob);
  const typedQuestion = questionInput.value.trim();
  if (!typedQuestion && !hasAudio) {
    setMonoBox(finalAnswer, "Enter a question or provide audio first.", true);
    return;
  }

  askButton.disabled = true;
  askButton.textContent = "Querying...";
  setMonoBox(finalAnswer, "Generating answer...", true);
  renderContext([]);
  renderAgents([]);

  try {
    let question = typedQuestion;
    if (hasAudio) {
      question = await transcribeSelectedAudio();
    }

    if (!question || !question.trim()) {
      throw new Error("No question was available after audio processing.");
    }

    const response = await fetch("/api/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question,
        responseLanguage: responseLanguage.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Query failed.");
    }

    setMonoBox(finalAnswer, data.finalAnswer || "No answer returned.");
    renderContext(data.contextItems || []);
    renderAgents(data.agents || []);
    if (data.warning) {
      setMonoBox(ttsStatus, data.warning, true);
    }
  } catch (error) {
    if (hasAudio) {
      setMonoBox(transcriptBox, error.message || "Speech transcription failed.", true);
    }
    setMonoBox(finalAnswer, error.message || "Query failed.", true);
  } finally {
    askButton.disabled = false;
    askButton.textContent = "Query Database";
  }
});

speakButton.addEventListener("click", async () => {
  const answerText = finalAnswer.textContent.trim();
  if (!answerText || finalAnswer.classList.contains("placeholder")) {
    setMonoBox(ttsStatus, "Run a query first so there is an answer to synthesize.", true);
    return;
  }
  const currentTtsRequestKey = JSON.stringify({
    text: answerText,
    speaker: ttsSpeaker.value,
    language: ttsLanguage.value,
    pace: Number(ttsPace.value || 1),
  });

  speakButton.disabled = true;
  speakButton.textContent = "Speaking...";
  setMonoBox(ttsStatus, "Generating speech with Sarvam text to speech...", true);

  try {
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
    if (
      ttsAudioUrl &&
      ttsAudio.src &&
      !ttsAudio.classList.contains("hidden") &&
      lastTtsRequestKey === currentTtsRequestKey
    ) {
      ttsAudio.muted = false;
      ttsAudio.volume = 1;
      ttsAudio.currentTime = 0;
      try {
        await ttsAudio.play();
        setMonoBox(ttsStatus, "Playing current audio clip.");
        return;
      } catch {
        setMonoBox(ttsStatus, "Tap play on the audio bar below to start the current clip.", true);
      }
    }

    const response = await fetch("/api/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: answerText,
        targetLanguageCode: ttsLanguage.value,
        speaker: ttsSpeaker.value,
        pace: Number(ttsPace.value || 1),
        outputAudioCodec: "wav",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Speech synthesis failed.");
    }

    setTtsAudio(data.audioBase64, data.contentType);
    lastTtsRequestKey = currentTtsRequestKey;
    try {
      await ttsAudio.play();
      setMonoBox(ttsStatus, `Playing now. Voice: ${data.speaker} | Language: ${data.targetLanguageCode}`);
    } catch {
      setMonoBox(
        ttsStatus,
        `Audio ready. Voice: ${data.speaker} | Language: ${data.targetLanguageCode}\nTap the visible play button on the audio bar below.`,
      );
    }
  } catch (error) {
    setMonoBox(ttsStatus, error.message || "Speech synthesis failed.", true);
  } finally {
    speakButton.disabled = false;
    speakButton.textContent = "Speak Answer";
  }
});

renderContext([]);
renderAgents([]);
setRecordingState(false, "Idle");
ttsAudio.addEventListener("play", () => {
  ttsAudio.muted = false;
  ttsAudio.volume = 1;
});
ttsSpeaker.addEventListener("change", resetTtsAudioState);
ttsLanguage.addEventListener("change", resetTtsAudioState);
ttsPace.addEventListener("input", resetTtsAudioState);
if (!isLiveRecordingSupported()) {
  recordButton.disabled = true;
  stopButton.disabled = true;
  setRecordingState(false, "Upload on phone");
  setMonoBox(
    transcriptBox,
    "Live recording is not supported on this browser. Use Upload Audio to record from your phone and then tap Query Database.",
    true,
  );
}
refreshHealth();
refreshKnowledgeBase();
