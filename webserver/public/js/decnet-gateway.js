;(function () {
  const { api, formatTime, element, issuedPanel, statusRows, rowsTable } =
    window.DNGW
  const $ = (id) => document.getElementById(id)

  const errorMessage = $('gw-error')
  const clientsBody = $('gw-clients-body')
  const nodeSelect = $('gw-node')
  const nameInput = $('gw-name')
  const createForm = $('gw-create-form')
  const moveBox = $('gw-move')
  const moveCheck = $('gw-move-check')
  const allCheck = $('gw-all')
  const statusBox = $('gw-status')
  const issuedArea = $('gw-issued')

  let state = { nodes: [], clients: [], gateway: { available: false } }

  function showError(msg) {
    errorMessage.textContent = msg
    errorMessage.style.display = 'block'
    setTimeout(() => (errorMessage.style.display = 'none'), 8000)
  }

  function cell(tr, content, className) {
    const td = element('td', { className: className || '' }, [content])
    tr.appendChild(td)
    return td
  }

  function button(label, onclick) {
    return element('button', { type: 'button', textContent: label, onclick })
  }

  function renderClients() {
    const showOwner = allCheck?.checked
    $('gw-owner-head').style.display = showOwner ? '' : 'none'
    clientsBody.innerHTML = ''
    const none = state.clients.length === 0
    $('gw-no-clients').style.display = none ? 'block' : 'none'
    $('gw-clients-table').style.display = none ? 'none' : ''
    state.clients.forEach((c) => {
      const tr = document.createElement('tr')
      cell(tr, c.name)
      cell(tr, c.address)
      if (showOwner) cell(tr, c.owner)
      if (c.needs_rekey) {
        cell(tr, 'Neuer Schlüssel nötig', 'gw-needs-rekey')
      } else {
        cell(tr, c.key_fingerprint || '—', 'gw-fingerprint')
      }
      cell(tr, formatTime(c.created_at))
      cell(tr, formatTime(c.last_seen))
      cell(
        tr,
        element('span', {}, [
          button('Status', () => showStatus(c)),
          button('Neuer Schlüssel', () => rekey(c)),
          button('Widerrufen', () => revoke(c)),
        ])
      )
      clientsBody.appendChild(tr)
    })
  }

  const nodeLabel = (n) => (n.name ? `${n.address} (${n.name})` : n.address)

  function renderNodes() {
    const hasBlock = state.nodes.length > 0
    $('gw-no-block').style.display = hasBlock ? 'none' : 'block'
    createForm.style.display =
      hasBlock && state.gateway.available ? 'block' : 'none'
    const previous = nodeSelect.value
    nodeSelect.innerHTML = ''
    state.nodes
      .filter((n) => !n.client_id)
      .forEach((n) =>
        nodeSelect.appendChild(
          element('option', {
            value: n.node_number,
            textContent:
              nodeLabel(n) + (n.host_seen ? ' – zuletzt im Netz gesehen' : ''),
          })
        )
      )
    const wanted = new URLSearchParams(location.search).get('node')
    const offered = [...nodeSelect.options].map(({ value }) => value)
    nodeSelect.value =
      [previous, wanted].find((value) => offered.includes(value)) ||
      offered[0] ||
      ''
    nodeChanged()
  }

  function selectedNode() {
    return state.nodes.find((n) => String(n.node_number) === nodeSelect.value)
  }

  function nodeChanged() {
    const node = selectedNode()
    moveCheck.checked = false
    if (!node) {
      nameInput.value = ''
      moveBox.style.display = 'none'
      return
    }
    nameInput.value = node.name || ''
    if (node.host_seen) {
      $('gw-move-text').textContent =
        `Unter ${node.address} war am ${formatTime(
          node.host_seen.last_seen
        )} ` +
        `eine Maschine von ${node.host_seen.owner} im Netz. ` +
        'Ich verlege diese Maschine hinter das Gateway.'
      moveBox.style.display = 'block'
    } else {
      moveBox.style.display = 'none'
    }
  }

  function showIssued(issued) {
    const done = element('button', {
      type: 'button',
      className: 'function',
      textContent: 'Fertig',
      onclick: () => (issuedArea.innerHTML = ''),
    })
    const panel = issuedPanel(issued)
    panel.querySelector('.gw-buttons').append(' ', done)
    issuedArea.innerHTML = ''
    issuedArea.appendChild(panel)
    panel.scrollIntoView({ behavior: 'smooth' })
  }

  async function showStatus(c) {
    statusBox.style.display = 'block'
    statusBox.textContent = `Status von ${c.name} wird abgefragt …`
    try {
      const s = await api('GET', `/api/decnet/gateway-clients/${c.id}/status`)
      statusBox.innerHTML = ''
      statusBox.appendChild(
        element('div', { textContent: `${c.name} (${c.address})` })
      )
      statusBox.appendChild(rowsTable(statusRows(c, s)))
    } catch (e) {
      statusBox.textContent = e.message
    }
  }

  async function rekey(c) {
    if (
      !confirm(
        `Neuen Schlüssel für ${c.name} erzeugen? Der bisherige Schlüssel ` +
          'gilt sofort nicht mehr.'
      )
    )
      return
    try {
      showIssued(await api('POST', `/api/decnet/gateway-clients/${c.id}/rekey`))
      load()
    } catch (e) {
      showError(e.message)
    }
  }

  async function revoke(c) {
    const reason = prompt(
      `Zugang für ${c.name} (${c.address}) widerrufen? ` +
        'Er gilt sofort nicht mehr. Grund (optional):',
      ''
    )
    if (reason === null) return
    try {
      await api('DELETE', `/api/decnet/gateway-clients/${c.id}`, { reason })
      statusBox.style.display = 'none'
      load()
    } catch (e) {
      showError(e.message)
    }
  }

  nodeSelect.onchange = nodeChanged

  createForm.onsubmit = async (e) => {
    e.preventDefault()
    const node = selectedNode()
    if (!node) return
    if (node.host_seen && !moveCheck.checked) {
      showError(
        'Bestätige, dass Du die Maschine hinter das Gateway verlegst, oder wähle einen anderen Knoten.'
      )
      return
    }
    try {
      const issued = await api('POST', '/api/decnet/gateway-clients', {
        node_number: node.node_number,
        name: nameInput.value.toUpperCase(),
        move: moveCheck.checked,
      })
      nodeSelect.value = ''
      showIssued(issued)
      load()
    } catch (e) {
      showError(e.message)
    }
  }

  if (allCheck) allCheck.onchange = load

  async function load() {
    try {
      const all = allCheck?.checked ? '?all=1' : ''
      state = await api('GET', '/api/decnet/gateway-clients' + all)
      $('gw-unavailable').style.display = state.gateway.available
        ? 'none'
        : 'block'
      renderClients()
      renderNodes()
    } catch (e) {
      showError(e.message)
    }
  }

  load()
})()
