const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STORAGE_DIR = path.join(DATA_DIR, "storage");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const GRAPH_PATH = path.join(DATA_DIR, "knowledge-graph.json");
const SARVAM_API_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".html",
  ".htm",
  ".xml",
  ".pdf",
  ".docx",
  ".zip",
]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".html", ".htm", ".xml"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "if", "in",
  "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "there", "this", "to",
  "was", "were", "will", "with", "within", "must", "may", "can", "should", "would", "your",
  "you", "our", "any", "all", "not", "than", "then", "such", "each", "per", "via", "after",
  "before", "about", "over", "under", "between", "policy", "document", "documents",
]);
const QUERY_AGENTS = [
  {
    id: "policy_analyst",
    name: "Policy Analyst",
    model: "sarvam-m",
    temperature: 0.2,
    maxTokens: 900,
    systemPrompt:
      "You answer strictly from the provided policy context. If context is missing, say so clearly. Use precise and practical language. Respect the requested response language.",
    buildPrompt: ({ question, contextBlock, responseLanguage }) =>
      [
        `User question: ${question}`,
        `Response language: ${responseLanguage}`,
        "",
        "Policy context:",
        contextBlock,
        "",
        "Return:",
        "1. Direct answer",
        "2. Relevant policy points",
        "3. Any conditions or exceptions",
        "4. Mention node ids when relevant",
      ].join("\n"),
  },
  {
    id: "compliance_reviewer",
    name: "Compliance Reviewer",
    model: "sarvam-m",
    temperature: 0.1,
    maxTokens: 900,
    systemPrompt:
      "You review the draft answer for policy risk, ambiguity, missing caveats, and unsupported claims. Stay grounded in the supplied context. Write in the requested response language.",
    buildPrompt: ({ question, contextBlock, analystDraft, responseLanguage }) =>
      [
        `User question: ${question}`,
        `Response language: ${responseLanguage}`,
        "",
        "Policy context:",
        contextBlock,
        "",
        "Analyst draft:",
        analystDraft,
        "",
        "Return bullet points covering:",
        "1. Missing caveats",
        "2. Compliance risks",
        "3. Unsupported claims to remove",
        "4. Necessary corrections",
      ].join("\n"),
  },
  {
    id: "response_writer",
    name: "Response Writer",
    model: "sarvam-m",
    temperature: 0.3,
    maxTokens: 1200,
    systemPrompt:
      "You produce the final user-facing answer. Be clear, concise, and policy-grounded. Cite the supporting document names and node ids inline when useful. Write only in the requested response language.",
    buildPrompt: ({ question, contextBlock, analystDraft, reviewDraft, responseLanguage }) =>
      [
        `User question: ${question}`,
        `Response language: ${responseLanguage}`,
        "",
        "Policy context:",
        contextBlock,
        "",
        "Analyst draft:",
        analystDraft,
        "",
        "Reviewer notes:",
        reviewDraft,
        "",
        "Write the final answer only. Include a short 'Based on' line at the end with supporting documents and node ids.",
      ].join("\n"),
  },
];
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const AUDIO_CONTENT_TYPES = {
  aac: "audio/aac",
  alaw: "audio/basic",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  mulaw: "audio/basic",
  opus: "audio/ogg",
  pcm: "audio/wav",
  wav: "audio/wav",
};

ensureDir(DATA_DIR);
ensureDir(STORAGE_DIR);
ensureDir(TMP_DIR);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clearDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function safeJoinPublic(requestPath) {
  const normalized = path
    .normalize(requestPath)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(PUBLIC_DIR, normalized);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeResponseLanguage(value) {
  const language = normalizeWhitespace(value || "");
  return language || "Same as the user question";
}

function stripThinkBlocks(text) {
  return normalizeWhitespace(String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, " "));
}

function stripMarkup(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
  );
}

function tokenize(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token && token.length > 2 && !STOP_WORDS.has(token));
}

function collectKeywordScores(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([value, score]) => ({ value, score }));
}

