/**
 * Widget and lifecycle helpers.
 *
 * The version-sensitive parts of the interface are collected here, each with the reason
 * it looks the way it does, so none of it has to be rediscovered by reading two
 * renderers.
 */

export function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

/**
 * Hide a widget in whichever renderer is drawing the node.
 *
 * There is no single renderer-neutral flag on the frontend this pack targets (1.51.10).
 * The canvas renderer reads `widget.hidden` (litegraph LGraphNode.ts), while the Vue node
 * renderer reads `widget.options.hidden` (useGraphNodeManager.ts, useProcessedWidgets.ts).
 * Core's own painter extension sets only the latter, which is why its hiding does nothing
 * on a canvas-rendered graph.
 *
 * Both are declared public fields, so setting both is not reaching into internals -- it is
 * the only way to say "hidden" once and have it mean the same thing either way.
 */
export function hideWidget(widget) {
  setWidgetHidden(widget, true);
}

export function showWidget(widget) {
  setWidgetHidden(widget, false);
}

export function setWidgetHidden(widget, hidden) {
  if (!widget) return;
  widget.hidden = hidden;
  widget.options = widget.options ?? {};
  widget.options.hidden = hidden;
}

/**
 * Show only the widgets a mode actually uses.
 *
 * A control that does nothing in the current mode is worse than absent: it invites a
 * change that has no effect, and it makes the node taller for no reason.
 */
export function applyVisibility(node, visibility) {
  for (const [name, visible] of Object.entries(visibility)) {
    const widget = findWidget(node, name);
    if (!widget) continue;
    setWidgetHidden(widget, !visible);
  }
  node.setDirtyCanvas(true, true);
}

/** Convert backend option tables (or plain combo values) into one UI shape. */
export function optionEntries(options) {
  return (options ?? []).map((option) => {
    if (typeof option === "object" && option !== null) {
      const key = String(option.key ?? option.value ?? "");
      return { key, label: String(option.label ?? humanizeOption(key)) };
    }
    const key = String(option);
    return { key, label: humanizeOption(key) };
  });
}

export function humanizeOption(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bMp\b/g, "MP");
}

/** Clamp and write a number without giving ComfyUI an invalid intermediate value. */
export function normalizedWidgetNumber(widget, value, overrides = {}) {
  const options = widget?.options ?? {};
  const minimum = Number(overrides.min ?? options.min);
  const maximum = Number(overrides.max ?? options.max);
  const integer = overrides.integer ?? (widget?.type === "number" && options.precision === 0);
  let next = Number(value);
  if (!Number.isFinite(next)) next = Number(widget?.value) || 0;
  if (Number.isFinite(minimum)) next = Math.max(minimum, next);
  if (Number.isFinite(maximum)) next = Math.min(maximum, next);
  return integer ? Math.round(next) : next;
}

/**
 * Suppress the canvas renderer's native output preview for a node that draws its own.
 *
 * Frontend 1.51.10 honours hideOutputImages in the Vue renderer but not in the canvas
 * renderer. Its ordinary onDrawBackground path only manages the native image preview,
 * so an instance wrapper is the narrow compatibility adapter needed here.
 */
export function installOutputPreviewSuppression(node) {
  const hadOwn = Object.prototype.hasOwnProperty.call(node, "onDrawBackground");
  const descriptor = hadOwn
    ? Object.getOwnPropertyDescriptor(node, "onDrawBackground")
    : null;
  const previous = node.onDrawBackground;
  const wrapped = function (...args) {
    if (this.hideOutputImages) return undefined;
    return previous?.apply(this, args);
  };
  node.onDrawBackground = wrapped;

  return () => {
    if (node.onDrawBackground !== wrapped) return;
    if (descriptor) Object.defineProperty(node, "onDrawBackground", descriptor);
    else delete node.onDrawBackground;
  };
}

/** A tiny generation counter that prevents stale async responses repainting the UI. */
export function createRevisionGate() {
  let revision = 0;
  return {
    begin() {
      revision += 1;
      return revision;
    },
    isCurrent(candidate) {
      return candidate === revision;
    },
    invalidate() {
      revision += 1;
    },
  };
}

/** Build a compact labelled dropdown backed by one serialized combo widget. */
export function createSelectControl({ label, options, widget, node, bag, tooltip }) {
  const row = document.createElement("div");
  row.className = "bonfire-control-row bonfire-select-row";
  const caption = document.createElement("span");
  caption.className = "bonfire-control-label";
  caption.textContent = label;
  const shell = document.createElement("span");
  shell.className = "bonfire-select-shell";
  const select = document.createElement("select");
  select.className = "bonfire-select";
  select.setAttribute("aria-label", label);
  select.title = tooltip ?? widget?.options?.tooltip ?? `Choose ${label.toLowerCase()}`;
  const entries = optionEntries(options);
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    select.appendChild(option);
  }
  shell.appendChild(select);
  row.append(caption, shell);

  function sync() {
    if (select.value !== String(widget.value)) select.value = String(widget.value);
    fitSelectToOptions(select);
  }

  bag.listen(select, "change", () => {
    widget.value = select.value;
    fitSelectToOptions(select);
    node.setDirtyCanvas(true, true);
  });
  sync();
  return { element: row, select, shell, sync };
}

