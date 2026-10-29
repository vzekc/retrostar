// What /decnet and /decnet-gateway share for DECnet gateway clients: API
// calls, the connection line shown once, and a client's live status.
;(function () {
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

  function element(tag, props = {}, children = []) {
    const e = document.createElement(tag)
    Object.assign(e, props)
    children.forEach((c) =>
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    )
    return e
  }

  function download(line, name) {
    const blob = new Blob([line + '\n'], { type: 'text/plain' })
    const a = element('a', {
      href: URL.createObjectURL(blob),
      download: `${name.toLowerCase()}.dngw`,
    })
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // The connection line with its QR code and download: the only time the
  // key is shown.
  function issuedPanel({ client, line, qr_svg }) {
    const qr = element('div', { className: 'gw-qr' })
    qr.innerHTML = qr_svg
    const copy = element('button', {
      type: 'button',
      className: 'function',
      textContent: 'Kopieren',
    })
    copy.onclick = () => {
      navigator.clipboard?.writeText(line)
      copy.textContent = 'Kopiert'
    }
    const save = element('button', {
      type: 'button',
      className: 'function',
      textContent: 'Als .dngw-Datei herunterladen',
    })
    save.onclick = () => download(line, client.name)
    return element('div', { className: 'gw-issued' }, [
      element('h4', {
        textContent: `Verbindungszeile für ${client.name} (${client.address})`,
      }),
      element('p', {}, [
        element('strong', {
          textContent:
            'Diese Zeile enthält den Schlüssel und wird nur jetzt angezeigt.',
        }),
        ' RetroStar speichert ihn nicht. Trage sie im Client ein, lade sie ' +
          'als Datei herunter oder scanne den QR-Code. Geht sie verloren, ' +
          'erzeuge einen neuen Schlüssel.',
      ]),
      element('pre', { className: 'gw-line', textContent: line }),
      qr,
      element('p', { className: 'gw-buttons' }, [save, ' ', copy]),
    ])
  }

  // A client's live state at the gateway, as a list of label/value rows.
  function statusRows(client, s) {
    if (!s.known) {
      return [
        [
          'Gateway',
          'Kennt diesen Zugang nicht. Erzeuge einen neuen Schlüssel.',
        ],
      ]
    }
    const drops = s.drops || {}
    return [
      ['Verbindung', s.connected ? `verbunden von ${s.endpoint}` : 'getrennt'],
      ['Zuletzt verbunden', formatTime(client.last_seen)],
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
    ]
  }

  function rowsTable(rows) {
    return element(
      'table',
      { className: 'gw-facts' },
      rows.map(([label, value]) =>
        element('tr', {}, [
          element('th', { scope: 'row', textContent: label }),
          element('td', {}, [value]),
        ])
      )
    )
  }

  window.DNGW = {
    api,
    formatTime,
    element,
    download,
    issuedPanel,
    statusRows,
    rowsTable,
  }
})()
