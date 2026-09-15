/** Pure graph and media helpers shared by the node interfaces and their tests. */

import { observeWidgetValue } from "./bonfire_widgets.js";

export function extensionOf(name) {
  const clean = String(name ?? "").split(/[?#]/, 1)[0];
  const index = clean.lastIndexOf(".");
  return index < 0 ? "" : clean.slice(index).toLowerCase();
}

export function acceptsImageFile(file, extensions) {
  const allowed = new Set((extensions ?? []).map((value) => String(value).toLowerCase()));
  if (file?.name) {
    const extension = extensionOf(file.name);
    if (extension) return allowed.has(extension);
  }
  const mime = String(file?.type ?? "").toLowerCase();
  if (!mime.startsWith("image/")) return false;
  const fromMime = `.${mime.slice("image/".length).split("+", 1)[0]}`;
  const aliases = fromMime === ".jpeg" ? [".jpeg", ".jpg"] : [fromMime];
  return aliases.some((extension) => allowed.has(extension));
}

export function clipspaceImageSource(clipspace) {
  const images = clipspace?.imgs;
  if (!images?.length) return "";
  const index = Number.isInteger(clipspace.selectedIndex) ? clipspace.selectedIndex : 0;
  return images[index]?.src || images[0]?.src || "";
}

export function imageFilesFromPasteEvent(event) {
  const files = [...(event?.clipboardData?.files ?? [])].filter(Boolean);
  if (files.length) return files;
  const collected = [];
  for (const item of event?.clipboardData?.items ?? []) {
    if (!String(item.type || "").startsWith("image/")) continue;
    const file = item.getAsFile?.();
    if (file) collected.push(file);
  }
  return collected;
}

export function fileImportPath(file) {
  return String(file?.webkitRelativePath || file?.name || "");
}

export function compareNatural(left, right) {
  const a = String(left ?? "").split(/(\d+)/);
  const b = String(right ?? "").split(/(\d+)/);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const partA = a[index] ?? "";
    const partB = b[index] ?? "";
    if (partA === partB) continue;
    const numA = Number(partA);
    const numB = Number(partB);
    if (partA !== "" && partB !== "" && Number.isFinite(numA) && Number.isFinite(numB)) {
      return numA - numB;
    }
    return partA.toLowerCase() < partB.toLowerCase() ? -1 : 1;
  }
  return 0;
}

export function sortImportFiles(files) {
  return [...(files ?? [])].sort((left, right) =>
    compareNatural(fileImportPath(left), fileImportPath(right))
  );
}

function readDirectoryEntries(directory) {
  const reader = directory.createReader();
  const entries = [];
  return new Promise((resolve, reject) => {
    const pump = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        queueMicrotask(pump);
      }, reject);
    };
    pump();
  });
}

export async function filesFromDirectoryEntry(entry, files = []) {
  if (!entry) return files;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (file) files.push(file);
    return files;
  }
  if (!entry.isDirectory) return files;
  if (String(entry.name || "").startsWith(".")) return files;
  for (const child of await readDirectoryEntries(entry)) {
    await filesFromDirectoryEntry(child, files);
  }
  return files;
}

export async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])];
  const entries = items
    .map((item) =>
      typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null
    )
    .filter(Boolean);
  if (entries.length) {
    const files = [];
    for (const entry of entries) await filesFromDirectoryEntry(entry, files);
    if (files.length) return files;
  }
  return [...(dataTransfer?.files ?? [])].filter(Boolean);
}

export function parseQueue(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? dedupeQueue(value) : [];
  } catch {
    return [];
  }
}

export function canonicalImageName(name) {
  return String(name ?? "").trim().replace(/\s+\[input\]$/i, "").trim();
}

export function queueIndex(entries, name) {
  const key = canonicalImageName(name);
  if (!key) return -1;
  return entries.findIndex((entry) => canonicalImageName(entry) === key);
}