/** Size a native select to the label it is currently showing. */
export function fitSelectToOptions(select, { pad = 32, min = 52, max = 160 } = {}) {
  if (!select) return 0;
  const selected = select.selectedOptions?.[0]?.textContent ?? select.options[0]?.textContent ?? "";
  const width = selectContentWidth([selected], { pad, min, max });
  select.style.width = `${width}px`;
  return width;
}

export function selectContentWidth(labels, { pad = 32, min = 52, max = 160 } = {}) {
  const longest = Math.max(0, ...labels.map((label) => [...String(label)].length));
  return Math.min(max, Math.max(min, longest * 8 + pad));
}

export function panelMinHeight(root, { stageMin = 0, gap = 5, padding = 8 } = {}) {
  if (!root?.children) return stageMin + padding;
  const blocks = [...root.children].filter(
    (el) => !el.hidden && el.type !== "file"
  );
  if (!blocks.length) return stageMin + padding;
  const heights = blocks.map((el) => {
    if (el.classList?.contains("bonfire-stage")) {
      // The stage flex-grows to fill leftover node height. Using that stretched
      // height as a minimum would grow the node on every refresh.
      return stageMin;
    }
    return Math.max(Number(el.offsetHeight) || 0, Number(el.scrollHeight) || 0, 28);
  });
  return (
    padding + heights.reduce((sum, height) => sum + height, 0) + gap * (blocks.length - 1)
  );
}

export function ensureNodeSize(node, { minWidth, minHeight, maxWidth } = {}) {
  if (!node) return false;
  const width = Number(node.size?.[0]) || 0;
  const height = Number(node.size?.[1]) || 0;
  let nextWidth = Math.max(width, minWidth || 0);
  if (Number.isFinite(maxWidth) && nextWidth > maxWidth) nextWidth = Math.max(minWidth || 0, maxWidth);
  const nextHeight = Math.max(height, minHeight || 0);
  if (nextWidth === width && nextHeight === height) return false;
  node.size = [nextWidth, nextHeight];
  node.setSize?.(node.size);
  return true;
}

/** Intrinsic width of the panel when every row is allowed to wrap. */
export function compactMinWidth(root, extra = 28) {
  if (!root?.style) return extra;
  const previousWidth = root.style.width;
  const previousMin = root.style.minWidth;
  root.style.minWidth = "0px";
  root.style.width = "min-content";
  const width = Math.ceil(
    root.getBoundingClientRect?.().width || root.offsetWidth || 0
  );
  root.style.width = previousWidth;
  root.style.minWidth = previousMin;
  return Math.max(width, 0) + extra;
}

/**
 * Compact width plus the height of the panel at the node's current width.
 *
 * Height must be measured at the node width, not at min-content or 0: wrapping
 * rows (aspect cards, toolbars) stack into a tall column there, and treating
 * that as a minimum grows the node on every page refresh.
 */
export function measurePanelSize(root, { extraWidth = 28, nodeWidth = 0, stageMin = 0 } = {}) {
  const minWidth = compactMinWidth(root, extraWidth);
  if (!root?.style) return { minWidth, minHeight: stageMin + 8 };
  const previousWidth = root.style.width;
  const inner = Math.max(0, Math.floor(Number(nodeWidth) || 0) - extraWidth);
  if (inner > 0) root.style.width = `${inner}px`;
  const minHeight = panelMinHeight(root, { stageMin });
  root.style.width = previousWidth;
  return { minWidth, minHeight };
}

/** Prevent shrinking below wrapped content. Never read stretched 100% row widths. */
export function installSizeFloor(node, spec, bag) {
  if (!node) return () => {};
  const measure = typeof spec === "function" ? spec : () => spec;

  function clamp() {
    const min = measure() ?? {};
    return ensureNodeSize(node, {
      minWidth: min.minWidth ?? min.width,
      minHeight: min.minHeight ?? min.height,
    });
  }

  const previousResize = node.onResize;
  function wrappedResize(...args) {
    const result = previousResize?.apply(this, args);
    clamp();
    return result;
  }
  node.onResize = wrappedResize;

  const stop = () => {
    if (node.onResize === wrappedResize) node.onResize = previousResize;
  };
  bag?.add(stop);
  clamp();
  return stop;
}

