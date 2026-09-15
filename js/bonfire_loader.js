import { api } from "../../scripts/api.js";
import { app, ComfyApp } from "../../scripts/app.js";

import * as backend from "./bonfire_api.js";
import { openBrowser } from "./bonfire_browser.js";
import { alignmentOptions, favouriteState, imageReadout } from "./bonfire_display.js";
import { loaderFieldVisibility } from "./bonfire_visibility.js";
import {
  acceptsImageFile,
  canonicalImageName,
  clipspaceImageSource,
  copyImageData,
  filesFromDataTransfer,
  imageFilesFromPasteEvent,
  sortImportFiles,
  openNodeContextMenu,
  openMaskForNode,
  parseQueue,
  queueAfterDeletion,
  queueAfterImageChange,
  initialQueueState,
  queueIndex,
  stepQueue,
  thumbnailSize,
} from "./bonfire_sources.js";
import {
  attachDisposables,
  installCanvasWheelForward,
  createNumberControl,
  createRevisionGate,
  createSelectControl,
  debounce,
  ensureNodeSize,
  findWidget,
  installSizeFloor,
  hideWidget,
  installOutputPreviewSuppression,
  measurePanelSize,
  observeWidgetValue,
  resetStaleCombos,
} from "./bonfire_widgets.js";

/**
 * Bonfire Image Loader's renderer-neutral interface.
 *
 * Hidden schema widgets remain the only stored state. The DOM controls below are views
 * over those widgets, so workflows and API queue serialization keep their public shape.
 */

const PARAMETER_WIDGETS = [
  "alignment",
  "custom_multiple",
  "resize_mode",
  "megapixels",
  "long_edge",
  "target_width",
  "target_height",
];
const HIDDEN_WIDGETS = ["image", "queue", ...PARAMETER_WIDGETS];

