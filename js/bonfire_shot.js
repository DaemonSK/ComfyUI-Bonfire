import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

import * as backend from "./bonfire_api.js";
import {
  alignmentOptions,
  frameCountReadout,
  shotSizeReadout,
} from "./bonfire_display.js";
import {
  installUpstreamWatch,
  openNodeContextMenu,
  resolveMatchHints,
} from "./bonfire_sources.js";
import { shotFieldVisibility } from "./bonfire_visibility.js";
import {
  attachDisposables,
  createNumberControl,
  createRevisionGate,
  createSelectControl,
  debounce,
  ensureNodeSize,
  findWidget,
  installSizeFloor,
  hideWidget,
  measurePanelSize,
  observeWidgetValue,
  resetStaleCombos,
} from "./bonfire_widgets.js";

/**
 * Bonfire Shot's compact interface. Schema widgets stay serialized but hidden; the
 * responsive controls below are their only visual representation.
 */

const WATCHED_WIDGETS = [
  "resolution_mode",
  "alignment",
  "custom_multiple",
  "aspect_ratio",
  "megapixels",
  "custom_width",
  "custom_height",
  "seconds",
  "fps",
];

function element(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

/** A small box drawn at the ratio itself, so the cards read at a glance. */
function ratioGlyph(ratio) {
  const glyph = element("span", "bonfire-ratio-glyph");
  const scale = 22 / Math.max(ratio.width, ratio.height);
  glyph.style.width = `${Math.max(6, ratio.width * scale)}px`;
  glyph.style.height = `${Math.max(6, ratio.height * scale)}px`;
  return glyph;
}

export async function setupShot(node) {
  if (node.__bonfireShotSetup) return;
  node.__bonfireShotSetup = true;
  const bag = attachDisposables(node);
  bag.add(() => delete node.__bonfireShotSetup);

  const secondsWidget = findWidget(node, "seconds");
  const ratioWidget = findWidget(node, "aspect_ratio");
  if (!secondsWidget || !ratioWidget) {
    bag.dispose();
    return;
  }

  let config;
  try {
    config = await backend.options();
  } catch {
    bag.dispose();
    return;
  }
  if (bag.disposed) return;

  for (const name of WATCHED_WIDGETS) hideWidget(findWidget(node, name));
  const staleReset = resetStaleCombos(node, [
    "resolution_mode",
    "alignment",
    "aspect_ratio",
  ]);

  const root = element("div", "bonfire-shot");

  const alignmentControl = createSelectControl({
    label: "Align",
    options: alignmentOptions(config.alignment_profiles),
    widget: findWidget(node, "alignment"),
    node,
    bag,
  });
  const modeControl = createSelectControl({
    label: "Resolution",
    options: config.resolution_modes,
    widget: findWidget(node, "resolution_mode"),
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
    custom_width: createNumberControl({
      label: "Width",
      widget: findWidget(node, "custom_width"),
      node,
      bag,
      min: 1,
      max: config.limits.max_axis,
    }),
    custom_height: createNumberControl({
      label: "Height",
      widget: findWidget(node, "custom_height"),
      node,
      bag,
      min: 1,
      max: config.limits.max_axis,
    }),
  };
  fields.append(...Object.values(controls).map((control) => control.element));

  const ratioRow = element("div", "bonfire-ratios");
  const ratioButtons = new Map();
  for (const ratio of config.aspect_ratios) {
    const button = element("button", "bonfire-ratio");
    button.type = "button";
    button.title = `${ratio.label} (${ratio.value.toFixed(2)}:1)`;
    button.append(ratioGlyph(ratio), element("span", "bonfire-ratio-label", ratio.label));
    bag.listen(button, "click", () => {
      ratioWidget.value = ratio.key;
      node.setDirtyCanvas(true, true);
    });
    ratioRow.appendChild(button);
    ratioButtons.set(ratio.key, button);
  }

  const secondsControl = createNumberControl({
    label: "Duration",
    widget: secondsWidget,
    node,
    bag,
    min: config.limits.seconds_min,
    max: config.limits.seconds_max,
    step: 0.1,
    integer: false,
    buttonStep: 1,
    suffix: "s",
  });
  const frameCount = element("span", "bonfire-frame-count");
  secondsControl.element.appendChild(frameCount);
  const fpsControl = createNumberControl({
    label: "FPS",
    widget: findWidget(node, "fps"),
    node,
    bag,
    min: config.limits.fps_min,
    max: config.limits.fps_max,
    buttonStep: 1,
    buttonLayout: "vertical",
  });
  fields.append(secondsControl.element, fpsControl.element);

  const modeOptions = element("div", "bonfire-mode-options");
  modeOptions.append(ratioRow, fields);

  const readout = element("div", "bonfire-info-row");
  const readoutLabel = element("span", "bonfire-control-label", "Size");
  const readoutValue = element("span", "bonfire-info-value", "Calculating…");
  readout.append(readoutLabel, readoutValue);
  const warning = element("div", "bonfire-warning");
  warning.hidden = true;
  root.append(
    alignmentControl.element,
    modeControl.element,
    modeOptions,
    readout,
    warning
  );

  const savedSize = [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0];
  let sizingReady = false;
  function measureMin() {
    return measurePanelSize(root, { extraWidth: 32, nodeWidth: node.size?.[0] });
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
    const mode = findWidget(node, "resolution_mode")?.value;
    const alignment = findWidget(node, "alignment")?.value;
    const visibility = shotFieldVisibility(mode, alignment);
    for (const [name, control] of Object.entries(controls)) {
      control.element.hidden = !visibility[name];
    }
    fields.hidden = [...fields.children].every((child) => child.hidden);
    ratioRow.hidden = !visibility.aspect_cards;
    modeOptions.hidden = fields.hidden && ratioRow.hidden;
    applySizeFloor();
  }
  applyModeVisibility();
  node.addDOMWidget("bonfire_shot_ui", "BONFIRE_UI", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => {
      if ((Number(node.size?.[0]) || 0) < 40) return 80;
      return measureMin().minHeight;
    },
    afterResize() {
      applySizeFloor();
    },
    margin: 6,
  });
  bag.add(() => root.remove());
  if (savedSize[0] >= 40 && savedSize[1] >= 40) {
    node.size = savedSize;
    node.setSize?.(savedSize);
  }
  sizingReady = true;
  installSizeFloor(node, measureMin, bag);
  applySizeFloor();
  bag.listen(root, "contextmenu", (event) => {
    openNodeContextMenu({ event, node, canvas: app.canvas });
  });

  function paintRatios() {
    for (const [key, button] of ratioButtons) {
      const active = key === ratioWidget.value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  async function parameters() {
    const values = {};
    for (const name of WATCHED_WIDGETS) {
      const found = findWidget(node, name);
      if (found) values[name] = found.value;
    }
    values.resolution_mode = values.resolution_mode ?? "aspect_mp";
    if (values.resolution_mode === "match_input") {
      Object.assign(values, await resolveMatchHints(node, backend.probe));
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

  const shotGate = createRevisionGate();
  const refresh = debounce(async () => {
    const revision = shotGate.begin();
    modeControl.sync();
    alignmentControl.sync();
    secondsControl.sync();
    fpsControl.sync();
    for (const control of Object.values(controls)) control.sync();
    paintRatios();

    try {
      const info = await backend.shot(await parameters());
      if (!shotGate.isCurrent(revision) || bag.disposed) return;
      readoutValue.textContent = shotSizeReadout(info);
      readoutValue.title = readoutValue.textContent;
      frameCount.textContent = frameCountReadout(info);
      frameCount.title = info.frames
        ? `${info.actual_seconds}s actual at ${info.fps} FPS${
            info.snapped ? `; ${info.raw_frames} requested frames before alignment` : ""
          }`
        : "";
      const problem = info.size_error || info.duration_error || info.warning || null;
      showWarning(problem, Boolean(info.size_error || info.duration_error));
      applySizeFloor();
    } catch (error) {
      if (!shotGate.isCurrent(revision) || bag.disposed) return;
      readoutValue.textContent = "Size unavailable";
      frameCount.textContent = "";
      showWarning(error.message, true);
      applySizeFloor();
    }
  }, 120);
  bag.add(() => {
    refresh.cancel();
    shotGate.invalidate();
  });

  for (const name of WATCHED_WIDGETS) {
    const found = findWidget(node, name);
    if (!found) continue;
    bag.add(
      observeWidgetValue(found, () => {
        if (name === "resolution_mode" || name === "alignment") applyModeVisibility();
        if (name === "aspect_ratio") paintRatios();
        refresh();
      })
    );
  }

  bag.add(installUpstreamWatch(node, refresh));
  const executed = () => refresh();
  api.addEventListener?.("executed", executed);
  bag.add(() => api.removeEventListener?.("executed", executed));

  applyModeVisibility();
  paintRatios();
  refresh();
}
