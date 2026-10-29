;(function () {
  const user = window.DECNET_USER
  const isAdmin = user?.is_admin || false
  const { api, formatTime, element, issuedPanel, statusRows, rowsTable } =
    window.DNGW

  const blocksBody = document.getElementById('blocks-body')
  const allocateSection = document.getElementById('allocate-section')
  const allocateBtn = document.getElementById('allocate-btn')
  const errorMessage = document.getElementById('error-message')
  const adminForm = document.getElementById('admin-allocate-form')

  const dialog = document.getElementById('node-dialog')
  const dialogTitle = document.getElementById('node-dialog-title')
  const dialogBody = document.getElementById('node-dialog-body')
  const dialogError = document.getElementById('node-dialog-error')

  const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,5}$/
  const NAME_RULE =
    'Ungültiger Hostname. 1-6 Zeichen, muss mit Buchstabe beginnen, nur Buchstaben und Ziffern.'

  // The member's own nodes and gateway clients, from the gateway API.
  let gw = { gateway: { available: false }, nodes: [], clients: [] }
  let blocks = []

  function showError(msg) {
    errorMessage.textContent = msg
    errorMessage.style.display = 'block'
    setTimeout(() => (errorMessage.style.display = 'none'), 5000)
  }

  function gatewayBadge() {
    const badge = element('span', {
      className: 'gw-badge',
      title: 'Gateway-Zugang',
    })
    badge.setAttribute('role', 'img')
    badge.setAttribute('aria-label', 'mit Gateway-Zugang')
    return badge
  }

  function renderBlocks() {
    blocksBody.innerHTML = ''
    let userHasBlock = false

    blocks.forEach((block) => {
      const isOwner = user && block.user_id === user.id
      if (isOwner) userHasBlock = true

      const tr = document.createElement('tr')
      tr.appendChild(
        element('td', {
          textContent: `23.${block.start_node}–23.${block.end_node}`,
        })
      )
      tr.appendChild(element('td', { textContent: block.owner }))

      const hostsTd = document.createElement('td')
      if (isOwner) {
        renderOwnedHosts(hostsTd, block)
      } else {
        renderOtherHosts(hostsTd, block)
      }
      tr.appendChild(hostsTd)

      if (isAdmin) {
        const adminTd = document.createElement('td')
        adminTd.className = 'admin-actions'
        adminTd.appendChild(
          element('button', {
            textContent: 'Freigeben',
            onclick: () => releaseBlock(block.id),
          })
        )
        adminTd.appendChild(
          element('button', {
            textContent: 'Zuweisen',
            onclick: () => reassignBlock(block.id),
          })
        )
        tr.appendChild(adminTd)
      }

      blocksBody.appendChild(tr)
    })

    if (allocateSection) {
      allocateSection.style.display = user && !userHasBlock ? 'block' : 'none'
    }
  }

  // Other members' named nodes. A logged-in visitor opens a read-only
  // dialog on them; for others they are plain labels.
  function renderOtherHosts(td, block) {
    const hosts = block.hosts || []
    if (hosts.length === 0) {
      td.innerHTML = '<span style="color:#999">—</span>'
      return
    }
    const div = element('div', { className: 'host-list' })
    hosts.forEach((h) => {
      const children = [
        element('span', { className: 'host-name', textContent: h.name }),
        ' ',
        element('span', {
          className: 'host-node',
          textContent: '23.' + h.node_number,
        }),
      ]
      if (h.gateway) children.push(' ', gatewayBadge())
      const entry = user
        ? element('button', { type: 'button' }, children)
        : element('span', {}, children)
      entry.className = 'host-entry'
      entry.dataset.node = h.node_number
      if (user) entry.onclick = () => openOtherDialog(block, h)
      div.appendChild(entry)
    })
    td.appendChild(div)
  }

  function renderOwnedHosts(td, block) {
    const names = {}
    ;(block.hosts || []).forEach((h) => (names[h.node_number] = h))

    const div = element('div', { className: 'host-list' })
    for (let n = block.start_node; n <= block.end_node; n++) {
      const host = names[n]
      const children = [
        element('span', { className: 'host-node', textContent: '23.' + n }),
      ]
      if (host) {
        children.unshift(
          element('span', { className: 'host-name', textContent: host.name }),
          ' '
        )
      }
      if (host?.gateway) children.push(' ', gatewayBadge())
      const btn = element(
        'button',
        {
          type: 'button',
          className: 'host-entry' + (host ? '' : ' free'),
          title: 'Knoten verwalten',
        },
        children
      )
      btn.dataset.node = n
      btn.onclick = () => openOwnDialog(n)
      div.appendChild(btn)
    }
    td.appendChild(div)
  }

  // The node dialog

  let dialogNode = null
  let dialogIssued = null

  // Focus goes to the connection line's buttons when one is shown, else to
  // the first control.
  function focusDialog() {
    const first =
      dialogBody.querySelector('.gw-issued button') ||
      dialogBody.querySelector('input, button:not([disabled])')
    ;(first || document.getElementById('node-dialog-close')).focus()
  }

  function openDialog() {
    dialogError.textContent = ''
    if (!dialog.open) dialog.showModal()
    focusDialog()
  }

  function closeDialog() {
    if (dialog.open) dialog.close()
  }

  dialog.addEventListener('close', () => {
    const node = dialogNode
    dialogNode = null
    dialogIssued = null
    dialogBody.innerHTML = ''
    document.querySelector(`[data-node="${node}"]`)?.focus()
  })
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeDialog()
  })
  document.getElementById('node-dialog-close').onclick = closeDialog

  function dialogFailed(e) {
    dialogError.textContent = e.message
  }

  function section(title, children) {
    return element('section', { className: 'node-dialog-section' }, [
      element('h4', { textContent: title }),
      ...children,
    ])
  }

  function openOtherDialog(block, host) {
    dialogNode = host.node_number
    dialogTitle.textContent = `${host.name} (23.${host.node_number})`
    dialogBody.innerHTML = ''
    dialogBody.appendChild(
      rowsTable([
        ['Name', host.name],
        ['Adresse', `23.${host.node_number}`],
        ['Besitzer', block.owner],
        [
          'Im Netz',
          host.last_seen
            ? `zuletzt gesehen am ${formatTime(host.last_seen)}`
            : 'nicht gesehen',
        ],
        ['DECnet-Gateway', host.gateway ? 'hat einen Zugang' : '—'],
      ])
    )
    openDialog()
  }

  const ownNode = (n) =>
    gw.nodes.find((node) => node.node_number === n) || {
      node_number: n,
      address: `23.${n}`,
    }

  const ownClient = (n) => gw.clients.find((c) => c.node_number === n)

  function openOwnDialog(n) {
    dialogNode = n
    renderOwnDialog()
    openDialog()
  }

  // Inline confirmation: a sentence and the button that does it.
  function confirmation(text, label, action, extra = [], danger = false) {
    const box = element('div', { className: 'node-dialog-confirm' })
    const go = element('button', {
      type: 'button',
      className: 'function' + (danger ? ' node-dialog-danger' : ''),
      textContent: label,
    })
    go.onclick = async () => {
      go.disabled = true
      try {
        await action()
      } catch (e) {
        dialogFailed(e)
        go.disabled = false
      }
    }
    box.append(element('p', { textContent: text }), ...extra, go)
    // The confirmation replaces the button that had the focus.
    setTimeout(() => (box.querySelector('input') || go).focus())
    return box
  }

  function nameSection(node, client) {
    const input = element('input', {
      type: 'text',
      className: 'name-input',
      maxLength: 6,
      value: node.name || '',
      id: 'node-dialog-name',
      autocomplete: 'off',
    })
    const save = element('button', {
      type: 'submit',
      className: 'function',
      textContent: 'Speichern',
    })
    const form = element('form', { className: 'node-dialog-name' }, [
      element('label', { htmlFor: 'node-dialog-name', textContent: 'Name: ' }),
      input,
      ' ',
      save,
    ])
    form.onsubmit = async (e) => {
      e.preventDefault()
      const name = input.value.trim()
      if (!NAME_PATTERN.test(name)) return dialogFailed(new Error(NAME_RULE))
      try {
        await api('PUT', '/api/decnet/hosts/' + node.node_number, {
          name: name.toUpperCase(),
        })
        dialogError.textContent = ''
        await reload()
      } catch (e) {
        dialogFailed(e)
      }
    }
    const children = [form]
    if (node.name) {
      const remove = element('button', {
        type: 'button',
        textContent: 'Namen entfernen',
        className: 'node-dialog-secondary',
        disabled: !!client,
      })
      remove.onclick = () =>
        remove.replaceWith(
          confirmation(
            `Den Namen ${node.name} für ${node.address} entfernen?`,
            'Entfernen',
            async () => {
              await api('DELETE', '/api/decnet/hosts/' + node.node_number)
              await reload()
            }
          )
        )
      children.push(element('p', {}, [remove]))
      if (client) {
        children.push(
          element('p', {
            className: 'node-dialog-hint',
            textContent:
              'Solange der Knoten einen Gateway-Zugang hat, bleibt sein Name.',
          })
        )
      }
    }
    return section('Name', children)
  }

  function createGatewayKey(node) {
    const children = [
      element('p', {
        className: 'node-dialog-hint',
        textContent:
          'Mit einem Gateway-Schlüssel erreicht ein Rechner das RetroStar-Netz ' +
          'als dieser Knoten über UDP, ohne OpenVPN. Verschlüsselt ist nur der ' +
          'Weg über das Internet; im RetroStar-Netz läuft DECnet unverschlüsselt.',
      }),
    ]
    let move = null
    if (node.host_seen) {
      move = element('input', { type: 'checkbox', id: 'node-dialog-move' })
      children.push(
        element('label', { className: 'node-dialog-check' }, [
          move,
          ` Unter ${node.address} war am ${formatTime(
            node.host_seen.last_seen
          )} eine Maschine von ${node.host_seen.owner} im Netz. ` +
            'Ich verlege diese Maschine hinter das Gateway.',
        ])
      )
    }
    const create = element('button', {
      type: 'button',
      className: 'function',
      textContent: node.name
        ? 'Gateway-Schlüssel erzeugen'
        : 'Benennen und Gateway-Schlüssel erzeugen',
    })
    create.onclick = async () => {
      const name = document.getElementById('node-dialog-name').value.trim()
      if (!NAME_PATTERN.test(name)) {
        return dialogFailed(
          new Error('Gib dem Knoten zuerst einen Namen. ' + NAME_RULE)
        )
      }
      if (move && !move.checked) {
        return dialogFailed(
          new Error(
            'Bestätige, dass Du die Maschine hinter das Gateway verlegst.'
          )
        )
      }
      create.disabled = true
      try {
        dialogIssued = await api('POST', '/api/decnet/gateway-clients', {
          node_number: node.node_number,
          name: name.toUpperCase(),
          move: !!move?.checked,
        })
        dialogError.textContent = ''
        await reload()
      } catch (e) {
        dialogFailed(e)
        create.disabled = false
      }
    }
    children.push(element('p', {}, [create]))
    return children
  }

  function clientControls(client) {
    const facts = rowsTable([
      ['Fingerabdruck', client.key_fingerprint || '—'],
      ['Eingerichtet', formatTime(client.created_at)],
      ['Schlüssel erneuert', formatTime(client.rekeyed_at)],
    ])
    const live = element('div', {
      className: 'node-dialog-status',
      textContent: 'Status wird abgefragt …',
    })
    api('GET', `/api/decnet/gateway-clients/${client.id}/status`)
      .then((s) => live.replaceChildren(rowsTable(statusRows(client, s))))
      .catch((e) => (live.textContent = e.message))

    const rekey = element('button', {
      type: 'button',
      className: 'function',
      textContent: 'Neuer Schlüssel',
    })
    const revoke = element('button', {
      type: 'button',
      className: 'function node-dialog-danger',
      textContent: 'Widerrufen',
    })
    const actions = element('p', {}, [rekey, ' ', revoke])
    rekey.onclick = () =>
      actions.replaceWith(
        confirmation(
          'Der bisherige Schlüssel gilt sofort nicht mehr.',
          'Neuen Schlüssel erzeugen',
          async () => {
            dialogIssued = await api(
              'POST',
              `/api/decnet/gateway-clients/${client.id}/rekey`
            )
            await reload()
          }
        )
      )
    revoke.onclick = () => {
      const reason = element('input', {
        type: 'text',
        id: 'node-dialog-reason',
        maxLength: 200,
      })
      actions.replaceWith(
        confirmation(
          'Der Zugang gilt sofort nicht mehr.',
          'Zugang widerrufen',
          async () => {
            await api('DELETE', `/api/decnet/gateway-clients/${client.id}`, {
              reason: reason.value,
            })
            await reload()
          },
          [
            element('p', {}, [
              element('label', {
                htmlFor: 'node-dialog-reason',
                textContent: 'Grund (optional): ',
              }),
              reason,
            ]),
          ],
          true
        )
      )
    }
    const children = [facts, live, actions]
    if (client.needs_rekey) {
      children.unshift(
        element('p', {
          className: 'gw-needs-rekey',
          textContent:
            'Das Gateway kennt diesen Zugang nicht mehr. Erzeuge einen neuen Schlüssel.',
        })
      )
    }
    return children
  }

  function renderOwnDialog() {
    const n = dialogNode
    const node = ownNode(n)
    const client = ownClient(n)
    dialogTitle.textContent = node.name
      ? `${node.name} (${node.address})`
      : node.address
    dialogBody.innerHTML = ''
    dialogBody.appendChild(nameSection(node, client))

    const gatewayChildren = []
    if (dialogIssued) gatewayChildren.push(issuedPanel(dialogIssued))
    if (client) {
      gatewayChildren.push(...clientControls(client))
    } else if (!gw.gateway.available) {
      gatewayChildren.push(
        element('p', {
          className: 'gw-unavailable',
          textContent:
            'Das DECnet-Gateway ist zur Zeit nicht verfügbar. Gateway-Schlüssel können erst eingerichtet werden, wenn es läuft.',
        })
      )
    } else {
      gatewayChildren.push(...createGatewayKey(node))
    }
    dialogBody.appendChild(section('DECnet-Gateway', gatewayChildren))
  }

  // Reloads the blocks and the member's gateway state, and redraws an open
  // dialog.
  async function reload() {
    const [loadedBlocks, loadedGw] = await Promise.all([
      api('GET', '/api/decnet/blocks'),
      user ? api('GET', '/api/decnet/gateway-clients') : null,
    ])
    blocks = loadedBlocks
    if (loadedGw) gw = loadedGw
    renderBlocks()
    if (
      dialog.open &&
      gw.nodes.some(({ node_number }) => node_number === dialogNode)
    ) {
      renderOwnDialog()
      focusDialog()
    }
  }

  function releaseBlock(blockId) {
    if (
      !confirm(
        'Diesen Block wirklich freigeben? Alle Hostnamen werden gelöscht und Gateway-Zugänge widerrufen.'
      )
    )
      return
    api('DELETE', '/api/decnet/blocks/' + blockId)
      .then(reload)
      .catch((e) => showError(e.message))
  }

  function reassignBlock(blockId) {
    const username = prompt('Neuer Besitzer (Benutzername):')
    if (!username) return
    api('PUT', '/api/decnet/blocks/' + blockId, { username })
      .then(reload)
      .catch((e) => showError(e.message))
  }

  if (allocateBtn) {
    allocateBtn.onclick = () => {
      allocateBtn.disabled = true
      api('POST', '/api/decnet/blocks')
        .then(reload)
        .catch((e) => showError(e.message))
        .finally(() => (allocateBtn.disabled = false))
    }
  }

  if (adminForm) {
    adminForm.onsubmit = (e) => {
      e.preventDefault()
      const username = document.getElementById('admin-username').value
      const startNode = parseInt(document.getElementById('admin-start').value)
      const endNode = parseInt(document.getElementById('admin-end').value)
      api('POST', '/api/decnet/blocks', {
        username,
        start_node: startNode,
        end_node: endNode,
      })
        .then(() => {
          adminForm.reset()
          return reload()
        })
        .catch((e) => showError(e.message))
    }
  }

  reload().catch((e) => showError(e.message))
})()
