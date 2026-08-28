/* Design-only capability map helpers for Agent Studio. No skill execution lives here. */
(function exposeProfilePowerMap() {
  const clone = value => JSON.parse(JSON.stringify(value));

  function compatible(sourceType, targetType) {
    return sourceType === targetType || sourceType === 'any' || targetType === 'any';
  }

  function keyboardNodeActivation(event) {
    if (!event || !['Enter', ' '].includes(event.key)) return null;
    if (event.target?.closest('button, a, input, select, textarea')) return null;
    return event.target?.closest('[data-power-node]')?.dataset.powerNode || null;
  }

  function empty() { return { version: 1, nodes: [], edges: [] }; }

  function normalize(map) {
    if (!map || map.version !== 1 || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) return empty();
    return clone(map);
  }

  function addCapability(map, capability, capabilities = []) {
    const next = normalize(map);
    if (next.nodes.some(node => node.capability_id === capability.id)) return next;
    const index = next.nodes.length;
    const node = { id: `power_${Date.now()}_${index}`, capability_id: capability.id, x: 120 + index * 260, y: 150 };
    const previous = next.nodes[next.nodes.length - 1];
    if (previous) {
      const previousCapability = capabilities.find(item => item.id === previous.capability_id);
      const source = previousCapability?.outputs?.[0];
      const target = capability.inputs?.[0];
      if (source && target && compatible(source.type, target.type)) {
        next.edges.push({
          id: `edge_${previous.id}_${node.id}`, source: previous.id, source_port: source.id,
          target: node.id, target_port: target.id,
        });
      }
    }
    next.nodes.push(node);
    return next;
  }

  function removeCapability(map, capabilityId) {
    const next = normalize(map);
    const removed = new Set(next.nodes.filter(node => node.capability_id === capabilityId).map(node => node.id));
    next.nodes = next.nodes.filter(node => !removed.has(node.id));
    next.edges = next.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
    return next;
  }

  function moveNode(map, nodeId, direction) {
    const next = normalize(map);
    const ordered = [...next.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
    const index = ordered.findIndex(node => node.id === nodeId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return next;
    const first = ordered[index]; const second = ordered[target];
    [first.x, second.x] = [second.x, first.x];
    return next;
  }

  function render(container, map, capabilities, selectedId) {
    const capabilityMap = new Map(capabilities.map(item => [item.id, item]));
    const normalized = normalize(map);
    const nodes = [...normalized.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
    const edgeTargets = new Map(normalized.edges.map(edge => [edge.target, edge]));
    container.innerHTML = `<div class="power-map-banner">◫ Mapa de capacidades · no ejecuta acciones</div>
      <div class="power-map-lanes"><span>ENTRADA</span><span>TRABAJO</span><span>CONTROL</span><span>RESULTADO</span></div>
      <div class="power-map-track" role="list" aria-label="Power Map">${nodes.map((node, index) => {
        const capability = capabilityMap.get(node.capability_id);
        if (!capability) return '';
        const incoming = edgeTargets.get(node.id);
        const connector = index ? `<div class="power-map-connector" title="${incoming ? `${incoming.source_port} → ${incoming.target_port}` : 'Sin conexión tipada'}"><span>${incoming ? '→' : '⋯'}</span><button type="button" data-power-quick-add="${index}" aria-label="Añadir bloque aquí">＋</button></div>` : '';
        return `${connector}<article class="power-map-node ${selectedId === capability.id ? 'selected' : ''}" data-power-node="${pEsc(capability.id)}" role="listitem" tabindex="0">
          <div class="power-node-port input"><b>INPUT</b><small>${pEsc(capability.inputs?.[0]?.label || 'Contexto')}</small></div>
          <div class="power-node-core"><span>${pEsc(capability.icon, '🧩')}</span><strong>${pEsc(capability.name)}</strong><small>${pEsc(capability.superpower)}</small></div>
          <div class="power-node-port output"><b>OUTPUT</b><small>${pEsc(capability.outputs?.[0]?.label || 'Resultado')}</small></div>
          <div class="power-node-actions"><button type="button" data-power-move="-1" data-node-id="${pEsc(node.id)}" aria-label="Mover a la izquierda">←</button><button type="button" data-power-move="1" data-node-id="${pEsc(node.id)}" aria-label="Mover a la derecha">→</button></div>
        </article>`;
      }).join('') || '<div class="power-map-empty"><strong>Coloca tu primer bloque</strong><span>Elige un superpoder de la paleta para ver cómo aporta al agente.</span></div>'}</div>`;
  }

  window.ProfilePowerMap = { compatible, keyboardNodeActivation, empty, normalize, addCapability, removeCapability, moveNode, render };
})();
