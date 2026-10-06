// The BREAK that returns the user to the terminal server's Local> prompt,
// sent as a binary frame so it stays apart from typed input.
const BREAK = new Uint8Array([0xff, 0xf3])

const connect = (host) => {
  console.log('connect to ' + host)

  document.querySelector('.choose-host').style.display = 'none'
  document.querySelector('.terminal-controls').style.display = 'block'

  const socket = new WebSocket(
    document.location.origin.replace(/^http/, 'ws') + `/ws/lat/${host}`
  )
  socket.binaryType = 'arraybuffer'

  socket.onmessage = (event) =>
    term.write(
      typeof event.data === 'string' ? event.data : new Uint8Array(event.data)
    )
  socket.onopen = () => console.log('Connected to ' + host)
  socket.onclose = () => {
    console.log('Disconnected')
    document.location = document.location
  }

  const term = new window.Terminal({
    cursorBlink: true,
    cols: 80,
    rows: 24,
  })

  const sendBreak = () => {
    socket.send(BREAK)
    term.focus()
  }

  term.parser.registerCsiHandler({ final: 'c' }, (params) => {
    socket.send('\x1b[?1c') // terminal is VT100
    return true
  })
  // Pause, or Ctrl-Pause (Cancel), is the BREAK key.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Pause' || e.key === 'Cancel') {
      if (e.type === 'keydown') {
        sendBreak()
      }
      return false
    }
    return true
  })
  term.open(document.getElementById('terminal'))
  term.onData((data) => socket.send(data))
  document.getElementById('break').onclick = sendBreak
  term.focus()
}
