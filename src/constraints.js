import { matchLabels } from './resources.js';

export function passesNodeAffinity(pod, node) {
  return matchLabels(pod.nodeAffinity?.matchLabels, node.labels);
}

export function domainValue(node, topologyKey) {
  return node.labels?.[topologyKey];
}

export function passesPodAntiAffinity(pod, node, bound, nodesByName) {
  for (const term of pod.podAntiAffinity ?? []) {
    const domain = domainValue(node, term.topologyKey);
    for (const { pod: other, node: otherNodeName } of bound) {
      const otherNode = nodesByName.get(otherNodeName);
      if (
        domainValue(otherNode, term.topologyKey) === domain &&
        matchLabels(term.selector, other.labels)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function passesExistingAntiAffinity(pod, node, bound, nodesByName) {
  for (const { pod: other, node: otherNodeName } of bound) {
    const otherNode = nodesByName.get(otherNodeName);
    for (const term of other.podAntiAffinity ?? []) {
      if (
        domainValue(otherNode, term.topologyKey) === domainValue(node, term.topologyKey) &&
        matchLabels(term.selector, pod.labels)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function passesPodAffinity(pod, node, bound, nodesByName) {
  for (const term of pod.podAffinity ?? []) {
    const domain = domainValue(node, term.topologyKey);
    const found = bound.some(
      ({ pod: other, node: otherNodeName }) =>
        domainValue(nodesByName.get(otherNodeName), term.topologyKey) === domain &&
        matchLabels(term.selector, other.labels),
    );
    if (!found) return false;
  }
  return true;
}

export function topologySkew(pod, node, bound, nodes, nodesByName) {
  const spread = pod.topologySpread;
  if (!spread) return 0;
  const counts = new Map();
  for (const entry of nodes) counts.set(domainValue(entry, spread.topologyKey), 0);
  const selector = spread.selector ?? pod.labels ?? {};
  for (const { pod: other, node: otherNodeName } of bound) {
    if (matchLabels(selector, other.labels)) {
      const domain = domainValue(nodesByName.get(otherNodeName), spread.topologyKey);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  const domain = domainValue(node, spread.topologyKey);
  counts.set(domain, (counts.get(domain) ?? 0) + 1);
  const values = [...counts.values()];
  return Math.max(...values) - Math.min(...values);
}

export function passesTopologySpread(pod, node, bound, nodes, nodesByName) {
  const spread = pod.topologySpread;
  if (!spread) return true;
  return topologySkew(pod, node, bound, nodes, nodesByName) <= spread.maxSkew;
}
