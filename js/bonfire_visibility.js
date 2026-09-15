/** Pure contextual-visibility rules shared by the interfaces and frontend tests. */

export function loaderFieldVisibility(alignment, resizeMode) {
  return {
    custom_multiple: alignment === "custom",
    megapixels: resizeMode === "megapixels",
    long_edge: resizeMode === "long_edge",
    target_width: resizeMode === "fit" || resizeMode === "crop",
    target_height: resizeMode === "fit" || resizeMode === "crop",
  };
}

export function shotFieldVisibility(resolutionMode, alignment) {
  return {
    custom_multiple: alignment === "custom",
    megapixels: resolutionMode === "aspect_mp",
    custom_width: resolutionMode === "custom_size",
    custom_height: resolutionMode === "custom_size",
    aspect_cards: resolutionMode === "aspect_mp",
  };
}