function splitIntoSections(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }
  const rawSections = normalized
    .split(/\n(?=#{1,6}\s)|\n\n+/g)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  return rawSections.map((content, index) => {
    const firstLine = content.split("\n")[0] || "";
    const heading = firstLine.startsWith("#")
      ? firstLine.replace(/^#+\s*/, "").trim()
      : `Section ${index + 1}`;
    return {
      id: `sec_${index + 1}`,
      heading,
      text: content,
    };
  });
}

function splitIntoStatements(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/g)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 30)
    .slice(0, 20);
}

function extensionFor(filePath) {
  return path.extname(filePath).toLowerCase();
}

function isSupportedFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(extensionFor(filePath));
}

function decodeTextFile(filePath) {
  const ext = extensionFor(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  if (ext === ".html" || ext === ".htm" || ext === ".xml") {
    return stripMarkup(raw);
  }
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeWhitespace(JSON.stringify(parsed, null, 2));
    } catch {
      return normalizeWhitespace(raw);
    }
  }
  return normalizeWhitespace(raw);
}

function expandArchive(zipPath) {
  const extractDir = path.join(TMP_DIR, uniqueId("zip"));
  ensureDir(extractDir);
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      zipPath,
      extractDir,
    ],
    { stdio: "pipe" },
  );
  return extractDir;
}

function extractDocxText(filePath) {
  const extractDir = expandArchive(filePath);
  const xmlPath = path.join(extractDir, "word", "document.xml");
  if (!fs.existsSync(xmlPath)) {
    return "";
  }
  const xml = fs.readFileSync(xmlPath, "utf8");
  return normalizeWhitespace(
    xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:tab\/>/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodePdfString(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }

    index += 1;
    if (index >= value.length) {
      break;
    }

    const escaped = value[index];
    if (escaped === "n") {
      result += "\n";
    } else if (escaped === "r") {
      result += "\r";
    } else if (escaped === "t") {
      result += "\t";
    } else if (escaped === "b") {
      result += "\b";
    } else if (escaped === "f") {
      result += "\f";
    } else if (escaped === "(" || escaped === ")" || escaped === "\\") {
      result += escaped;
    } else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (index + 1 < value.length && octal.length < 3 && /[0-7]/.test(value[index + 1])) {
        index += 1;
        octal += value[index];
      }
      result += String.fromCharCode(parseInt(octal, 8));
    } else {
      result += escaped;
    }
  }
  return result;
}

function extractPdfText(filePath) {
  const rawBuffer = fs.readFileSync(filePath);
  const raw = rawBuffer.toString("latin1");
  const extractedParts = [];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match;

  while ((match = streamPattern.exec(raw))) {
    let streamBuffer = Buffer.from(match[1], "latin1");
    if (streamBuffer.length >= 2 && streamBuffer[0] === 0x0d && streamBuffer[1] === 0x0a) {
      streamBuffer = streamBuffer.subarray(2);
    } else if (streamBuffer.length >= 1 && (streamBuffer[0] === 0x0d || streamBuffer[0] === 0x0a)) {
      streamBuffer = streamBuffer.subarray(1);
    }

    let decoded = streamBuffer;
    try {
      decoded = zlib.inflateSync(streamBuffer);
    } catch {
      decoded = streamBuffer;
    }

    const streamText = decoded.toString("latin1");
    const literalPattern = /\((?:\\.|[^\\()])*\)\s*Tj/g;
    const linePattern = /\[(.*?)\]\s*TJ/gs;
    const chunkLines = [];

    for (const literalMatch of streamText.matchAll(literalPattern)) {
      const literal = literalMatch[0];
      chunkLines.push(decodePdfString(literal.slice(1, literal.lastIndexOf(")"))));
    }

    for (const lineMatch of streamText.matchAll(linePattern)) {
      const nestedLiterals = lineMatch[1].match(/\((?:\\.|[^\\()])*\)/g) || [];
      const line = nestedLiterals
        .map((item) => decodePdfString(item.slice(1, -1)))
        .join("");
      if (line) {
        chunkLines.push(line);
      }
    }

    if (chunkLines.length) {
      extractedParts.push(chunkLines.join("\n"));
    }
  }

  if (!extractedParts.length) {
    const fallback = raw.match(/\((?:\\.|[^\\()]){8,}\)/g) || [];
    for (const item of fallback) {
      extractedParts.push(decodePdfString(item.slice(1, -1)));
    }
  }

  return cleanExtractedPdfText(extractedParts.join("\n"));
}

