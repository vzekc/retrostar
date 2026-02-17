;(function () {
  const user = window.DECNET_USER
  const isAdmin = user?.is_admin || false

  const blocksBody = document.getElementById('blocks-body')
  const allocateSection = document.getElementById('allocate-section')
  const allocateBtn = document.getElementById('allocate-btn')
  const errorMessage = document.getElementById('error-message')
  const adminForm = document.getElementById('admin-allocate-form')

  function showError(msg) {
    errorMessage.textContent = msg
    errorMessage.style.display = 'block'
    setTimeout(() => (errorMessage.style.display = 'none'), 5000)
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(path, opts)
    if (res.status === 204) return null
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`)
    }
    return data
  }

  function renderBlocks(blocks) {
    blocksBody.innerHTML = ''
    let userHasBlock = false

    blocks.forEach((block) => {
      const isOwner = user && block.user_id === user.id
      if (isOwner) userHasBlock = true

      const tr = document.createElement('tr')

      // Range
      const rangeTd = document.createElement('td')
      rangeTd.textContent = `23.${block.start_node}\u201323.${block.end_node}`
      tr.appendChild(rangeTd)

      // Owner
      const ownerTd = document.createElement('td')
      ownerTd.textContent = block.owner
      tr.appendChild(ownerTd)

      // Hosts
      const hostsTd = document.createElement('td')
      if (isOwner) {
        renderOwnedHosts(hostsTd, block)
      } else {
        renderReadOnlyHosts(hostsTd, block)
      }
      tr.appendChild(hostsTd)

      // Admin actions
      if (isAdmin) {
        const adminTd = document.createElement('td')
        adminTd.className = 'admin-actions'

        const deleteBtn = document.createElement('button')
        deleteBtn.textContent = 'Freigeben'
        deleteBtn.onclick = () => releaseBlock(block.id)
        adminTd.appendChild(deleteBtn)

        const reassignBtn = document.createElement('button')
        reassignBtn.textContent = 'Zuweisen'
        reassignBtn.onclick = () => reassignBlock(block.id)
        adminTd.appendChild(reassignBtn)

        tr.appendChild(adminTd)
      }

      blocksBody.appendChild(tr)
    })

    // Show allocate button only if user is logged in and has no block
    if (user && !userHasBlock && allocateSection) {
      allocateSection.style.display = 'block'
    } else if (allocateSection) {
      allocateSection.style.display = 'none'
    }
  }

  function renderReadOnlyHosts(td, block) {
    const hosts = block.hosts || []
    if (hosts.length === 0) {
      td.innerHTML = '<span style="color:#999">\u2014</span>'
      return
    }
    const div = document.createElement('div')
    div.className = 'host-list'
    hosts.forEach((h) => {
      const span = document.createElement('span')
      span.className = 'host-entry'
      span.innerHTML =
        '<span class="host-name">' +
        escapeHtml(h.name) +
        '</span> <span class="host-node">23.' +
        h.node_number +
        '</span>'
      div.appendChild(span)
    })
    td.appendChild(div)
  }

  function renderOwnedHosts(td, block) {
    const hosts = block.hosts || []
    const hostMap = {}
    hosts.forEach((h) => (hostMap[h.node_number] = h.name))

    const div = document.createElement('div')
    for (let n = block.start_node; n <= block.end_node; n++) {
      const btn = document.createElement('button')
      btn.className = 'node-btn'
      if (hostMap[n]) {
        btn.classList.add('named')
        btn.textContent = hostMap[n] + ' (23.' + n + ')'
        btn.title = 'Klicken zum Umbenennen, Rechtsklick zum Entfernen'
        btn.onclick = () => promptHostName(n, hostMap[n])
        btn.oncontextmenu = (e) => {
          e.preventDefault()
          removeHost(n, hostMap[n])
        }
      } else {
        btn.textContent = '23.' + n
        btn.title = 'Klicken zum Benennen'
        btn.onclick = () => promptHostName(n, '')
      }
      div.appendChild(btn)
    }
    td.appendChild(div)
  }

  function promptHostName(nodeNumber, currentName) {
    const name = prompt(
      'Hostname für 23.' +
        nodeNumber +
        ' (1-6 Zeichen, beginnt mit Buchstabe):',
      currentName
    )
    if (name === null) return
    if (name === '') {
      if (currentName) removeHost(nodeNumber, currentName)
      return
    }
    if (!/^[A-Za-z][A-Za-z0-9]{0,5}$/.test(name)) {
      showError(
        'Ungültiger Hostname. 1-6 Zeichen, muss mit Buchstabe beginnen, nur Buchstaben und Ziffern.'
      )
      return
    }
    api('PUT', '/api/decnet/hosts/' + nodeNumber, {
      name: name.toUpperCase(),
    })
      .then(() => loadBlocks())
      .catch((e) => showError(e.message))
  }

  function removeHost(nodeNumber, name) {
    if (!confirm('Hostname "' + name + '" für 23.' + nodeNumber + ' entfernen?'))
      return
    api('DELETE', '/api/decnet/hosts/' + nodeNumber)
      .then(() => loadBlocks())
      .catch((e) => showError(e.message))
  }

  function releaseBlock(blockId) {
    if (!confirm('Diesen Block wirklich freigeben? Alle Hostnamen werden gelöscht.'))
      return
    api('DELETE', '/api/decnet/blocks/' + blockId)
      .then(() => loadBlocks())
      .catch((e) => showError(e.message))
  }

  function reassignBlock(blockId) {
    const username = prompt('Neuer Besitzer (Benutzername):')
    if (!username) return
    api('PUT', '/api/decnet/blocks/' + blockId, { username })
      .then(() => loadBlocks())
      .catch((e) => showError(e.message))
  }

  function loadBlocks() {
    api('GET', '/api/decnet/blocks')
      .then((blocks) => renderBlocks(blocks))
      .catch((e) => showError(e.message))
  }

  if (allocateBtn) {
    allocateBtn.onclick = () => {
      allocateBtn.disabled = true
      api('POST', '/api/decnet/blocks')
        .then(() => loadBlocks())
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
          loadBlocks()
        })
        .catch((e) => showError(e.message))
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div')
    d.textContent = s
    return d.innerHTML
  }

  loadBlocks()
})()
