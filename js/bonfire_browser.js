import * as backend from "./bonfire_api.js";
import { favouriteState, nextBatchEnd } from "./bonfire_display.js";
import { Disposables, formatBytes } from "./bonfire_widgets.js";

/**
 * The input-directory browser.
 *
 * Opens a modal, resolves with the names the user picked, or an empty array if they
 * closed it. Every listener and observer it creates belongs to one `Disposables` bag
 * that is emptied when the dialog closes, so reopening it does not accumulate anything.
 *
 * Thumbnails are loaded lazily through an IntersectionObserver. With several hundred
 * images in the input folder, requesting every thumbnail on open would queue hundreds of
 * decodes for pictures the user will never scroll to.
 */

const THUMBNAIL_BOX = 192;
const TILE_BATCH = 96;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function openBrowser({ favourites, onDeleted = () => {} }) {
  const config = await backend.options();
  const bag = new Disposables();

  let entries = [];
  let filtered = [];
  let focusIndex = 0;
  const selected = new Set();

  const overlay = element("div", "bonfire-overlay");
  const dialog = element("div", "bonfire-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Browse input images");
  overlay.appendChild(dialog);

  // --- toolbar -------------------------------------------------------------
  const toolbar = element("div", "bonfire-toolbar");

  const search = element("input", "bonfire-search");
  search.type = "search";
  search.placeholder = "Filter by folder or filename";
  search.setAttribute("aria-label", "Filter images");
  search.title = "Filter by any part of the folder path or filename";

  const sortSelect = element("select", "bonfire-sort");
  sortSelect.setAttribute("aria-label", "Sort images");
  sortSelect.title = "Choose how the image library is sorted";
  for (const mode of config.sort_modes) {
    const option = element("option", null, mode.label);
    option.value = mode.key;
    sortSelect.appendChild(option);
  }

  function defaultDescending(mode) {
    const found = config.sort_modes.find((entry) => entry.key === mode);
    if (typeof found?.default_descending === "boolean") return found.default_descending;
    return mode !== "name";
  }

  let descending = defaultDescending(sortSelect.value);
  const sortDir = element("button", "bonfire-sort-dir", "↓");
  sortDir.type = "button";

  function paintSortDir() {
    sortDir.textContent = descending ? "↓" : "↑";
    const mode = sortSelect.value;
    let title = descending ? "Descending" : "Ascending";
    if (mode === "modified") title = descending ? "Latest modified first" : "Oldest modified first";
    else if (mode === "size") title = descending ? "Largest first" : "Smallest first";
    else if (mode === "name") title = descending ? "Z to A" : "A to Z";
    sortDir.title = title;
    sortDir.setAttribute("aria-label", title);
  }
  paintSortDir();

  const favouritesOnly = element("label", "bonfire-toggle");
  const favouritesCheck = element("input");
  favouritesCheck.type = "checkbox";
  favouritesCheck.title = "Show favourites only";
  favouritesOnly.append(favouritesCheck, document.createTextNode(" Favourites"));

  const duplicatesOnly = element("label", "bonfire-toggle");
  const duplicatesCheck = element("input");
  duplicatesCheck.type = "checkbox";
  duplicatesCheck.title = "Show duplicate images only";
  duplicatesOnly.append(duplicatesCheck, document.createTextNode(" Duplicates"));

  const count = element("span", "bonfire-count");
  const closeButton = element("button", "bonfire-close", "Close");
  closeButton.type = "button";
  closeButton.title = "Close the image browser without adding anything";

  toolbar.append(
    search,
    sortSelect,
    sortDir,
    favouritesOnly,
    duplicatesOnly,
    count,
    closeButton
  );

  const grid = element("div", "bonfire-grid");
  grid.setAttribute("role", "listbox");
  grid.tabIndex = 0;

  const footer = element("div", "bonfire-footer");
  const hint = element(
    "span",
    "bonfire-hint",
    "Arrows move - Space selects - Enter adds - Esc closes"
  );
  const addButton = element("button", "bonfire-add", "Add selected");
  const favouriteSelectedButton = element("button", "bonfire-action", "Favourite selected");
  const deleteSelectedButton = element("button", "bonfire-action bonfire-delete", "Delete selected");
  for (const button of [addButton, favouriteSelectedButton, deleteSelectedButton]) {
    button.type = "button";
  }
  addButton.title = "Add every selected image to the node queue";
  favouriteSelectedButton.title = "Add or remove all selected images from favourites";
  deleteSelectedButton.title = "Permanently delete the selected image files from disk";
  const footerActions = element("span", "bonfire-footer-actions");
  footerActions.append(favouriteSelectedButton, deleteSelectedButton, addButton);
  footer.append(hint, footerActions);

  dialog.append(toolbar, grid, footer);

  // --- lazy thumbnails -----------------------------------------------------
  const observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        const image = record.target;
        if (image.dataset.loaded === "true") continue;
        image.dataset.loaded = "true";
        image.src = backend.thumbnailUrl(image.dataset.name, THUMBNAIL_BOX);
        observer.unobserve(image);
      }
    },
    { root: grid, rootMargin: "300px" }
  );
  bag.add(() => observer.disconnect());

  // --- rendering -----------------------------------------------------------
  let tiles = [];

  function paintFavourite(button, name) {
    const active = favourites.has(name);
    const state = favouriteState(active);
    button.textContent = state.glyph;
    button.title = state.label;
    button.setAttribute("aria-label", `${state.label}: ${name}`);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  }

  function repaintFavourites() {
    for (const tile of tiles) {
      const button = tile.querySelector(".bonfire-favourite");
      if (button) paintFavourite(button, tile.dataset.name);
    }
  }

  async function toggleSelectedFavourites() {
    if (!selected.size) return;
    const names = [...selected];
    const remove = names.every((name) => favourites.has(name));
    const before = new Set(favourites);
    for (const name of names) {
      if (remove) favourites.delete(name);
      else favourites.add(name);
    }
    repaintFavourites();
    if (!(await backend.saveFavourites(favourites))) {
      favourites.clear();
      for (const name of before) favourites.add(name);
      repaintFavourites();
      return;
    }
    if (favouritesCheck.checked) applyFilter();
    else paint();
  }

  async function deleteNames(names) {
    const chosen = [...new Set(names)].filter(Boolean);
    if (!chosen.length) return;
    const description =
      chosen.length === 1
        ? `Delete “${chosen[0]}” from disk?\n\nThis cannot be undone.`
        : `Delete ${chosen.length} selected images from disk?\n\nThis cannot be undone.`;
    if (!window.confirm(description)) return;

    deleteSelectedButton.disabled = true;
    try {
      const result = await backend.deleteImages(chosen);
      const deleted = new Set(result.deleted ?? []);
      if (deleted.size) {
        entries = entries.filter((entry) => !deleted.has(entry.name));
        for (const name of deleted) {
          selected.delete(name);
          favourites.delete(name);
        }
        await backend.saveFavourites(favourites);
        onDeleted([...deleted]);
      }
      const failures = Object.entries(result.errors ?? {});
      if (failures.length) {
        window.alert(`Could not delete:\n${failures.map(([name]) => name).join("\n")}`);
      }
      applyFilter();
    } catch (error) {
      window.alert(`Could not delete the selected images: ${error.message}`);
    } finally {
      paint();
    }
  }

  function appendBatch() {
    if (tiles.length >= filtered.length) return;
    const end = nextBatchEnd(tiles.length, filtered.length, TILE_BATCH);
    for (let index = tiles.length; index < end; index += 1) {
      const entry = filtered[index];
      const tile = element("div", "bonfire-tile");
      tile.setAttribute("role", "option");
      tile.dataset.name = entry.name;

      const frame = element("div", "bonfire-thumb");
      const image = element("img");
      image.alt = entry.filename;
      image.loading = "lazy";
      image.dataset.name = entry.name;
      const unavailable = element("span", "bonfire-thumb-status", "Preview unavailable");
      unavailable.hidden = true;
      image.addEventListener("load", () => {
        frame.classList.remove("is-error");
        unavailable.hidden = true;
      });
      image.addEventListener("error", () => {
        frame.classList.add("is-error");
        unavailable.hidden = false;
      });
      frame.append(image, unavailable);
      observer.observe(image);

      const favourite = element("button", "bonfire-favourite");
      favourite.type = "button";
      paintFavourite(favourite, entry.name);
      favourite.addEventListener("click", async (event) => {
        event.stopPropagation();
        favourite.disabled = true;
        if (favourites.has(entry.name)) favourites.delete(entry.name);
        else favourites.add(entry.name);
        paintFavourite(favourite, entry.name);
        const saved = await backend.saveFavourites(favourites);
        favourite.disabled = false;
        if (!saved) {
          if (favourites.has(entry.name)) favourites.delete(entry.name);
          else favourites.add(entry.name);
          paintFavourite(favourite, entry.name);
          return;
        }
        if (favouritesCheck.checked) applyFilter();
      });

      const remove = element("button", "bonfire-tile-delete", "×");
      remove.type = "button";
      remove.title = `Delete ${entry.filename} from disk`;
      remove.setAttribute("aria-label", `Delete ${entry.name} from disk`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteNames([entry.name]);
      });

      const label = element("div", "bonfire-label");
      label.append(
        element("span", "bonfire-name", entry.filename),
        element(
          "span",
          "bonfire-meta",
          `${entry.folder ? `${entry.folder} - ` : ""}${formatBytes(entry.size_bytes)}`
        )
      );

      tile.append(frame, remove, favourite, label);
      if (entry.duplicate) {
        tile.classList.add("is-duplicate");
        const badge = element("span", "bonfire-duplicate-badge", "Duplicate");
        badge.title = "Same image as another file in this library";
        tile.appendChild(badge);
      }
      tile.addEventListener("click", () => {
        focusIndex = index;
        toggle(entry.name);
      });
      tile.addEventListener("dblclick", () => finish([entry.name]));

      grid.appendChild(tile);
      tiles.push(tile);
    }

    paint();
  }

  function render() {
    observer.disconnect();
    grid.replaceChildren();
    tiles = [];
    appendBatch();
  }

  function paint() {
    tiles.forEach((tile, index) => {
      tile.classList.toggle("is-selected", selected.has(tile.dataset.name));
      tile.classList.toggle("is-focused", index === focusIndex);
      tile.setAttribute("aria-selected", String(selected.has(tile.dataset.name)));
    });
    count.textContent = `${filtered.length} of ${entries.length}`;
    addButton.disabled = selected.size === 0;
    favouriteSelectedButton.disabled = selected.size === 0;
    deleteSelectedButton.disabled = selected.size === 0;
    const allFavourite =
      selected.size > 0 && [...selected].every((name) => favourites.has(name));
    favouriteSelectedButton.textContent = allFavourite
      ? "Unfavourite selected"
      : "Favourite selected";
    addButton.textContent = selected.size
      ? `Add ${selected.size} image${selected.size === 1 ? "" : "s"}`
      : "Add selected";
  }

  function toggle(name) {
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    paint();
  }

  function applyFilter() {
    const query = search.value.trim().toLowerCase();
    filtered = entries.filter((entry) => {
      if (favouritesCheck.checked && !favourites.has(entry.name)) return false;
      if (duplicatesCheck.checked && !entry.duplicate) return false;
      return !query || entry.name.toLowerCase().includes(query);
    });
    focusIndex = Math.min(focusIndex, Math.max(0, filtered.length - 1));
    render();
  }

  async function reload() {
    count.textContent = "Loading...";
    try {
      const body = await backend.listImages({
        sort: sortSelect.value,
        descending,
      });
      entries = body.images;
      applyFilter();
    } catch (error) {
      grid.replaceChildren(
        element("div", "bonfire-empty", `Could not list images: ${error.message}`)
      );
      count.textContent = "";
    }
  }

  function moveFocus(delta) {
    if (!filtered.length) return;
    focusIndex = Math.max(0, Math.min(filtered.length - 1, focusIndex + delta));
    while (focusIndex >= tiles.length && tiles.length < filtered.length) appendBatch();
    paint();
    tiles[focusIndex]?.scrollIntoView({ block: "nearest" });
  }

  function columns() {
    if (!tiles.length) return 1;
    const gridWidth = grid.clientWidth || 1;
    const tileWidth = tiles[0].offsetWidth || gridWidth;
    return Math.max(1, Math.floor(gridWidth / tileWidth));
  }

  // --- resolution ----------------------------------------------------------
  let settle;
  const result = new Promise((resolve) => {
    settle = resolve;
  });

  function finish(names) {
    bag.dispose();
    overlay.remove();
    settle(names);
  }

  bag.listen(search, "input", applyFilter);
  bag.listen(sortSelect, "change", () => {
    descending = defaultDescending(sortSelect.value);
    paintSortDir();
    reload();
  });
  bag.listen(sortDir, "click", () => {
    descending = !descending;
    paintSortDir();
    reload();
  });
  bag.listen(favouritesCheck, "change", applyFilter);
  bag.listen(duplicatesCheck, "change", applyFilter);
  bag.listen(grid, "scroll", () => {
    if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) appendBatch();
  });
  bag.listen(closeButton, "click", () => finish([]));
  bag.listen(addButton, "click", () => finish([...selected]));
  bag.listen(favouriteSelectedButton, "click", toggleSelectedFavourites);
  bag.listen(deleteSelectedButton, "click", () => deleteNames([...selected]));
  bag.listen(overlay, "mousedown", (event) => {
    if (event.target === overlay) finish([]);
  });

  bag.listen(document, "keydown", (event) => {
    if (!document.body.contains(overlay)) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        finish([]);
        break;
      case "ArrowRight":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(columns());
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-columns());
        break;
      case " ":
      case "Spacebar":
        event.preventDefault();
        if (filtered[focusIndex]) toggle(filtered[focusIndex].name);
        break;
      case "Enter":
        event.preventDefault();
        if (selected.size) finish([...selected]);
        else if (filtered[focusIndex]) finish([filtered[focusIndex].name]);
        break;
      default:
        break;
    }
  });

  document.body.appendChild(overlay);
  grid.focus();
  await reload();

  return result;
}