export function dedupeQueue(names) {
  const seen = new Set();
  const result = [];
  for (const name of names ?? []) {
    if (typeof name !== "string" || !name) continue;
    const key = canonicalImageName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/** Keep the previous image and insert a Mask Editor result directly after it. */
export function queueAfterImageChange(queue, previous, next) {
  const result = dedupeQueue(queue);
  const previousKey = canonicalImageName(previous);
  const nextKey = canonicalImageName(next);
  if (!nextKey) return result;
  if (result.some((name) => canonicalImageName(name) === nextKey)) {
    // Cursor moved to an entry that is already queued (step, or delete repair).
    // Do not resurrect `previous` — that is how a deleted current image came back.
    return result;
  }
  if (!result.length && !previousKey) {
    // An empty queue plus a combo default is not a user selection. Seeding here is
    // how a deleted image reappeared on a freshly created node.
    return result;
  }

  let previousIndex = result.findIndex(
    (name) => canonicalImageName(name) === previousKey
  );
  if (previousKey && previousIndex === -1) {
    result.push(previous);
    previousIndex = result.length - 1;
  }
  result.splice(previousIndex >= 0 ? previousIndex + 1 : result.length, 0, next);
  return result;
}

export function initialQueueState(queueRaw, comboValue) {
  const queue = parseQueue(queueRaw);
  if (!queue.length) return { queue: [], current: "" };
  const current = canonicalImageName(comboValue)
    ? comboValue
    : queue[0];
  return {
    queue: queueAfterImageChange(queue, "", current),
    current,
  };
}

export function stepQueue(entries, current, offset) {
  if (!entries.length) return "";
  const index = queueIndex(entries, current);
  const from = index === -1 ? 0 : index;
  const target = Math.max(0, Math.min(entries.length - 1, from + offset));
  return entries[target];
}

export function queueAfterDeletion(queue, deleted, current) {
  const removed = new Set((deleted ?? []).map(canonicalImageName));
  const source = dedupeQueue(queue);
  const currentIndex = source.findIndex(
    (name) => canonicalImageName(name) === canonicalImageName(current)
  );
  const result = source.filter((name) => !removed.has(canonicalImageName(name)));
  const currentRemoved = removed.has(canonicalImageName(current));
  return {
    queue: result,
    current: currentRemoved
      ? result[Math.min(Math.max(0, currentIndex), result.length - 1)] ?? ""
      : current,
  };
}

export function preparePreviewNode(node, image) {
  node.imgs = [image];
  node.imageIndex = 0;
  node.previewMediaType = "image";
}

function previewState(node) {
  const keys = ["imgs", "imageIndex", "previewMediaType"];
  const state = new Map();
  for (const key of keys) {
    state.set(key, {
      owned: Object.prototype.hasOwnProperty.call(node, key),
      value: node[key],
    });
  }
  return () => {
    for (const [key, entry] of state) {
      if (entry.owned) node[key] = entry.value;
      else delete node[key];
    }
  };
}

export function selectOnly(canvas, node) {
  canvas?.deselectAll?.();
  canvas?.selectNode?.(node);
}

export async function copyImageData({ node, image, copyToClipspace, loadBlob, writeBlob }) {
  const restore = previewState(node);
  try {
    preparePreviewNode(node, image);
    copyToClipspace(node);
  } finally {
    // Clipspace has captured the media. Do not keep a full source bitmap on the node or
    // let the canvas renderer turn the temporary bridge into a second preview.
    restore();
  }
  await writeBlob(await loadBlob());
}

export function isMaskEditorOpen() {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      '.mask-editor, [class*="mask-editor"], [class*="MaskEditor"], [aria-label="Mask Editor"]'
    )
  );
}

