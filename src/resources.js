export function resourceKeys(...maps) {
  const keys = new Set();
  for (const map of maps) {
    for (const key of Object.keys(map ?? {})) keys.add(key);
  }
  return [...keys];
}

export function covers(available, requests) {
  for (const [key, value] of Object.entries(requests ?? {})) {
    if ((available?.[key] ?? 0) < value) return false;
  }
  return true;
}

export function addInto(acc, delta) {
  for (const [key, value] of Object.entries(delta ?? {})) {
    acc[key] = (acc[key] ?? 0) + value;
  }
  return acc;
}

export function matchLabels(selector, labels) {
  for (const [key, value] of Object.entries(selector ?? {})) {
    if ((labels ?? {})[key] !== value) return false;
  }
  return true;
}

export function remainingCapacity(node, bindings, podsByName) {
  const used = {};
  for (const [name, nodeName] of bindings) {
    if (nodeName !== node.name) continue;
    addInto(used, podsByName.get(name).requests);
  }
  const free = {};
  for (const key of resourceKeys(node.capacity, used)) {
    free[key] = (node.capacity?.[key] ?? 0) - (used[key] ?? 0);
  }
  return free;
}
