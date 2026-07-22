/** Browser program embedded verbatim in every standalone session export. */
export const SESSION_EXPORT_CLIENT = String.raw`
(function () {
  "use strict";

  var encoded = document.getElementById("session-data").textContent || "";
  var binary = atob(encoded.trim());
  var bytes = new Uint8Array(binary.length);
  for (var byteIndex = 0; byteIndex < binary.length; byteIndex += 1) bytes[byteIndex] = binary.charCodeAt(byteIndex);
  var data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  document.documentElement.dataset.theme = data.theme === "light" ? "light" : "dark";
  if (data.redacted === true) document.getElementById("download-jsonl").textContent = "Download redacted JSONL";

  var entries = Array.isArray(data.entries) ? data.entries : [];
  var byId = new Map();
  var indexById = new Map();
  entries.forEach(function (entry, index) {
    if (entry && typeof entry.id === "string") {
      byId.set(entry.id, entry);
      indexById.set(entry.id, index);
    }
  });

  function text(value) { return value == null ? "" : String(value); }
  function stripUrlControls(value) { return text(value).replace(/[\x00-\x1f\x7f]/g, "").trim(); }
  function safeUrl(value, image) {
    var selected = stripUrlControls(value);
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(selected)) return selected;
    if (image && /^https?:/i.test(selected)) return selected;
    if (!image && /^(?:https?|mailto|tel):/i.test(selected)) return selected;
    return "";
  }
  function element(name, className, value) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }
  function appendText(parent, value) { parent.appendChild(document.createTextNode(text(value))); }
  function pretty(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return text(value); }
  }
  function timestamp(value) {
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString();
  }
  function boundedIdKey(value) {
    return text(value).slice(0, 128).replace(/[^A-Za-z0-9._-]/g, "-") || "session";
  }

  function ansiColor(index) {
    var base = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
    if (index >= 0 && index < 16) return base[index];
    if (index >= 16 && index < 232) {
      var cube = index - 16;
      var convert = function (part) { return part === 0 ? 0 : 55 + part * 40; };
      return "rgb(" + convert(Math.floor(cube / 36)) + "," + convert(Math.floor(cube / 6) % 6) + "," + convert(cube % 6) + ")";
    }
    var gray = Math.max(0, Math.min(255, 8 + (index - 232) * 10));
    return "rgb(" + gray + "," + gray + "," + gray + ")";
  }
  function applyAnsi(style, values) {
    for (var index = 0; index < values.length; index += 1) {
      var code = values[index];
      if (code === 0) { style = {}; }
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 22) { delete style.bold; delete style.dim; }
      else if (code === 23) delete style.italic;
      else if (code === 24) delete style.underline;
      else if (code >= 30 && code <= 37) style.color = ansiColor(code - 30);
      else if (code >= 90 && code <= 97) style.color = ansiColor(code - 90 + 8);
      else if (code >= 40 && code <= 47) style.background = ansiColor(code - 40);
      else if (code >= 100 && code <= 107) style.background = ansiColor(code - 100 + 8);
      else if ((code === 38 || code === 48) && values[index + 1] === 5) {
        var indexed = Number(values[index + 2]);
        if (Number.isInteger(indexed) && indexed >= 0 && indexed <= 255) style[code === 38 ? "color" : "background"] = ansiColor(indexed);
        index += 2;
      } else if ((code === 38 || code === 48) && values[index + 1] === 2) {
        var red = Math.max(0, Math.min(255, Number(values[index + 2]) || 0));
        var green = Math.max(0, Math.min(255, Number(values[index + 3]) || 0));
        var blue = Math.max(0, Math.min(255, Number(values[index + 4]) || 0));
        style[code === 38 ? "color" : "background"] = "rgb(" + red + "," + green + "," + blue + ")";
        index += 4;
      } else if (code === 39) delete style.color;
      else if (code === 49) delete style.background;
    }
    return style;
  }
  function styledSpan(value, style) {
    var span = element("span", "", value);
    if (style.color) span.style.color = style.color;
    if (style.background) span.style.backgroundColor = style.background;
    if (style.bold) span.style.fontWeight = "700";
    if (style.dim) span.style.opacity = ".65";
    if (style.italic) span.style.fontStyle = "italic";
    if (style.underline) span.style.textDecoration = "underline";
    return span;
  }
  function appendAnsiInline(parent, value) {
    var source = text(value);
    var pattern = /\x1b\[([0-9;]*)m/g;
    var style = {};
    var offset = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      if (match.index > offset) parent.appendChild(styledSpan(source.slice(offset, match.index), style));
      style = applyAnsi(style, (match[1] || "0").split(";").map(function (part) { return Number(part || 0); }));
      offset = match.index + match[0].length;
    }
    if (offset < source.length) parent.appendChild(styledSpan(source.slice(offset), style));
  }
  function appendAnsiRows(parent, value) {
    var output = element("div", "terminal-output");
    text(value).replace(/\r\n?/g, "\n").split("\n").forEach(function (line) {
      var row = element("div", "ansi-line");
      appendAnsiInline(row, line);
      output.appendChild(row);
    });
    parent.appendChild(output);
  }

  function appendMarkdown(parent, value) {
    var box = element("div", "text-block");
    var source = text(value);
    var pattern = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
    var offset = 0;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      appendText(box, source.slice(offset, match.index));
      var isImage = match[1] === "!";
      var selected = safeUrl(match[3], isImage);
      if (!selected) {
        appendText(box, match[0]);
      } else if (isImage) {
        var image = element("img", "inline-image");
        image.src = selected;
        image.alt = text(match[2]);
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        installImageModal(image);
        box.appendChild(image);
      } else {
        var link = element("a", "markdown-link", match[2]);
        link.href = selected;
        link.rel = "noopener noreferrer";
        link.referrerPolicy = "no-referrer";
        box.appendChild(link);
      }
      offset = match.index + match[0].length;
    }
    appendText(box, source.slice(offset));
    parent.appendChild(box);
  }
  function appendJson(parent, value) {
    parent.appendChild(element("pre", "json-block", pretty(value)));
  }
  function imageSource(block) {
    var media = text(block && block.mediaType).toLowerCase();
    if (!/^(?:image\/)?(?:png|jpeg|gif|webp)$/.test(media)) return "";
    if (block && typeof block.data === "string" && /^[A-Za-z0-9+/=]+$/.test(block.data)) {
      var normalized = media.indexOf("image/") === 0 ? media : "image/" + media;
      return safeUrl("data:" + normalized + ";base64," + block.data, true);
    }
    return safeUrl(block && block.url, true);
  }
  function appendImage(parent, block) {
    var selected = imageSource(block || {});
    if (!selected) {
      parent.appendChild(element("div", "image-fallback", "[image: " + text(block && block.mediaType || "unknown") + "]"));
      return;
    }
    var image = element("img", "inline-image");
    image.src = selected;
    image.alt = "Session image";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    installImageModal(image);
    parent.appendChild(image);
  }

  function renderUiBlock(parent, block) {
    if (!block || !Array.isArray(block.lines)) return false;
    var output = element("div", "terminal-output");
    block.lines.forEach(function (line) {
      var row = element("div", "ansi-line");
      var spans = line && Array.isArray(line.spans) ? line.spans : [];
      spans.forEach(function (sourceSpan) {
        var role = text(sourceSpan && sourceSpan.role);
        var span = element("span", /^(?:muted|accent|link|success|warning|error|title)$/.test(role) ? "role-" + role : "");
        appendAnsiInline(span, sourceSpan && sourceSpan.text);
        row.appendChild(span);
      });
      output.appendChild(row);
    });
    parent.appendChild(output);
    return true;
  }

  var modal = document.getElementById("image-modal");
  var modalImage = document.getElementById("modal-image");
  function installImageModal(image) {
    image.addEventListener("click", function () {
      modalImage.src = image.src;
      modalImage.alt = image.alt;
      modal.classList.add("open");
    });
  }
  modal.addEventListener("click", function () { modal.classList.remove("open"); modalImage.removeAttribute("src"); });

  var labels = new Map();
  if (data.tree && Array.isArray(data.tree.nodes)) {
    data.tree.nodes.forEach(function (node) {
      if (node && typeof node.id === "string" && typeof node.label === "string") labels.set(node.id, node.label);
    });
  } else {
    entries.forEach(function (entry) {
      if (!entry || entry.type !== "label" || typeof entry.targetId !== "string") return;
      if (typeof entry.label === "string" && entry.label.length > 0) labels.set(entry.targetId, entry.label);
      else labels.delete(entry.targetId);
    });
  }

  var nodes = new Map();
  var roots = [];
  entries.forEach(function (entry) {
    if (entry && typeof entry.id === "string") nodes.set(entry.id, { entry: entry, children: [] });
  });
  if (data.tree && Array.isArray(data.tree.nodes) && Array.isArray(data.tree.roots)) {
    data.tree.nodes.forEach(function (projected) {
      var node = projected && nodes.get(projected.id);
      if (!node || !Array.isArray(projected.children)) return;
      projected.children.forEach(function (childId) {
        var child = nodes.get(childId);
        if (child) node.children.push(child);
      });
    });
    data.tree.roots.forEach(function (rootId) {
      var root = nodes.get(rootId);
      if (root) roots.push(root);
    });
  } else {
    entries.forEach(function (entry) {
      if (!entry || typeof entry.id !== "string") return;
      var node = nodes.get(entry.id);
      var parent = typeof entry.parentId === "string" && entry.parentId !== entry.id ? nodes.get(entry.parentId) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    });
  }
  nodes.forEach(function (node) {
    node.children.sort(function (left, right) {
      return new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime();
    });
  });
  roots.sort(function (left, right) {
    return new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime();
  });

  function pathTo(id) {
    var result = [];
    var visited = new Set();
    var current = byId.get(id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.unshift(current);
      current = typeof current.parentId === "string" && current.parentId !== current.id ? byId.get(current.parentId) : undefined;
    }
    return result;
  }
  function activeIds(id) { return new Set(pathTo(id).map(function (entry) { return entry.id; })); }
  function flatTree() {
    var result = [];
    var stack = [];
    for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex -= 1) stack.push({ node: roots[rootIndex], depth: 0, last: rootIndex === roots.length - 1 });
    while (stack.length) {
      var selected = stack.pop();
      result.push(selected);
      for (var childIndex = selected.node.children.length - 1; childIndex >= 0; childIndex -= 1) {
        stack.push({ node: selected.node.children[childIndex], depth: selected.depth + 1, last: childIndex === selected.node.children.length - 1 });
      }
    }
    return result;
  }
  var flattened = flatTree();

  function entryText(entry) {
    if (!entry) return "";
    if (entry.type === "message") {
      var message = entry.message || {};
      if (message.role === "bashExecution") return "bash " + text(message.command) + " " + text(message.output);
      return text(message.role) + " " + (Array.isArray(message.content) ? message.content.map(function (block) {
        if (block.type === "text") return text(block.text);
        if (block.type === "tool_call") return text(block.name) + " " + pretty(block.arguments);
        if (block.type === "tool_result") return text(block.name) + " " + text(block.content);
        return text(block.mediaType);
      }).join(" ") : "");
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") return text(entry.summary);
    if (entry.type === "custom_message") return text(entry.customType) + " " + (typeof entry.content === "string" ? entry.content : pretty(entry.content));
    return text(entry.type) + " " + pretty(entry);
  }
  function entryLabel(entry) {
    var label = labels.get(entry.id);
    if (label) return label;
    if (entry.type === "message") {
      var message = entry.message || {};
      if (message.role === "bashExecution") return "$ " + text(message.command).slice(0, 64);
      if (message.role === "custom") return text(message.customType || "custom");
      var firstText = Array.isArray(message.content) ? message.content.find(function (block) { return block.type === "text" && block.text; }) : undefined;
      if (firstText) return text(message.role) + ": " + text(firstText.text).replace(/\s+/g, " ").slice(0, 70);
      var tool = Array.isArray(message.content) ? message.content.find(function (block) { return block.type === "tool_call" || block.type === "tool_result"; }) : undefined;
      return tool ? text(tool.type === "tool_call" ? "call" : "result") + ": " + text(tool.name) : text(message.role || "message");
    }
    if (entry.type === "branch_summary") return "branch summary";
    if (entry.type === "thinking_level_change") return "thinking: " + text(entry.thinkingLevel);
    if (entry.type === "model_change") return "model: " + text(entry.provider) + "/" + text(entry.modelId);
    if (entry.type === "custom_message") return text(entry.customType || "custom message");
    return text(entry.type).replace(/_/g, " ");
  }

  var query = new URLSearchParams(window.location.search);
  var requestedLeaf = stripUrlControls(query.get("leafId"));
  var selectedLeaf = byId.has(requestedLeaf) ? requestedLeaf : byId.has(data.leafId) ? data.leafId : entries.length ? entries[entries.length - 1].id : null;
  var targetId = stripUrlControls(query.get("targetId"));
  var filterMode = "default";
  var search = "";
  var showTools = true;
  var showThinking = true;

  function filterEntry(entry) {
    if (entry.id === selectedLeaf) return true;
    if (filterMode === "user") return entry.type === "message" && entry.message && entry.message.role === "user";
    if (filterMode === "labeled") return labels.has(entry.id);
    if (filterMode === "no-tools") {
      if (["label", "session_info", "thinking_level_change", "model_change", "custom"].indexOf(entry.type) >= 0) return false;
      if (entry.type === "message" && entry.message && entry.message.role === "tool") return false;
      return true;
    }
    if (filterMode === "all") return true;
    return ["label", "session_info", "thinking_level_change", "model_change", "custom"].indexOf(entry.type) < 0;
  }
  function renderTree() {
    var container = document.getElementById("tree");
    container.replaceChildren();
    var currentPath = activeIds(selectedLeaf);
    var tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    var count = 0;
    flattened.forEach(function (flat) {
      var entry = flat.node.entry;
      if (!filterEntry(entry)) return;
      var searchable = (entryLabel(entry) + " " + entryText(entry)).toLowerCase();
      if (tokens.some(function (token) { return searchable.indexOf(token) < 0; })) return;
      var row = element("button", "tree-row");
      row.type = "button";
      row.classList.toggle("active", entry.id === selectedLeaf);
      row.classList.toggle("in-path", currentPath.has(entry.id));
      var connector = roots.length > 1 || flat.depth > 0 ? (flat.last ? "└─ " : "├─ ") : "";
      row.appendChild(element("span", "tree-prefix", "   ".repeat(flat.depth) + connector));
      row.appendChild(element("span", "tree-label", entryLabel(entry)));
      row.addEventListener("click", function () { selectLeaf(entry.id, entry.id); });
      container.appendChild(row);
      count += 1;
    });
    document.getElementById("tree-count").textContent = count + " of " + entries.length + " entries" + (roots.length > 1 ? " · " + roots.length + " roots" : "");
  }

  function renderPreRendered(parent, callId, key) {
    var rendered = data.renderedTools && Object.prototype.hasOwnProperty.call(data.renderedTools, callId)
      ? data.renderedTools[callId]
      : undefined;
    return rendered ? renderUiBlock(parent, rendered[key]) : false;
  }
  function toolDetails(summary, open) {
    var details = element("details", "tool-card");
    details.open = Boolean(open);
    details.appendChild(element("summary", "", summary));
    var body = element("div", "");
    details.appendChild(body);
    return { details: details, body: body };
  }
  function renderToolCall(parent, block) {
    var card = toolDetails("tool call · " + text(block.name), true);
    card.details.dataset.tool = "true";
    if (!renderPreRendered(card.body, text(block.callId), "call")) appendJson(card.body, block.arguments);
    parent.appendChild(card.details);
  }
  function renderToolResult(parent, block) {
    var status = block.isError ? "error" : "success";
    var card = toolDetails("tool result · " + text(block.name) + " · " + status, false);
    card.details.dataset.tool = "true";
    card.details.classList.add(block.isError ? "tool-status-error" : "tool-status-success");
    var callId = text(block.callId);
    var rendered = data.renderedTools && Object.prototype.hasOwnProperty.call(data.renderedTools, callId)
      ? data.renderedTools[callId]
      : undefined;
    if (rendered && (rendered.resultCollapsed || rendered.resultExpanded)) {
      if (rendered.resultCollapsed) {
        var preview = element("div", "collapsed-preview");
        renderUiBlock(preview, rendered.resultCollapsed);
        card.details.insertBefore(preview, card.body);
      }
      if (!renderUiBlock(card.body, rendered.resultExpanded || rendered.resultCollapsed)) appendAnsiRows(card.body, block.content);
    } else appendAnsiRows(card.body, block.content);
    if (Array.isArray(block.images)) block.images.forEach(function (image) { appendImage(card.body, image); });
    if (block.metadata !== undefined) appendJson(card.body, block.metadata);
    parent.appendChild(card.details);
  }
  function parseSkill(value) {
    var match = text(value).match(/^<skill name="([^"]*)" location="([^"]*)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/);
    return match ? { name: match[1], location: match[2], body: match[3], prompt: match[4] || "" } : null;
  }
  function renderTextBlock(parent, value, role) {
    var skill = role === "user" ? parseSkill(value) : null;
    if (!skill) { appendMarkdown(parent, value); return; }
    var details = element("details", "skill-card");
    details.appendChild(element("summary", "", "skill · " + skill.name));
    var body = element("div", "");
    body.appendChild(element("div", "meta", skill.location));
    appendMarkdown(body, skill.body);
    details.appendChild(body);
    parent.appendChild(details);
    if (skill.prompt) appendMarkdown(parent, skill.prompt);
  }
  function renderOpaque(parent, block) {
    var media = text(block.mediaType);
    var reasoning = /reason|thinking/i.test(media);
    var details = element("details", reasoning ? "reasoning-card" : "tool-card");
    if (reasoning) details.dataset.thinking = "true";
    details.appendChild(element("summary", "", (reasoning ? "reasoning" : "provider data") + " · " + text(block.provider) + "/" + media));
    var body = element("div", "");
    appendJson(body, block.value !== undefined ? block.value : block.serialized);
    details.appendChild(body);
    parent.appendChild(details);
  }
  function renderCanonicalContent(parent, message) {
    var blocks = Array.isArray(message.content) ? message.content : [];
    blocks.forEach(function (block) {
      if (!block || typeof block !== "object") return;
      if (block.type === "text") renderTextBlock(parent, block.text, message.role);
      else if (block.type === "image") appendImage(parent, block);
      else if (block.type === "tool_call") renderToolCall(parent, block);
      else if (block.type === "tool_result") renderToolResult(parent, block);
      else if (block.type === "provider_opaque") renderOpaque(parent, block);
      else appendJson(parent, block);
    });
    if (message.errorMessage) parent.appendChild(element("div", "tool-status-error", message.errorMessage));
  }
  function appendUsageLine(parent, usage) {
    if (!usage || typeof usage !== "object") return;
    var parts = [];
    if (usage.inputTokens != null) parts.push("in " + usage.inputTokens);
    if (usage.outputTokens != null) parts.push("out " + usage.outputTokens);
    if (usage.cacheReadTokens != null) parts.push("cache read " + usage.cacheReadTokens);
    if (usage.cacheWriteTokens != null) parts.push("cache write " + usage.cacheWriteTokens);
    if (usage.cost && usage.cost.total != null) parts.push("$" + Number(usage.cost.total).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
    if (parts.length) parent.appendChild(element("div", "meta", parts.join(" · ")));
  }
  function entryCard(entry, index) {
    var role = entry.type === "message" && entry.message ? text(entry.message.role) : "structural";
    var card = element("article", "entry " + (/^(?:user|assistant|tool|system)$/.test(role) ? role : "structural"));
    card.id = "entry-" + index;
    card.dataset.entryIndex = String(index);
    var head = element("header", "entry-head");
    head.appendChild(element("span", "entry-kind", entryLabel(entry)));
    var headRight = element("span", "");
    headRight.appendChild(element("span", "", timestamp(entry.timestamp)));
    var link = element("button", "deep-link", " link");
    link.type = "button";
    link.title = "Copy a deep link";
    link.addEventListener("click", function () { copyDeepLink(entry.id); });
    headRight.appendChild(link);
    head.appendChild(headRight);
    card.appendChild(head);
    var body = element("div", "entry-body");

    if (entry.type === "message") {
      var message = entry.message || {};
      if (message.role === "bashExecution") {
        body.appendChild(element("div", "structural-title", "$ " + text(message.command)));
        appendAnsiRows(body, message.output);
        body.appendChild(element("div", "meta", "exit " + text(message.exitCode == null ? "unknown" : message.exitCode) + (message.cancelled ? " · cancelled" : "") + (message.truncated ? " · truncated" : "")));
      } else if (message.role === "custom") {
        if (message.display === false) card.classList.add("hidden-entry");
        if (typeof message.content === "string") appendMarkdown(body, message.content);
        else renderCanonicalContent(body, { role: "custom", content: message.content || [] });
        if (message.details !== undefined) appendJson(body, message.details);
      } else {
        renderCanonicalContent(body, message);
        appendUsageLine(body, message.usage);
      }
    } else if (entry.type === "compaction") {
      card.classList.add("structural");
      body.appendChild(element("div", "structural-title", "Context compaction"));
      appendMarkdown(body, entry.summary);
      body.appendChild(element("div", "meta", "tokens before " + text(entry.tokensBefore) + " · first kept " + text(entry.firstKeptEntryId)));
      appendUsageLine(body, entry.usage);
      if (entry.details !== undefined) appendJson(body, entry.details);
    } else if (entry.type === "branch_summary") {
      card.classList.add("structural");
      body.appendChild(element("div", "structural-title", "Branch summary"));
      appendMarkdown(body, entry.summary);
      body.appendChild(element("div", "meta", "from " + text(entry.fromId)));
      appendUsageLine(body, entry.usage);
      if (entry.details !== undefined) appendJson(body, entry.details);
    } else if (entry.type === "custom_message") {
      if (entry.display === false) card.classList.add("hidden-entry");
      if (typeof entry.content === "string") appendMarkdown(body, entry.content);
      else renderCanonicalContent(body, { role: "custom", content: entry.content || [] });
      if (entry.details !== undefined) appendJson(body, entry.details);
    } else {
      card.classList.add("structural");
      appendJson(body, entry);
    }
    card.appendChild(body);
    return card;
  }

  function renderMessages() {
    var container = document.getElementById("messages");
    container.replaceChildren();
    var path = selectedLeaf ? pathTo(selectedLeaf) : [];
    if (!path.length) container.appendChild(element("div", "empty", "This session has no entries."));
    path.forEach(function (entry) {
      var index = indexById.get(entry.id);
      var card = entryCard(entry, index);
      container.appendChild(card);
    });
    applyVisibility();
    if (targetId && byId.has(targetId)) {
      var selectedIndex = indexById.get(targetId);
      var target = document.getElementById("entry-" + selectedIndex);
      if (target) {
        target.classList.add("target-flash");
        target.scrollIntoView({ block: "center" });
      }
    }
  }
  function applyVisibility() {
    document.querySelectorAll("[data-tool=true]").forEach(function (node) { node.classList.toggle("is-hidden", !showTools); });
    document.querySelectorAll("[data-thinking=true]").forEach(function (node) { node.classList.toggle("is-hidden", !showThinking); });
    document.getElementById("toggle-tools").setAttribute("aria-pressed", String(showTools));
    document.getElementById("toggle-thinking").setAttribute("aria-pressed", String(showThinking));
  }
  function updateLocation(leaf, target) {
    var next = new URL(window.location.href);
    if (leaf) next.searchParams.set("leafId", leaf); else next.searchParams.delete("leafId");
    if (target) next.searchParams.set("targetId", target); else next.searchParams.delete("targetId");
    history.replaceState(null, "", next.href);
  }
  function selectLeaf(leaf, target) {
    if (!byId.has(leaf)) return;
    selectedLeaf = leaf;
    targetId = target || leaf;
    updateLocation(selectedLeaf, targetId);
    renderTree();
    renderMessages();
    document.body.classList.remove("sidebar-open");
  }
  function copyDeepLink(target) {
    updateLocation(selectedLeaf, target);
    var value = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).catch(function () {});
  }

  document.getElementById("tree-search").addEventListener("input", function (event) { search = text(event.target.value); renderTree(); });
  document.querySelectorAll("[data-filter]").forEach(function (button) {
    button.addEventListener("click", function () {
      filterMode = button.dataset.filter || "default";
      document.querySelectorAll("[data-filter]").forEach(function (candidate) { candidate.setAttribute("aria-pressed", String(candidate === button)); });
      renderTree();
    });
  });
  document.getElementById("toggle-tools").addEventListener("click", function () { showTools = !showTools; applyVisibility(); });
  document.getElementById("toggle-thinking").addEventListener("click", function () { showThinking = !showThinking; applyVisibility(); });
  document.getElementById("download-jsonl").addEventListener("click", function () {
    var blob = new Blob([text(data.jsonl)], { type: "application/x-ndjson;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var anchor = element("a", "");
    anchor.href = url;
    anchor.download = "rigyn-session-" + boundedIdKey(data.header && data.header.id) + ".jsonl";
    anchor.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  });

  var storageKey = "rigyn.session-export.sidebar." + boundedIdKey(data.header && data.header.id);
  function storageRead() { try { return localStorage.getItem(storageKey); } catch (_) { return null; } }
  function storageWrite(value) { try { localStorage.setItem(storageKey, String(value)); } catch (_) {} }
  function boundedWidth(value) { return Math.max(220, Math.min(520, Number(value) || 310)); }
  var savedWidth = Number(storageRead());
  if (Number.isFinite(savedWidth)) document.documentElement.style.setProperty("--sidebar-width", boundedWidth(savedWidth) + "px");
  var resizer = document.getElementById("resizer");
  resizer.addEventListener("pointerdown", function (event) {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    document.body.classList.add("resizing");
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener("pointermove", function (event) {
    if (!document.body.classList.contains("resizing")) return;
    document.documentElement.style.setProperty("--sidebar-width", boundedWidth(event.clientX) + "px");
  });
  function stopResize(event) {
    if (!document.body.classList.contains("resizing")) return;
    document.body.classList.remove("resizing");
    var width = boundedWidth(document.getElementById("sidebar").getBoundingClientRect().width);
    storageWrite(width);
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
  }
  resizer.addEventListener("pointerup", stopResize);
  resizer.addEventListener("pointercancel", stopResize);
  document.getElementById("mobile-open").addEventListener("click", function () { document.body.classList.add("sidebar-open"); });
  document.getElementById("mobile-close").addEventListener("click", function () { document.body.classList.remove("sidebar-open"); });
  document.getElementById("overlay").addEventListener("click", function () { document.body.classList.remove("sidebar-open"); });

  document.getElementById("session-title").textContent = text(data.title || "rigyn session");
  document.getElementById("session-meta").textContent = text(data.header && data.header.cwd) + " · " + text(data.header && data.header.id) + " · " + timestamp(data.header && data.header.timestamp);
  var usage = data.usage || {};
  [["usage-input", usage.inputTokens], ["usage-output", usage.outputTokens], ["usage-cache-read", usage.cacheReadTokens], ["usage-cache-write", usage.cacheWriteTokens]].forEach(function (item) {
    document.getElementById(item[0]).textContent = Number(item[1] || 0).toLocaleString();
  });
  document.getElementById("usage-total").textContent = Number(usage.totalTokens || 0).toLocaleString();
  function costText(value) { return "$" + Number(value || 0).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); }
  [["usage-input-cost", usage.cost && usage.cost.input], ["usage-output-cost", usage.cost && usage.cost.output],
    ["usage-cache-read-cost", usage.cost && usage.cost.cacheRead], ["usage-cache-write-cost", usage.cost && usage.cost.cacheWrite],
    ["usage-cost", usage.cost && usage.cost.total]].forEach(function (item) {
    document.getElementById(item[0]).textContent = costText(item[1]);
  });
  if (data.systemPrompt) appendMarkdown(document.getElementById("system-prompt"), data.systemPrompt);
  else document.getElementById("system-prompt-section").classList.add("is-hidden");
  if (Array.isArray(data.tools) && data.tools.length) data.tools.forEach(function (tool) {
    var details = element("details", "tool-card");
    details.appendChild(element("summary", "", text(tool.name) + (tool.active === false ? " · inactive" : "")));
    var body = element("div", "");
    appendMarkdown(body, tool.description);
    appendJson(body, tool.inputSchema);
    details.appendChild(body);
    document.getElementById("tool-schemas").appendChild(details);
  }); else document.getElementById("tools-section").classList.add("is-hidden");
  if (Array.isArray(data.skills) && data.skills.length) data.skills.forEach(function (skill) {
    var row = element("div", "tool-card");
    var body = element("div", "");
    body.appendChild(element("strong", "", skill.name));
    appendText(body, " · " + text(skill.description));
    row.appendChild(body);
    document.getElementById("skills").appendChild(row);
  }); else document.getElementById("skills-section").classList.add("is-hidden");

  renderTree();
  renderMessages();
})();
`;