export function waitForPredicate(isTrue, timeout = 15000, interval = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isTrue() || Date.now() - start >= timeout) {
        resolve(isTrue());
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

export async function waitForMaskEditorClose(timeout = 15000) {
  if (typeof document === "undefined") return false;
  const opened = await waitForPredicate(isMaskEditorOpen, Math.min(2000, timeout), 40);
  if (!opened) return false;
  await waitForPredicate(() => !isMaskEditorOpen(), timeout, 50);
  return true;
}

export async function openMaskForNode({ node, image, canvas, execute }) {
  const restore = previewState(node);
  preparePreviewNode(node, image);
  try {
    await image.decode?.();
  } catch {
    // The editor can still open from an undecodable placeholder.
  }
  selectOnly(canvas, node);
  try {
    await execute();
    await waitForMaskEditorClose();
  } finally {
    restore();
  }
}

/** Forward a DOM-widget right click to LiteGraph's ordinary node menu. */
export function openNodeContextMenu({ event, node, canvas }) {
  if (!canvas?.processContextMenu) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  if (typeof document !== "undefined") {
    document
      .querySelectorAll(".litegraph.litecontextmenu, .litecontextmenu")
      .forEach((el) => el.remove());
  }
  if (!node?.is_selected) canvas.selectNode?.(node);
  const point = canvas.convertEventToCanvasOffset?.(event) ?? [event.clientX, event.clientY];
  for (const [key, value] of [
    ["canvasX", point[0]],
    ["canvasY", point[1]],
  ]) {
    try {
      Object.defineProperty(event, key, { configurable: true, value });
    } catch {
      event[key] = value;
    }
  }
  canvas.processContextMenu(node, event);
  return true;
}

export function installConnectionRefresh(node, refresh) {
  const previous = node.onConnectionsChange;
  const wrapped = function (...args) {
    const result = previous?.apply(this, args);
    // LiteGraph has stored the link before this callback. Deferring one microtask also
    // lets another extension finish updating a connected file widget first.
    queueMicrotask(refresh);
    return result;
  };
  node.onConnectionsChange = wrapped;
  return () => {
    if (node.onConnectionsChange === wrapped) node.onConnectionsChange = previous;
  };
}

/** Watch connected nodes so Match input updates when a Load Video file changes. */
export function installUpstreamWatch(
  node,
  refresh,
  inputNames = ["image", "width", "height"]
) {
  const unbind = [];
  function clear() {
    while (unbind.length) unbind.pop()();
  }
  function watchWidget(widget) {
    if (!widget) return;
    unbind.push(observeWidgetValue(widget, refresh));
    if (typeof widget.callback !== "function") return;
    const previous = widget.callback;
    const wrapped = function (...args) {
      const result = previous.apply(this, args);
      refresh();
      return result;
    };
    widget.callback = wrapped;
    unbind.push(() => {
      if (widget.callback === wrapped) widget.callback = previous;
    });
  }
  function rebind() {
    clear();
    const seen = new Set();
    for (const name of inputNames) {
      const source = upstreamSource(node, name)?.node;
      if (!source || seen.has(source)) continue;
      seen.add(source);
      for (const widget of source.widgets ?? []) watchWidget(widget);
      const previousExecuted = source.onExecuted;
      const wrappedExecuted = function (...args) {
        const result = previousExecuted?.apply(this, args);
        queueMicrotask(refresh);
        return result;
      };
      source.onExecuted = wrappedExecuted;
      unbind.push(() => {
        if (source.onExecuted === wrappedExecuted) source.onExecuted = previousExecuted;
      });
    }
  }
  rebind();
  const unwatchConnections = installConnectionRefresh(node, () => {
    rebind();
    refresh();
  });
  return () => {
    unwatchConnections();
    clear();
  };
}

export function thumbnailSize(width, height, devicePixelRatio = 1, maximum = 512) {
  const wanted = Math.max(width || 0, height || 0) * Math.max(devicePixelRatio || 1, 1);
  const steps = [96, 128, 192, 256, 384, 512].filter((value) => value <= maximum);
  return steps.find((value) => value >= wanted) ?? maximum;
}

function graphLink(graph, input) {
  if (!input || input.link === null || input.link === undefined) return null;
  if (typeof input.link === "object") return input.link;
  return graph?.links?.[input.link] ?? graph?.links?.get?.(input.link) ?? null;
}

function graphNode(graph, id) {
  return graph?.getNodeById?.(id) ?? graph?._nodes_by_id?.[id] ?? null;
}

function isReroute(node) {
  const kind = `${node?.type ?? ""} ${node?.comfyClass ?? ""} ${
    node?.constructor?.comfyClass ?? ""
  }`.toLowerCase();
  return kind.includes("reroute");
}

export function inputByName(node, name) {
  return node?.inputs?.find((input) => input.name === name) ?? null;
}

export function upstreamSource(node, inputName, graph = node?.graph) {
  let input = inputByName(node, inputName);
  let link = graphLink(graph, input);
  const visited = new Set();
  while (link) {
    const source = graphNode(graph, link.origin_id);
    if (!source || visited.has(source.id)) return null;
    visited.add(source.id);
    if (!isReroute(source)) return { node: source, outputSlot: link.origin_slot ?? 0 };
    input = source.inputs?.[0];
    link = graphLink(graph, input);
  }
  return null;
}

function widget(node, name) {
  return node?.widgets?.find((candidate) => candidate.name === name);
}

export function mediaName(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return mediaName(value[0]);
  if (!value || typeof value !== "object") return "";
  const filename = mediaName(value.filename ?? value.name ?? value.value);
  if (!filename) return "";
  const subfolder = mediaName(value.subfolder);
  return subfolder ? `${subfolder.replace(/[\\/]+$/, "")}/${filename}` : filename;
}

function mediaNameFromUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, window.location.href);
    const filename = url.searchParams.get("filename");
    if (!filename) return "";
    const subfolder = url.searchParams.get("subfolder");
    return subfolder ? `${subfolder}/${filename}` : filename;
  } catch {
    return "";
  }
}

