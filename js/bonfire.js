import { app } from "../../scripts/app.js";

import { setupImageLoader } from "./bonfire_loader.js";
import { setupShot } from "./bonfire_shot.js";
import { loadStylesheet } from "./bonfire_widgets.js";

/**
 * Extension entry point.
 *
 * `nodeCreated` is used rather than `beforeRegisterNodeDef` because the interface needs
 * the node's actual widgets, which only exist once the node does. Each setup attaches its
 * own teardown to the node, so removing a node removes everything it created.
 */

app.registerExtension({
  name: "DaemonSK.Bonfire",

  async setup() {
    // Only .js is served automatically; stylesheets are fetched by the extension itself,
    // resolved relative to this module so the served path never has to be hardcoded.
    loadStylesheet("bonfire.css");
  },

  async nodeCreated(node) {
    const id = node.constructor?.comfyClass ?? node.comfyClass;
    try {
      if (id === "BonfireImageLoader") await setupImageLoader(node);
      else if (id === "BonfireShot") await setupShot(node);
    } catch (error) {
      // A broken interface must not take the graph down with it; the node still runs on
      // its plain widgets.
      console.error(`[Bonfire] could not build the interface for ${id}`, error);
    }
  },
});