/** Build a compact numeric editor backed directly by one serialized widget. */
export function createNumberControl({
  label,
  widget,
  node,
  bag,
  min,
  max,
  step = 1,
  integer = true,
  buttonStep = null,
  buttonLayout = "sides",
  suffix = "",
  tooltip,
}) {
  const row = document.createElement("div");
  row.className = "bonfire-control-row bonfire-number-row";
  const caption = document.createElement("span");
  caption.className = "bonfire-control-label";
  caption.textContent = label;
  const editor = document.createElement("span");
  editor.className = "bonfire-number-editor";
  const input = document.createElement("input");
  input.className = "bonfire-number-input";
  input.type = "text";
  input.inputMode = integer ? "numeric" : "decimal";
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  input.title = tooltip ?? widget?.options?.tooltip ?? `Enter ${label.toLowerCase()}`;
  const suffixLabel = suffix ? document.createElement("span") : null;
  if (suffixLabel) {
    suffixLabel.className = "bonfire-number-suffix";
    suffixLabel.textContent = suffix;
  }

  let decrement = null;
  let increment = null;
  if (Number.isFinite(buttonStep)) {
    decrement = document.createElement("button");
    increment = document.createElement("button");
    for (const button of [decrement, increment]) {
      button.className = "bonfire-step bonfire-number-step";
      button.type = "button";
    }
    decrement.textContent = "−";
    increment.textContent = "+";
    decrement.setAttribute("aria-label", `Decrease ${label}`);
    increment.setAttribute("aria-label", `Increase ${label}`);
    decrement.title = `Decrease ${label}`;
    increment.title = `Increase ${label}`;
    if (buttonLayout === "vertical") {
      editor.classList.add("has-vertical-steps");
      const steppers = document.createElement("span");
      steppers.className = "bonfire-vertical-steps";
      increment.textContent = "⌃";
      decrement.textContent = "⌄";
      steppers.append(increment, decrement);
      editor.append(input);
      if (suffixLabel) editor.appendChild(suffixLabel);
      editor.appendChild(steppers);
    } else {
      editor.append(decrement, input);
      if (suffixLabel) editor.appendChild(suffixLabel);
      editor.appendChild(increment);
    }
  } else {
    editor.appendChild(input);
    if (suffixLabel) editor.appendChild(suffixLabel);
  }
  row.append(caption, editor);

  function sync() {
    if (document.activeElement !== input) input.value = String(widget.value);
  }

  function commit() {
    widget.value = normalizedWidgetNumber(widget, input.value, { min, max, integer });
    input.value = String(widget.value);
    node.setDirtyCanvas(true, true);
  }

  function move(delta) {
    const current = Number(widget.value);
    const decimals = String(step).split(".")[1]?.length ?? 0;
    const scale = 10 ** decimals;
    const candidate =
      Math.round(((Number.isFinite(current) ? current : Number(min) || 0) + delta) * scale) /
      scale;
    widget.value = normalizedWidgetNumber(
      widget,
      candidate,
      { min, max, integer }
    );
    input.value = String(widget.value);
    node.setDirtyCanvas(true, true);
  }

  bag.listen(input, "change", commit);
  bag.listen(input, "keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
    input.blur();
  });
  if (decrement && increment) {
    bag.listen(decrement, "click", () => move(-buttonStep));
    bag.listen(increment, "click", () => move(buttonStep));
  }
  sync();
  return { element: row, input, decrement, increment, sync };
}

/**
 * A combo value that is not one of the options this version offers.
 *
 * Restoring a workflow saved by an older version of a node puts its old values straight
 * back onto the widgets, positionally. Detecting that is the difference between an
 * actionable message and a confusing backend error about a value nobody typed.
 */
export function staleComboValue(widget) {
  if (!widget) return null;
  const raw = widget.options?.values;
  const values = typeof raw === "function" ? raw() : raw;
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.includes(widget.value) ? null : widget.value;
}

/**
 * Reset any stale combo to its first valid option, and report what was changed.
 *
 * Deliberately does not translate old values into new ones. Guessing what a value from a
 * previous implementation was supposed to mean is how a "compatibility shim" starts, and
 * a positional restore has usually shifted the other values anyway -- the node needs
 * re-adding, and saying so plainly is more use than a silent repair.
 */
export function resetStaleCombos(node, names) {
  const reset = [];
  for (const name of names) {
    const widget = findWidget(node, name);
    const stale = staleComboValue(widget);
    if (stale === null) continue;
    const raw = widget.options?.values;
    const values = typeof raw === "function" ? raw() : raw;
    widget.value = values[0];
    reset.push({ name, was: stale, now: values[0] });
  }
  return reset;
}