export function numericOutputHint(source) {
  if (!source) return undefined;
  const output = source.node?.outputs?.[source.outputSlot];
  const named = widget(source.node, output?.name);
  const candidates = [
    source.node?.__bonfireOutputValues?.[source.outputSlot],
    named?.value,
    source.node?.widgets?.length === 1 ? source.node.widgets[0]?.value : undefined,
  ];
  return candidates.map(Number).find((value) => Number.isFinite(value) && value > 0);
}

const MEDIA_NAME = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|m4v|mov|mkv|webm|avi)$/i;

export function mediaFilenameHint(source) {
  if (!source) return "";
  for (const name of ["image", "video", "file", "filename", "media", "path"]) {
    const value = mediaName(widget(source.node, name)?.value);
    if (value) return value;
  }
  for (const candidate of source.node?.widgets ?? []) {
    const value = mediaName(candidate?.value);
    if (value && MEDIA_NAME.test(value.split(/[?#]/, 1)[0])) return value;
  }
  for (const image of source.node?.imgs ?? []) {
    const value = mediaNameFromUrl(image?.currentSrc || image?.src);
    if (value) return value;
  }
  return "";
}

export async function resolveMatchHints(node, probe) {
  const widthSource = upstreamSource(node, "width");
  const heightSource = upstreamSource(node, "height");
  const imageSource = upstreamSource(node, "image");
  const result = {
    source_connected: Boolean(widthSource || heightSource || imageSource),
  };

  const width = numericOutputHint(widthSource);
  const height = numericOutputHint(heightSource);
  if (width) result.socket_width = width;
  if (height) result.socket_height = height;

  if (imageSource) {
    let info = imageSource.node?.__bonfireImageInfo;
    if (!info) {
      const name = mediaFilenameHint(imageSource);
      if (name) {
        try {
          info = await probe(name);
        } catch {
          // The link is still valid at runtime even when its file cannot be probed now.
        }
      }
    }
    if (Number(info?.width) > 0) result.image_width = Number(info.width);
    if (Number(info?.height) > 0) result.image_height = Number(info.height);
  }
  return result;
}
