export function isSchemaLeafDocumented(node, fieldPaths, subtreeSummaries) {
  return (
    fieldPaths.has(node) ||
    [...subtreeSummaries].some((summaryPath) => node.startsWith(`${summaryPath}.`))
  );
}

export function resolveRelativeRoute(sourceRoute, sourceIsIndex, target) {
  const segments = sourceRoute.split("/").filter((segment) => segment !== "");
  if (!sourceIsIndex) {
    segments.pop();
  }
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}/`;
}
