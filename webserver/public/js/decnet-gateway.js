;(function () {
  const user = window.DECNET_USER
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

  let state = { nodes: [], clients: [], gateway: { available: false } }
  let issuedLine = null
  let issuedName = null

  function showError(msg) {
    errorMessage.textContent = msg
    errorMessage.style.display = 'block'
    setTimeout(() => (errorMessage.style.display = 'none'), 8000)
  }

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(path, opts)
    if (res.status === 204) return null
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const error = new Error(data?.error || `Fehler (${res.status})`)
      error.code = data?.code
      error.data = data
      throw error
    }
    return data
  }

  const formatTime = (t) =>
    t ? new Date(t).toLocaleString('de-DE', { hour12: false }) : '—'

  function cell(tr, content, className) {
    const td = document.createElement('td')
    if (content instanceof Node) td.appendChild(content)
    else td.textContent = content
    if (className) td.className = className
    tr.appendChild(td)
    return td
  }

  function button(label, onclick) {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = onclick
    return b
  }

  function renderClients() {
    const showOwner = allCheck?.checked
    $('gw-owner-head').style.display = showOwner ? '' : 'none'
    clientsBody.innerHTML = ''
    $('gw-no-clients').style.display =
      state.clients.length === 0 ? 'block' : 'none'
    $('gw-clients-table').style.display =
      state.clients.length === 0 ? 'none' : ''
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
      const actions = document.createElement('span')
      actions.appendChild(button('Status', () => showStatus(c)))
      actions.appendChild(button('Neuer Schlüssel', () => rekey(c)))
      actions.appendChild(button('Widerrufen', () => revoke(c)))
      cell(tr, actions)
      clientsBody.appendChild(tr)
    })
  }

  function nodeLabel(n) {
    return n.name ? `${n.address} (${n.name})` : n.address
  }

  function renderNodes() {
    const hasBlock = state.nodes.length > 0
    $('gw-no-block').style.display = hasBlock ? 'none' : 'block'
    createForm.style.display =
      hasBlock && state.gateway.available ? 'block' : 'none'
    const previous = nodeSelect.value
    nodeSelect.innerHTML = ''
    state.nodes
      .filter((n) => !n.client_id)
      .forEach((n) => {
        const option = document.createElement('option')
        option.value = n.node_number
        option.textContent =
          nodeLabel(n) + (n.host_seen ? ' – zuletzt im Netz gesehen' : '')
        nodeSelect.appendChild(option)
      })
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
    moveCheck.checked = false
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

  function showIssued({ client, line, qr_svg }) {
    issuedLine = line
    issuedName = client.name
    $('gw-issued-name').textContent = `${client.name} (${client.address})`
    $('gw-issued-line').textContent = line
    $('gw-issued-qr').innerHTML = qr_svg
    $('gw-issued').style.display = 'block'
    $('gw-issued').scrollIntoView({ behavior: 'smooth' })
  }

  function hideIssued() {
    issuedLine = null
    $('gw-issued-line').textContent = ''
    $('gw-issued-qr').innerHTML = ''
    $('gw-issued').style.display = 'none'
  }

  $('gw-dismiss').onclick = hideIssued

  $('gw-download').onclick = () => {
    if (!issuedLine) return
    const blob = new Blob([issuedLine + '\n'], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${issuedName.toLowerCase()}.dngw`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  $('gw-copy').onclick = () => {
    if (issuedLine) navigator.clipboard?.writeText(issuedLine)
  }

  async function showStatus(c) {
    statusBox.style.display = 'block'
    statusBox.textContent = `Status von ${c.name} wird abgefragt …`
    try {
      const s = await api('GET', `/api/decnet/gateway-clients/${c.id}/status`)
      if (!s.known) {
        statusBox.textContent =
          `${c.name}: Das Gateway kennt diesen Zugang nicht. ` +
          'Erzeuge einen neuen Schlüssel.'
        return
      }
      const drops = s.drops || {}
      statusBox.innerHTML = ''
      const head = document.createElement('div')
      head.textContent =
        `${c.name} (${c.address}): ` +
        (s.connected ? `verbunden von ${s.endpoint}` : 'nicht verbunden')
      statusBox.appendChild(head)
      const table = document.createElement('table')
      ;[
        ['Empfangen', `${s.rx_packets} Pakete, ${s.rx_bytes} Bytes`],
        ['Gesendet', `${s.tx_packets} Pakete, ${s.tx_bytes} Bytes`],
        [
          'Verworfen',
          `Absender ${drops.bad_source || 0}, Ethertype ${
            drops.ethertype || 0
          }, Replay ${drops.replay || 0}, Authentisierung ${
            drops.auth || 0
          }, Rate ${drops.rate || 0}`,
        ],
      ].forEach(([label, value]) => {
        const tr = document.createElement('tr')
        cell(tr, label)
        cell(tr, value)
        table.appendChild(tr)
      })
      statusBox.appendChild(table)
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

  if (user) load()
})()