function cleanExtractedPdfText(text) {
  const cleanedLines = [];
  for (const rawLine of String(text || "").split(/\r?\n/g)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) {
      continue;
    }

    const letters = (line.match(/\p{L}/gu) || []).length;
    const digits = (line.match(/\p{N}/gu) || []).length;
    const visible = (line.match(/[^\s]/g) || []).length;
    const symbols = Math.max(0, visible - letters - digits);
    const alphaNumeric = letters + digits;

    if (visible < 3) {
      continue;
    }
    if (letters === 0 && digits < 6) {
      continue;
    }
    if (alphaNumeric < Math.ceil(visible * 0.35)) {
      continue;
    }
    if (symbols > letters + digits && visible > 10) {
      continue;
    }
    if (/^[\/\\|`'"“”‘’.,;:!@#$%^&*()_+=<>\-\[\]{}~]+$/u.test(line)) {
      continue;
    }

    cleanedLines.push(line);
  }

  return normalizeWhitespace(cleanedLines.join("\n"));
}

function listFilesRecursive(targetPath) {
  const results = [];
  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    results.push(targetPath);
    return results;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function persistUploadedFile(source) {
  const safeName = source.relativePath || source.name || uniqueId("upload");
  const targetPath = path.join(STORAGE_DIR, `${Date.now()}_${safeName.replace(/[<>:"|?*]/g, "_")}`);
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, Buffer.from(source.contentBase64, "base64"));
  return targetPath;
}

function readSourceFile(filePath, sourceLabel) {
  const ext = extensionFor(filePath);
  const documents = [];

  if (ext === ".zip") {
    const extractedPath = expandArchive(filePath);
    for (const childPath of listFilesRecursive(extractedPath)) {
      if (!isSupportedFile(childPath) || extensionFor(childPath) === ".zip") {
        continue;
      }
      documents.push(...readSourceFile(childPath, sourceLabel || filePath));
    }
    return documents;
  }

  let text = "";
  if (TEXT_EXTENSIONS.has(ext)) {
    text = decodeTextFile(filePath);
  } else if (ext === ".pdf") {
    text = extractPdfText(filePath);
  } else if (ext === ".docx") {
    text = extractDocxText(filePath);
  }

  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const relativePath = sourceLabel
    ? path.relative(sourceLabel, filePath)
    : path.basename(filePath);

  documents.push({
    id: uniqueId("doc"),
    name: path.basename(filePath),
    sourcePath: filePath,
    relativePath: relativePath && !relativePath.startsWith("..") ? relativePath : path.basename(filePath),
    extension: ext,
    text: normalized,
  });
  return documents;
}

function loadDocumentsFromPaths(pathTargets) {
  const docs = [];
  const warnings = [];
  for (const rawTarget of pathTargets || []) {
    const target = String(rawTarget || "").trim();
    if (!target) {
      continue;
    }
    if (!fs.existsSync(target)) {
      warnings.push(`Path not found: ${target}`);
      continue;
    }
    const stats = fs.statSync(target);
    if (stats.isFile()) {
      if (!isSupportedFile(target)) {
        warnings.push(`Unsupported file skipped: ${target}`);
        continue;
      }
      docs.push(...readSourceFile(target, path.dirname(target)));
      continue;
    }
    for (const childPath of listFilesRecursive(target)) {
      if (!isSupportedFile(childPath)) {
        continue;
      }
      docs.push(...readSourceFile(childPath, target));
    }
  }
  return { docs, warnings };
}

function loadDocumentsFromUploads(sources) {
  const docs = [];
  const warnings = [];
  for (const source of sources || []) {
    const name = String(source.name || source.relativePath || "").trim();
    if (!name || !source.contentBase64) {
      warnings.push("Skipped an empty upload source.");
      continue;
    }
    const tempPath = persistUploadedFile(source);
    const ext = extensionFor(tempPath);
    if (!isSupportedFile(tempPath)) {
      warnings.push(`Unsupported upload skipped: ${name}`);
      continue;
    }
    const sourceRoot = path.dirname(tempPath);
    docs.push(...readSourceFile(tempPath, sourceRoot));
  }
  return { docs, warnings };
}

function createGraph(documents) {
  const nodes = [];
  const edges = [];
  const documentSummaries = [];

  for (const document of documents) {
    const documentNodeId = `document:${document.id}`;
    const documentKeywords = collectKeywordScores(document.text);
    nodes.push({
      id: documentNodeId,
      type: "document",
      label: document.name,
      sourcePath: document.sourcePath,
      relativePath: document.relativePath,
      extension: document.extension,
      text: document.text.slice(0, 5000),
      keywords: documentKeywords,
    });

    const sections = splitIntoSections(document.text).slice(0, 24);
    const sectionSummaries = [];
    for (const section of sections) {
      const sectionNodeId = `section:${document.id}:${slugify(section.heading)}`;
      const sectionKeywords = collectKeywordScores(section.text);
      nodes.push({
        id: sectionNodeId,
        type: "section",
        label: section.heading,
        documentId: documentNodeId,
        documentName: document.name,
        text: section.text.slice(0, 4000),
        keywords: sectionKeywords,
      });
      edges.push({
        id: uniqueId("edge"),
        type: "contains",
        from: documentNodeId,
        to: sectionNodeId,
      });

      const statements = splitIntoStatements(section.text);
      const statementIds = [];
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        const statementNodeId = `statement:${document.id}:${slugify(section.heading)}:${index + 1}`;
        nodes.push({
          id: statementNodeId,
          type: "statement",
          label: `Statement ${index + 1}`,
          documentId: documentNodeId,
          documentName: document.name,
          sectionId: sectionNodeId,
          sectionHeading: section.heading,
          text: statement,
          keywords: collectKeywordScores(statement),
        });
        edges.push({
          id: uniqueId("edge"),
          type: "contains",
          from: sectionNodeId,
          to: statementNodeId,
        });
        statementIds.push(statementNodeId);
      }

      for (const keyword of sectionKeywords.slice(0, 8)) {
        const keywordNodeId = `keyword:${keyword.value}`;
        if (!nodes.find((node) => node.id === keywordNodeId)) {
          nodes.push({
            id: keywordNodeId,
            type: "keyword",
            label: keyword.value,
            text: keyword.value,
          });
        }
        edges.push({
          id: uniqueId("edge"),
          type: "mentions",
          from: sectionNodeId,
          to: keywordNodeId,
          weight: keyword.score,
        });
      }

      sectionSummaries.push({
        id: sectionNodeId,
        heading: section.heading,
        statementIds,
      });
    }

    documentSummaries.push({
      id: documentNodeId,
      name: document.name,
      relativePath: document.relativePath,
      extension: document.extension,
      keywordPreview: documentKeywords.map((item) => item.value),
      sectionCount: sections.length,
      sourcePath: document.sourcePath,
      sections: sectionSummaries,
    });
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: {
      documentCount: documentSummaries.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    documents: documentSummaries,
    nodes,
    edges,
  };
}

function saveGraph(graph) {
  graph.updatedAt = new Date().toISOString();
  graph.stats = {
    documentCount: graph.documents.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
}

function loadGraph() {
  if (!fs.existsSync(GRAPH_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
}

function clearKnowledgeBase() {
  if (fs.existsSync(GRAPH_PATH)) {
    fs.unlinkSync(GRAPH_PATH);
  }
  clearDirectory(STORAGE_DIR);
  clearDirectory(TMP_DIR);
  ensureDir(STORAGE_DIR);
  ensureDir(TMP_DIR);
}

function scoreNodeAgainstQuestion(node, questionTokens) {
  if (!node.text) {
    return 0;
  }
  const nodeTokens = tokenize(`${node.label || ""} ${node.text}`);
  if (!nodeTokens.length) {
    return 0;
  }
  const uniqueNodeTokens = new Set(nodeTokens);
  let score = 0;
  for (const token of questionTokens) {
    if (uniqueNodeTokens.has(token)) {
      score += 3;
    }
  }
  if (node.type === "statement") {
    score += 2;
  }
  if (node.type === "section") {
    score += 1;
  }
  return score;
}

function retrieveRelevantContext(graph, question, topK = 8) {
  const questionTokens = tokenize(question);
  const ranked = graph.nodes
    .filter((node) => node.type === "statement" || node.type === "section")
    .map((node) => ({ node, score: scoreNodeAgainstQuestion(node, questionTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, topK);

  const contextItems = ranked.map((entry) => ({
    id: entry.node.id,
    type: entry.node.type,
    score: entry.score,
    documentName: entry.node.documentName,
    sectionHeading: entry.node.sectionHeading || entry.node.label,
    text: entry.node.text,
  }));

  return {
    contextItems,
    contextBlock: contextItems
      .map(
        (item, index) =>
          `[${index + 1}] ${item.documentName || "Unknown document"} | ${item.id} | ${item.sectionHeading}\n${item.text}`,
      )
      .join("\n\n"),
  };
}

async function callSarvam(messages, options = {}) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SARVAM_API_KEY environment variable.");
  }

  const payload = {
    model: options.model || "sarvam-30b",
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens || 700,
  };

  if (options.reasoningEffort) {
    payload.reasoning_effort = options.reasoningEffort;
  }

  const response = await fetch(SARVAM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "api-subscription-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    throw new Error(`Sarvam API error (${response.status}): ${detail}`);
  }

  const message = body?.choices?.[0]?.message || {};
  const rawContent = message.content;
  const content =
    typeof rawContent === "string"
      ? rawContent.trim()
      : Array.isArray(rawContent)
        ? rawContent
            .map((item) => {
              if (typeof item === "string") {
                return item;
              }
              if (item && typeof item.text === "string") {
                return item.text;
              }
              return "";
            })
            .join("\n")
            .trim()
        : typeof message.reasoning_content === "string"
          ? message.reasoning_content.trim()
          : "";
  const cleanedContent = stripThinkBlocks(content);
  if (!cleanedContent) {
    throw new Error("Sarvam API returned an empty response.");
  }

  return {
    content: cleanedContent,
    model: body.model || payload.model,
    usage: body.usage || null,
  };
}

function getSarvamApiKey() {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SARVAM_API_KEY environment variable.");
  }
  return apiKey;
}

function buildSarvamHeaders(extra = {}) {
  const apiKey = getSarvamApiKey();
  return {
    "api-subscription-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

async function transcribeSpeech(input) {
  const fileName = input.fileName || "voice-input.webm";
  const mimeType = input.mimeType || "audio/webm";
  const model = input.model || "saaras:v3";
  const languageCode = input.languageCode || "unknown";
  const mode = input.mode || "transcribe";
  const audioBuffer = Buffer.from(input.audioBase64 || "", "base64");

  if (!audioBuffer.length) {
    throw new Error("Audio payload is empty.");
  }

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), fileName);
  form.append("model", model);
  if (model === "saaras:v3") {
    form.append("mode", mode);
  }
  if (languageCode) {
    form.append("language_code", languageCode);
  }

  const response = await fetch(SARVAM_STT_URL, {
    method: "POST",
    headers: buildSarvamHeaders(),
    body: form,
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Sarvam STT error (${response.status}): ${JSON.stringify(body)}`);
  }

  return {
    requestId: body.request_id || null,
    transcript: body.transcript || "",
    languageCode: body.language_code || languageCode,
    languageProbability: body.language_probability ?? null,
    timestamps: body.timestamps || null,
  };
}

async function synthesizeSpeech(input) {
  const payload = {
    text: input.text,
    target_language_code: input.targetLanguageCode || "en-IN",
    speaker: String(input.speaker || "shubh").toLowerCase(),
    model: input.model || "bulbul:v3",
    pace: Number(input.pace || 1),
    output_audio_codec: input.outputAudioCodec || "wav",
  };

  const response = await fetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: buildSarvamHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Sarvam TTS error (${response.status}): ${JSON.stringify(body)}`);
  }

  const audioBase64 = Array.isArray(body.audios) ? body.audios[0] : "";
  if (!audioBase64) {
    throw new Error("Sarvam TTS returned no audio.");
  }

  const codec = payload.output_audio_codec;
  return {
    requestId: body.request_id || null,
    audioBase64,
    contentType: AUDIO_CONTENT_TYPES[codec] || "audio/wav",
    codec,
    speaker: payload.speaker,
    targetLanguageCode: payload.target_language_code,
  };
}

async function answerWithAgents(question, retrieval, responseLanguage) {
  const analystAgent = QUERY_AGENTS[0];
  const analyst = await callSarvam(
    [
      { role: "system", content: analystAgent.systemPrompt },
      {
        role: "user",
        content: analystAgent.buildPrompt({
          question,
          contextBlock: retrieval.contextBlock,
          responseLanguage,
        }),
      },
    ],
    analystAgent,
  );

  const reviewerAgent = QUERY_AGENTS[1];
  const reviewer = await callSarvam(
    [
      { role: "system", content: reviewerAgent.systemPrompt },
      {
        role: "user",
        content: reviewerAgent.buildPrompt({
          question,
          contextBlock: retrieval.contextBlock,
          analystDraft: analyst.content,
          responseLanguage,
        }),
      },
    ],
    reviewerAgent,
  );

  const writerAgent = QUERY_AGENTS[2];
  const writer = await callSarvam(
    [
      { role: "system", content: writerAgent.systemPrompt },
      {
        role: "user",
        content: writerAgent.buildPrompt({
          question,
          contextBlock: retrieval.contextBlock,
          analystDraft: analyst.content,
          reviewDraft: reviewer.content,
          responseLanguage,
        }),
      },
    ],
    writerAgent,
  );

  return {
    finalAnswer: writer.content,
    agents: [
      { id: analystAgent.id, name: analystAgent.name, model: analyst.model, content: analyst.content },
      { id: reviewerAgent.id, name: reviewerAgent.name, model: reviewer.model, content: reviewer.content },
      { id: writerAgent.id, name: writerAgent.name, model: writer.model, content: writer.content },
    ],
  };
}

function buildFallbackAnswer(question, retrieval, responseLanguage) {
  if (!retrieval.contextItems.length) {
    return {
      finalAnswer:
        `No matching policy content was found in the current knowledge base for this question. Requested response language: ${responseLanguage}. Add more documents or refine the question.`,
      agents: [
        {
          id: "local_fallback",
          name: "Local Fallback",
          model: "heuristic",
          content: "Sarvam is not configured or context was insufficient. Returned a local retrieval summary instead.",
        },
      ],
    };
  }

  const lines = [];
  lines.push(`Question: ${question}`);
  lines.push(`Response language: ${responseLanguage}`);
  lines.push("");
  lines.push("Most relevant policy context:");
  for (const item of retrieval.contextItems) {
    lines.push(`- ${item.documentName} | ${item.id} | ${item.sectionHeading}: ${item.text}`);
  }
  lines.push("");
  lines.push(
    `Based on the current knowledge graph, the answer should be grounded in the points above. Configure SARVAM_API_KEY to get a synthesized final response from the policy agents.`,
  );

  return {
    finalAnswer: lines.join("\n"),
    agents: [
      {
        id: "local_retriever",
        name: "Local Retriever",
        model: "heuristic",
        content: retrieval.contextBlock || "No relevant graph nodes found.",
      },
    ],
  };
}

function summarizeGraph(graph) {
  return {
    exists: Boolean(graph),
    path: GRAPH_PATH,
    stats: graph ? graph.stats : { documentCount: 0, nodeCount: 0, edgeCount: 0 },
    documents: graph ? graph.documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      relativePath: doc.relativePath,
      extension: doc.extension,
      sectionCount: doc.sectionCount,
      keywordPreview: doc.keywordPreview,
    })) : [],
    updatedAt: graph ? graph.updatedAt : null,
  };
}

async function handleApi(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    const graph = loadGraph();
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(process.env.SARVAM_API_KEY),
      knowledgeBase: summarizeGraph(graph),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/knowledge-base") {
    sendJson(res, 200, summarizeGraph(loadGraph()));
    return;
  }

  if (req.method === "GET" && pathname === "/api/knowledge-graph") {
    const graph = loadGraph();
    if (!graph) {
      sendJson(res, 404, { error: "Knowledge graph not found." });
      return;
    }
    sendJson(res, 200, graph);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/ingest") {
    try {
      const body = await readBody(req);
      const uploadResult = loadDocumentsFromUploads(body.sources || []);
      const pathResult = loadDocumentsFromPaths(body.pathTargets || []);
      const documents = [...uploadResult.docs, ...pathResult.docs];
      const warnings = [...uploadResult.warnings, ...pathResult.warnings];

      if (!documents.length) {
        sendJson(res, 400, {
          error: "No supported documents were ingested. Use pdf, txt, md, json, csv, html, xml, docx, or zip.",
          warnings,
        });
        return;
      }

      const graph = createGraph(documents);
      saveGraph(graph);

      sendJson(res, 200, {
        ok: true,
        warnings,
        ingestedDocuments: documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          relativePath: doc.relativePath,
          extension: doc.extension,
          sourcePath: doc.sourcePath,
        })),
        knowledgeBase: summarizeGraph(graph),
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/clear") {
    try {
      clearKnowledgeBase();
      sendJson(res, 200, {
        ok: true,
        knowledgeBase: summarizeGraph(loadGraph()),
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/query") {
    try {
      const body = await readBody(req);
      const question = normalizeWhitespace(body.question || "");
      const responseLanguage = normalizeResponseLanguage(body.responseLanguage);
      if (!question) {
        sendJson(res, 400, { error: "Question is required." });
        return;
      }

      const graph = loadGraph();
      if (!graph) {
        sendJson(res, 400, { error: "No knowledge base found. Build the knowledge graph from the Admin screen first." });
        return;
      }

      const retrieval = retrieveRelevantContext(graph, question, Number(body.topK || 8));
      let answer;
      let warning = null;
      if (process.env.SARVAM_API_KEY) {
        try {
          answer = await answerWithAgents(question, retrieval, responseLanguage);
        } catch (error) {
          answer = buildFallbackAnswer(question, retrieval, responseLanguage);
          warning = `Sarvam agent flow failed. Returned a local graph-based summary instead. Detail: ${error.message}`;
        }
      } else {
        answer = buildFallbackAnswer(question, retrieval, responseLanguage);
      }

      sendJson(res, 200, {
        question,
        responseLanguage,
        finalAnswer: answer.finalAnswer,
        agents: answer.agents,
        contextItems: retrieval.contextItems,
        knowledgeBase: summarizeGraph(graph),
        warning,
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/speech-to-text") {
    try {
      const body = await readBody(req);
      const result = await transcribeSpeech({
        audioBase64: body.audioBase64,
        mimeType: body.mimeType,
        fileName: body.fileName,
        model: body.model,
        mode: body.mode,
        languageCode: body.languageCode,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/text-to-speech") {
    try {
      const body = await readBody(req);
      const text = normalizeWhitespace(body.text || "");
      if (!text) {
        sendJson(res, 400, { error: "Text is required for speech synthesis." });
        return;
      }

      const result = await synthesizeSpeech({
        text,
        targetLanguageCode: body.targetLanguageCode,
        speaker: body.speaker,
        model: body.model,
        pace: body.pace,
        outputAudioCodec: body.outputAudioCodec,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

function handleStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = requestUrl.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = safeJoinPublic(pathname);
  if (!filePath) {
    sendText(res, 400, "Bad request.");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(res, 404, "Not found.");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if ((req.url || "").startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    handleStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Knowledge graph app running on http://localhost:${PORT}`);
});
