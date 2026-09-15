"""Bonfire - input-image handling nodes for ComfyUI.

Registration is V3: a `comfy_entrypoint` returning a `ComfyExtension`.

There is deliberately no `NODE_CLASS_MAPPINGS` here. `nodes.py:load_custom_node` checks
for that attribute *before* `comfy_entrypoint` and returns as soon as it finds one, so
leaving even an empty mapping in place would register nothing at all.
"""

from typing_extensions import override

from comfy_api.v0_0_2 import ComfyExtension, io

from .nodes import routes
from .nodes.image_loader import BonfireImageLoader
from .nodes.shot import BonfireShot

WEB_DIRECTORY = "./js"
"""Serves js/ to the browser.

Only this mechanism is used, not `tool.comfy.web` in pyproject.toml. `load_custom_node`
honours both and keys them differently -- one by project name, one by module name -- so
declaring both would serve the extension twice and build two interfaces on every node.
"""

# ComfyUI loads custom nodes before it calls PromptServer.add_routes, so registering the
# interface routes here is enough. It is a no-op when there is no server.
routes.register_with_server()


class BonfireExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            BonfireImageLoader,
            BonfireShot,
        ]


async def comfy_entrypoint() -> BonfireExtension:
    return BonfireExtension()
