/** Pure display formatting for the DOM interfaces. */

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number === 0) return "0";
  return number.toFixed(3).replace(/\.?0+$/, "");
}

export function alignmentOptions(profiles) {
  return (profiles ?? []).map((profile) => {
    let label = profile.label;
    if (profile.model === "minimax_h3") label = `${profile.multiple} · MiniMax H3`;
    else if (profile.model === "krea_2") label = `${profile.multiple} · Krea 2`;
    return { key: profile.key, label };
  });
}

export function imageReadout(name, info) {
  if (!name || !info) return { source: "No image selected", target: "" };
  const filename = String(name).split("/").pop();
  const source = [
    filename,
    `${info.source_width}×${info.source_height}`,
    info.aspect_ratio,
    `${compactNumber(info.megapixels)} MP`,
  ].join(" · ");
  const changed =
    Number(info.width) !== Number(info.source_width) ||
    Number(info.height) !== Number(info.source_height);
  const target = changed
    ? [
        `${info.width}×${info.height}`,
        info.final_aspect_ratio,
        `${compactNumber(info.final_megapixels)} MP`,
      ].join(" · ")
    : "";
  return { source, target };
}

export function shotSizeReadout(info) {
  if (info?.size_known === false) return "Known at run time";
  if (!info?.width || !info?.height) return "Size unavailable";
  return [
    `${info.width}×${info.height}`,
    info.aspect_ratio,
    `${compactNumber(info.megapixels)} MP`,
  ].join(" · ");
}

export function frameCountReadout(info) {
  return info?.frames ? `${info.frames}f` : "";
}

export function favouriteState(active) {
  return {
    glyph: active ? "♥" : "♡",
    label: active ? "Remove from favourites" : "Add to favourites",
  };
}

export function nextBatchEnd(rendered, total, batchSize = 96) {
  return Math.min(Math.max(0, total), Math.max(0, rendered) + Math.max(1, batchSize));
}
