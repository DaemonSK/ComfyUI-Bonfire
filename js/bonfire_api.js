import { api } from "../../scripts/api.js";

/**
 * Talking to the Bonfire backend.
 *
 * Nothing in the interface recomputes a size, a frame count or an option list. The
 * backend already owns that arithmetic and the node executes with it, so asking is the
 * only way the readout and the run cannot disagree.
 */

const FAVOURITES_FILE = "bonfire/favourites.json";

let optionsPromise = null;

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

async function getJson(path, params = {}) {
  const query = queryString(params);
  const response = await api.fetchApi(`${path}${query ? `?${query}` : ""}`);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // A non-JSON error body is not worth a second failure; the status line will do.
    }
    throw new Error(message);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const result = await response.json();
      if (result?.error) message = result.error;
    } catch {
      // Keep the useful status line when an error response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

/** Option tables and limits. Fetched once per page: they cannot change under us. */
export function options() {
  if (!optionsPromise) {
    optionsPromise = getJson("/bonfire/options").catch((error) => {
      // Do not cache a failure, or one blip disables the interface for the session.
      optionsPromise = null;
      throw error;
    });
  }
  return optionsPromise;
}

export function listImages({ query = "", sort, descending } = {}) {
  return getJson("/bonfire/images", { query, sort, descending });
}

export function locateDuplicate({ size, digest } = {}) {
  return getJson("/bonfire/duplicate", { size, digest });
}

export function deleteImages(names) {
  return postJson("/bonfire/delete", { names });
}

export function probe(name) {
  return getJson("/bonfire/probe", { name });
}

export function plan(params) {
  return getJson("/bonfire/plan", params);
}

export function shot(params) {
  return getJson("/bonfire/shot", params);
}

/** URL for a thumbnail. Plain URL so the browser handles caching and lazy loading. */
export function thumbnailUrl(name, size) {
  return api.apiURL(`/bonfire/thumbnail?${queryString({ name, size })}`);
}

/**
 * Favourites live in ComfyUI's own user data store rather than in a file of our own,
 * so they follow the user's profile and need no backend endpoint here.
 */
export async function loadFavourites() {
  try {
    const response = await api.fetchApi(
      `/userdata/${encodeURIComponent(FAVOURITES_FILE)}`
    );
    if (!response.ok) return new Set();
    const stored = await response.json();
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    // No favourites yet, or unreadable. An empty set is the right answer either way.
    return new Set();
  }
}

export async function saveFavourites(favourites) {
  try {
    const response = await api.fetchApi(
      `/userdata/${encodeURIComponent(FAVOURITES_FILE)}?overwrite=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([...favourites]),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}