function element(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

async function uploadFile(file) {
  const body = new FormData();
  body.append("image", file, file.name);
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const result = await response.json();
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

function fullImageUrl(name) {
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input`);
}

function preparePreviewMedia(name) {
  const image = new Image();
  image.src = fullImageUrl(name);
  return image;
}

async function clipboardPng(blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("PNG encoding failed"))),
        "image/png"
      )
    );
  } finally {
    bitmap.close?.();
  }
}

export async function setupImageLoader(node) {
  if (node.__bonfireImageLoaderSetup) return;
  node.__bonfireImageLoaderSetup = true;
  const bag = attachDisposables(node);
  bag.add(() => delete node.__bonfireImageLoaderSetup);

  const imageWidget = findWidget(node, "image");
  const queueWidget = findWidget(node, "queue");
  if (!imageWidget || !queueWidget) {
    bag.dispose();
    return;
  }

  let config;
  let favourites;
  try {
    [config, favourites] = await Promise.all([
      backend.options(),
      backend.loadFavourites(),
    ]);
  } catch {
    bag.dispose();
    return;
  }
  if (bag.disposed) return;

  const supportedExtensions = config.extensions;
  const originalImageValues = imageWidget.options?.values;
  imageWidget.options = imageWidget.options ?? {};
  imageWidget.options.values = () => {
    const values = typeof originalImageValues === "function"
      ? originalImageValues()
      : originalImageValues ?? [];
    return ["", ...values.filter((value) => value !== "")];
  };
  for (const name of HIDDEN_WIDGETS) hideWidget(findWidget(node, name));

  const hadHideOutputImages = Object.prototype.hasOwnProperty.call(node, "hideOutputImages");
  const previousHideOutputImages = node.hideOutputImages;
  node.hideOutputImages = true;
  bag.add(installOutputPreviewSuppression(node));
  bag.add(() => {
    if (hadHideOutputImages) node.hideOutputImages = previousHideOutputImages;
    else delete node.hideOutputImages;
  });

  const staleReset = resetStaleCombos(node, ["alignment", "resize_mode"]);

  // --- layout ---------------------------------------------------------------
  const root = element("div", "bonfire-loader");

  const toolbar = element("div", "bonfire-actions bonfire-loader-toolbar");
  const browseButton = element("button", "bonfire-action", "Browse");
  const addButton = element("button", "bonfire-action", "Add files");
  const addFolderButton = element("button", "bonfire-action", "Add folder");
  const copyButton = element("button", "bonfire-action", "Copy");
  const pasteButton = element("button", "bonfire-action", "Paste");
  const maskButton = element("button", "bonfire-action", "Mask Editor");
  const navigation = element("span", "bonfire-navigation");
  const previousButton = element("button", "bonfire-step bonfire-nav-step", "‹");
  const position = element("span", "bonfire-position", "0 / 0");
  const nextButton = element("button", "bonfire-step bonfire-nav-step", "›");
  for (const button of [
    browseButton,
    addButton,
    addFolderButton,
    copyButton,
    pasteButton,
    maskButton,
    previousButton,
    nextButton,
  ]) {
    button.type = "button";
  }
  browseButton.title = "Browse images in ComfyUI's input library";
  addButton.title = "Upload image files and add them to this queue";
  addFolderButton.title = "Upload supported images from a folder and add them to this queue";
  copyButton.title = "Copy the current image to ComfyUI clipspace and the clipboard";
  pasteButton.title = "Paste the clipboard image into this queue";
  maskButton.title = "Open ComfyUI Mask Editor for the current image";
  previousButton.title = "Show the previous queued image";
  nextButton.title = "Show the next queued image";
  navigation.append(previousButton, position, nextButton);
  toolbar.append(
    browseButton,
    addButton,
    addFolderButton,
    copyButton,
    pasteButton,
    maskButton,
    navigation
  );

  const stage = element("div", "bonfire-stage");
  const preview = element("img", "bonfire-preview");
  preview.alt = "";
  const stageNote = element("div", "bonfire-stage-note");
  stage.append(preview, stageNote);

  const removeButton = element("button", "bonfire-action bonfire-row-action", "Remove");
  const favouriteButton = element("button", "bonfire-action bonfire-heart", "♡");
  removeButton.type = "button";
  favouriteButton.type = "button";
  removeButton.title = "Remove the current image from this node's queue (keeps the file)";

  const alignmentControl = createSelectControl({
    label: "Align",
    options: alignmentOptions(config.alignment_profiles),
    widget: findWidget(node, "alignment"),
    node,
    bag,
  });
  alignmentControl.element.classList.add("bonfire-align-row");
  alignmentControl.element.append(removeButton, favouriteButton);

  const resizeControl = createSelectControl({
    label: "Resize",
    options: config.resize_modes,
    widget: findWidget(node, "resize_mode"),
    node,
    bag,
  });

  const fields = element("div", "bonfire-fields");
  const controls = {
    custom_multiple: createNumberControl({
      label: "Multiple",
      widget: findWidget(node, "custom_multiple"),
      node,
      bag,
      min: 1,
      max: 1024,
    }),
    megapixels: createNumberControl({
      label: "Megapixels",
      widget: findWidget(node, "megapixels"),
      node,
      bag,
      min: 0.01,
      max: 64,
      step: 0.01,
      integer: false,
      buttonStep: 0.1,
    }),
    long_edge: createNumberControl({
      label: "Long edge",
      widget: findWidget(node, "long_edge"),
      node,
      bag,
      min: 8,
      max: config.limits.max_axis,
    }),
    target_width: createNumberControl({
      label: "Width",
      widget: findWidget(node, "target_width"),
      node,
      bag,
      min: 8,
      max: config.limits.max_axis,
    }),
    target_height: createNumberControl({
      label: "Height",
      widget: findWidget(node, "target_height"),
      node,
      bag,
      min: 8,
      max: config.limits.max_axis,
    }),
  };
  fields.append(...Object.values(controls).map((control) => control.element));

  const filePicker = element("input");
  filePicker.type = "file";
  filePicker.multiple = true;
  filePicker.accept = supportedExtensions.join(",");
  filePicker.hidden = true;
  const folderPicker = element("input");
  folderPicker.type = "file";
  folderPicker.hidden = true;
  folderPicker.setAttribute("webkitdirectory", "");
  folderPicker.setAttribute("directory", "");

  const readout = element("div", "bonfire-info-row");
  const readoutLabel = element("span", "bonfire-control-label", "Image");
  const readoutValue = element("span", "bonfire-info-value");
  const sourceInfo = element("span", "bonfire-info-source", "No image selected");
  const adjustment = element("span", "bonfire-adjustment");
  const adjustmentArrow = element("span", "bonfire-adjustment-arrow", "→");
  const targetInfo = element("span", "bonfire-info-target");
  adjustment.append(adjustmentArrow, targetInfo);
  adjustment.hidden = true;
  readoutValue.append(sourceInfo, adjustment);
  readout.append(readoutLabel, readoutValue);
  const warning = element("div", "bonfire-warning");
  warning.hidden = true;
  root.append(
    toolbar,
    stage,
    alignmentControl.element,
    resizeControl.element,
    fields,
    readout,
    warning,
    filePicker,
    folderPicker
  );

  const STAGE_MIN = 72;
  const savedSize = [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0];
  let sizingReady = false;
  function measureMin() {
    return measurePanelSize(root, {
      extraWidth: 32,
      nodeWidth: node.size?.[0],
      stageMin: STAGE_MIN,
    });
  }
  function applySizeFloor() {
    if (!sizingReady || (Number(node.size?.[0]) || 0) < 40) return;
    const min = measureMin();
    ensureNodeSize(node, {
      minWidth: min.minWidth,
      minHeight: min.minHeight,
    });
  }
  function applyModeVisibility() {
    const alignment = findWidget(node, "alignment")?.value;
    const mode = findWidget(node, "resize_mode")?.value;
    const visibility = loaderFieldVisibility(alignment, mode);
    for (const [name, control] of Object.entries(controls)) {
      control.element.hidden = !visibility[name];
    }
    fields.hidden = [...fields.children].every((child) => child.hidden);
    applySizeFloor();
  }
  applyModeVisibility();
  node.addDOMWidget("bonfire_ui", "BONFIRE_UI", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => {
      if ((Number(node.size?.[0]) || 0) < 40) return STAGE_MIN;
      return measureMin().minHeight;
    },
    afterResize() {
      applySizeFloor();
    },
    margin: 6,
  });
  bag.add(() => root.remove());
  installCanvasWheelForward(root, bag);
  if (savedSize[0] >= 40 && savedSize[1] >= 40) {
    node.size = savedSize;
    node.setSize?.(savedSize);
  }
  sizingReady = true;
  installSizeFloor(node, measureMin, bag);
  applySizeFloor();

  // --- queue state ----------------------------------------------------------
  const readQueue = () => parseQueue(queueWidget.value);

  function currentName() {
    const entries = readQueue();
    if (!entries.length) return "";
    const name = imageWidget.value;
    return queueIndex(entries, name) === -1 ? "" : name;
  }

  function writeQueue(entries) {
    queueWidget.value = JSON.stringify(parseQueue(JSON.stringify(entries)));
  }

  function setCurrent(name) {
    if (name === undefined || name === null) return;
    imageWidget.value = name;
    node.setDirtyCanvas(true, true);
  }

  function addNames(names) {
    const entries = readQueue();
    let added = null;
    for (const name of names) {
      if (!name) continue;
      const key = canonicalImageName(name);
      const existing = entries.find((entry) => canonicalImageName(entry) === key);
      if (!existing) entries.push(name);
      added = existing ?? name;
    }
    writeQueue(entries);
    if (added) setCurrent(added);
    refresh();
  }

  function step(offset) {
    const next = stepQueue(readQueue(), imageWidget.value, offset);
    if (next) setCurrent(next);
  }

  function removeCurrent() {
    const next = queueAfterDeletion(readQueue(), [imageWidget.value], imageWidget.value);
    writeQueue(next.queue);
    setCurrent(next.current);
  }

  async function chooseImage() {
    try {
      const picked = await openBrowser({
        favourites,
        onDeleted: (names) => {
          const next = queueAfterDeletion(readQueue(), names, imageWidget.value);
          writeQueue(next.queue);
          setCurrent(next.current);
          refresh();
        },
      });
      if (picked.length) addNames(picked);
      syncFavourite();
    } catch (error) {
      showWarning(error.message || "Could not open the image browser.", true);
    }
  }

  // --- readouts -------------------------------------------------------------
  function parameters() {
    const values = { name: currentName() };
    for (const name of PARAMETER_WIDGETS) {
      const found = findWidget(node, name);
      if (found) values[name] = found.value;
    }
    return values;
  }

  const staleMessage = staleReset.length
    ? `Saved by an older version of this node: ${staleReset
        .map((entry) => `${entry.name} was "${entry.was}"`)
        .join(", ")}. Reset to a valid option - check the other values too. Re-adding ` +
      "the node is the clean fix for an old positional save."
    : null;

  function showWarning(text, blocking = false) {
    const message = staleMessage ?? text;
    warning.textContent = message ?? "";
    warning.hidden = !message;
    warning.classList.toggle("is-blocking", Boolean(staleMessage) || blocking);
  }

  let thumbnailKey = "";
  const refreshThumbnail = debounce(() => {
    const name = currentName();
    if (!name) {
      thumbnailKey = "";
      preview.removeAttribute("src");
      stageNote.textContent = "Browse or add an image";
      stageNote.hidden = false;
      return;
    }
    const rect = stage.getBoundingClientRect();
    const size = thumbnailSize(
      rect.width,
      rect.height || STAGE_MIN,
      window.devicePixelRatio,
      config.limits.thumbnail_box_max
    );
    const nextKey = `${name}|${size}`;
    if (nextKey !== thumbnailKey) {
      thumbnailKey = nextKey;
      preview.src = backend.thumbnailUrl(name, size);
    }
    stageNote.textContent = "";
    stageNote.hidden = true;
  }, 80);
  bag.add(() => refreshThumbnail.cancel());

  const planGate = createRevisionGate();
  const refreshPlan = debounce(async () => {
    const revision = planGate.begin();
    const name = currentName();
    if (!name) {
      sourceInfo.textContent = "No image selected";
      adjustment.hidden = true;
      showWarning(null);
      return;
    }
    try {
      const info = await backend.plan(parameters());
      if (!planGate.isCurrent(revision) || name !== imageWidget.value || bag.disposed) return;
      node.__bonfireImageInfo = info;
      const display = imageReadout(name, info);
      sourceInfo.textContent = display.source;
      sourceInfo.title = display.source;
      targetInfo.textContent = display.target;
      targetInfo.title = display.target;
      adjustment.hidden = !display.target;
      showWarning(info.rejection || info.error || null, Boolean(info.rejection));
    } catch (error) {
      if (!planGate.isCurrent(revision) || bag.disposed) return;
      sourceInfo.textContent = String(name).split("/").pop();
      adjustment.hidden = true;
      showWarning(error.message, true);
    }
  }, 120);
  bag.add(() => {
    refreshPlan.cancel();
    planGate.invalidate();
    delete node.__bonfireImageInfo;
  });

  if (typeof ResizeObserver !== "undefined") {
    const stageObserver = new ResizeObserver(() => refreshThumbnail());
    stageObserver.observe(stage);
    bag.add(() => stageObserver.disconnect());
  }

  function syncFavourite() {
    const active = Boolean(imageWidget.value) && favourites.has(imageWidget.value);
    const state = favouriteState(active);
    favouriteButton.textContent = state.glyph;
    favouriteButton.title = state.label;
    favouriteButton.setAttribute("aria-label", state.label);
    favouriteButton.setAttribute("aria-pressed", String(active));
    favouriteButton.classList.toggle("is-active", active);
    favouriteButton.disabled = !imageWidget.value;
  }

  async function toggleFavourite() {
    const name = imageWidget.value;
    if (!name) return;
    const wasFavourite = favourites.has(name);
    if (wasFavourite) favourites.delete(name);
    else favourites.add(name);
    syncFavourite();
    if (!(await backend.saveFavourites(favourites))) {
      if (wasFavourite) favourites.add(name);
      else favourites.delete(name);
      syncFavourite();
      showWarning("Could not save favourites.");
    }
  }

  function refresh() {
    alignmentControl.sync();
    resizeControl.sync();
    for (const control of Object.values(controls)) control.sync();

    const entries = readQueue();
    const index = queueIndex(entries, imageWidget.value);
    position.textContent = entries.length ? `${index === -1 ? "-" : index + 1} / ${entries.length}` : "0 / 0";
    previousButton.disabled = index <= 0;
    nextButton.disabled = index === -1 || index >= entries.length - 1;
    removeButton.disabled = !entries.length;
    copyButton.disabled = !imageWidget.value;
    maskButton.disabled = !imageWidget.value;
    syncFavourite();
    refreshThumbnail();
    refreshPlan();
    applySizeFloor();
  }

  // --- input ----------------------------------------------------------------
  async function digestOf(file) {
    const bytes = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  async function importFile(file) {
    try {
      const digest = await digestOf(file);
      const found = await backend.locateDuplicate({ size: file.size, digest });
      if (found?.name) return found.name;
    } catch {
      // Lookup is an optimization; uploading still gets the image in.
    }
    return uploadFile(file);
  }

  async function addFiles(files) {
    const accepted = sortImportFiles(files).filter((candidate) =>
      acceptsImageFile(candidate, supportedExtensions)
    );
    if (!accepted.length) return false;
    const names = [];
    for (const file of accepted) {
      try {
        names.push(await importFile(file));
      } catch (error) {
        showWarning(error.message, true);
      }
    }
    if (names.length) addNames(names);
    return names.length > 0;
  }

  async function filesFromClipspace() {
    const src = clipspaceImageSource(ComfyApp.clipspace);
    if (!src) return [];
    const response = await fetch(src);
    if (!response.ok) return [];
    const blob = await clipboardPng(await response.blob());
    return [new File([blob], "pasted.png", { type: "image/png" })];
  }

  async function filesFromClipboardApi() {
    const started = Date.now();
    let delay = 120;
    let lastError = null;
    while (Date.now() - started < 8000) {
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        for (const item of items) {
          const type = item.types.find((candidate) => candidate.startsWith("image/"));
          if (!type) continue;
          const blob = await clipboardPng(await item.getType(type));
          files.push(new File([blob], "pasted.png", { type: blob.type || "image/png" }));
        }
        return files;
      } catch (error) {
        lastError = error;
        if (error?.name !== "NotAllowedError") throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay + 80, 320);
      }
    }
    throw lastError ?? new Error("Clipboard permission was not granted.");
  }

  bag.listen(browseButton, "click", chooseImage);
  bag.listen(previousButton, "click", () => step(-1));
  bag.listen(nextButton, "click", () => step(1));
  bag.listen(removeButton, "click", removeCurrent);
  bag.listen(favouriteButton, "click", toggleFavourite);
  bag.listen(addButton, "click", () => filePicker.click());
  bag.listen(addFolderButton, "click", () => folderPicker.click());
  bag.listen(filePicker, "change", () => {
    addFiles([...filePicker.files]);
    filePicker.value = "";
  });
  bag.listen(folderPicker, "change", async () => {
    const imported = await addFiles([...folderPicker.files]);
    folderPicker.value = "";
    if (!imported) showWarning("No supported images in that folder.");
  });

  bag.listen(copyButton, "click", async () => {
    if (!imageWidget.value) return;
    try {
      const selected = imageWidget.value;
      const image = preparePreviewMedia(selected);
      await copyImageData({
        node,
        image,
        copyToClipspace: (target) => ComfyApp.copyToClipspace(target),
        loadBlob: async () => {
          const response = await fetch(fullImageUrl(selected));
          if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
          return clipboardPng(await response.blob());
        },
        writeBlob: (png) => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]),
      });
    } catch {
      showWarning("The browser refused clipboard access.");
    }
  });

  bag.listen(pasteButton, "click", async () => {
    try {
      let files = [];
      try {
        files = await filesFromClipspace();
      } catch {
        files = [];
      }
      if (!files.length) files = await filesFromClipboardApi();
      if (!files.length) throw new Error("Clipboard has no image");
      const imported = await addFiles(files);
      if (!imported) throw new Error("Clipboard has no image");
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        showWarning("Allow clipboard access, then click Paste again.");
        return;
      }
      showWarning("Nothing usable on the clipboard.");
    }
  });
  bag.listen(document, "paste", (event) => {
    if (app.canvas?.current_node !== node && !node.is_selected) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
    }
    const files = imageFilesFromPasteEvent(event).filter((file) =>
      acceptsImageFile(file, supportedExtensions)
    );
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  bag.listen(maskButton, "click", async () => {
    if (!imageWidget.value) return;
    try {
      writeQueue(queueAfterImageChange(readQueue(), "", imageWidget.value));
      await openMaskForNode({
        node,
        image: preparePreviewMedia(imageWidget.value),
        canvas: app.canvas,
        execute: () => app.extensionManager?.command?.execute("Comfy.MaskEditor.OpenMaskEditor"),
      });
      node.hideOutputImages = true;
      refresh();
    } catch (error) {
      showWarning(error.message || "Could not open Mask Editor.", true);
    }
  });

  bag.listen(root, "dragover", (event) => {
    event.preventDefault();
    root.classList.add("is-dropping");
  });
  bag.listen(root, "dragleave", () => root.classList.remove("is-dropping"));
  bag.listen(root, "drop", async (event) => {
    event.preventDefault();
    root.classList.remove("is-dropping");
    try {
      const imported = await addFiles(await filesFromDataTransfer(event.dataTransfer));
      if (!imported) showWarning("No supported images in that drop.");
    } catch (error) {
      showWarning(error.message || "Could not read the dropped folder.", true);
    }
  });
  bag.listen(root, "contextmenu", (event) => {
    openNodeContextMenu({ event, node, canvas: app.canvas });
  });

  bag.listen(document, "keydown", (event) => {
    if (app.canvas?.current_node !== node && !node.is_selected) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  });

  // --- keeping in step with serialized widgets -----------------------------
  bag.add(
    observeWidgetValue(imageWidget, (next, previous) => {
      const queue = queueAfterImageChange(readQueue(), previous, next);
      if (JSON.stringify(queue) !== JSON.stringify(readQueue())) writeQueue(queue);
      refresh();
    })
  );
  bag.add(observeWidgetValue(queueWidget, refresh));
  for (const name of PARAMETER_WIDGETS) {
    const found = findWidget(node, name);
    if (!found) continue;
    bag.add(
      observeWidgetValue(found, () => {
        if (name === "alignment" || name === "resize_mode") applyModeVisibility();
        refresh();
      })
    );
  }

  const initial = initialQueueState(queueWidget.value, imageWidget.value);
  writeQueue(initial.queue);
  if (imageWidget.value !== initial.current) imageWidget.value = initial.current;
  applyModeVisibility();
  refresh();
}