/**
 * Call `onChange` whenever something assigns to `widget.value`.
 *
 * This watches the property rather than hooking whatever writes it, deliberately. On
 * 1.51.10 the Mask Editor saves by plain assignment with no callback
 * (useMaskEditorSaver.ts: `imageWidget.value = widgetValue`), and the
 * `writeImageWidgetValue` adapter only appears in 1.53.4. Watching the property works on
 * both, because both end in an assignment.
 *
 * Returns a function that restores the original property.
 */
export function observeWidgetValue(widget, onChange) {
  const original = Object.getOwnPropertyDescriptor(widget, "value");
  let stored = widget.value;

  const read = original?.get ? () => original.get.call(widget) : () => stored;
  const write = original?.set
    ? (next) => original.set.call(widget, next)
    : (next) => {
        stored = next;
      };

  Object.defineProperty(widget, "value", {
    configurable: true,
    enumerable: true,
    get: read,
    set(next) {
      const previous = read();
      write(next);
      if (previous !== next) onChange(next, previous);
    },
  });

  return () => {
    const current = read();
    if (original) {
      Object.defineProperty(widget, "value", original);
      if (!original.get) widget.value = current;
    } else {
      Object.defineProperty(widget, "value", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: current,
      });
    }
  };
}

/**
 * A bag of teardown functions tied to one node.
 *
 * Every listener, observer and timer the interface creates is registered here and undone
 * when the node is removed. A graph gets nodes added and deleted all session; anything
 * left behind keeps firing against a node that no longer exists.
 */
export class Disposables {
  constructor() {
    this.entries = [];
    this.disposed = false;
  }

  add(dispose) {
    if (typeof dispose === "function") this.entries.push(dispose);
    return dispose;
  }

  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    return this.add(() => target.removeEventListener(event, handler, options));
  }

  timeout(handler, delay) {
    const id = setTimeout(handler, delay);
    this.add(() => clearTimeout(id));
    return id;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Reverse order, so a teardown never runs after something it depends on is gone.
    for (const entry of this.entries.reverse()) {
      try {
        entry();
      } catch (error) {
        console.error("[Bonfire] cleanup failed", error);
      }
    }
    this.entries = [];
  }
}

/**
 * DOM widgets sit on top of the LiteGraph canvas, so a wheel over them never
 * reaches the zoom handler. Forward it unless the event already came from the canvas.
 */
export function installCanvasWheelForward(element, bag) {
  if (!element || !bag) return;
  bag.listen(
    element,
    "wheel",
    (event) => {
      const canvas = globalThis.app?.canvas?.canvas;
      if (!canvas || event.target === canvas) return;
      event.preventDefault();
      event.stopPropagation();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        })
      );
    },
    { passive: false, capture: true }
  );
}

/**
 * Run `onChange` after layout and whenever `element` is resized.
 *
 * The Shot aspect grid wraps by width. A refresh can paint one frame with the
 * old overlay box, so the wrap-edge card (9:16) sits in a clipped gap until
 * something else forces a redraw.
 */
export function watchPanelLayout(element, onChange, bag) {
  if (!element || typeof onChange !== "function" || !bag) return;
  const schedule = globalThis.requestAnimationFrame?.bind(globalThis) ?? ((fn) => setTimeout(fn, 0));
  const cancel = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout;
  let pending = 0;
  const notify = () => {
    if (pending) return;
    pending = schedule(() => {
      pending = 0;
      onChange();
    });
  };
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(notify);
    observer.observe(element);
    bag.add(() => observer.disconnect());
  }
  const startup = schedule(notify);
  bag.add(() => {
    cancel(startup);
    if (pending) cancel(pending);
  });
}

/** Attach a cleanup bag to a node, disposed when the node is removed. */
export function attachDisposables(node) {
  const bag = new Disposables();
  const previous = node.onRemoved;
  node.onRemoved = function (...args) {
    bag.dispose();
    return previous?.apply(this, args);
  };
  return bag;
}

/** Collapse a burst of calls into one, trailing edge. */
export function debounce(fn, delay = 120) {
  let handle = null;
  const wrapped = (...args) => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, delay);
  };
  wrapped.cancel = () => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
  };
  return wrapped;
}

/** Load a stylesheet that sits next to this module, once. */
export function loadStylesheet(filename) {
  const href = new URL(filename, import.meta.url).href;
  if (document.querySelector(`link[data-bonfire="${filename}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.bonfire = filename;
  document.head.appendChild(link);
}

/** Read a widget value, falling back when the widget is absent. */
export function widgetValue(node, name, fallback = undefined) {
  const widget = findWidget(node, name);
  return widget ? widget.value : fallback;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
