const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')
const execFile = util.promisify(require('child_process').execFile)

// A CA laid out like ca/new-ca.sh does, signing with the repository's ca.cnf.
const makeCa = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrostar-ca-'))
  fs.copyFileSync(
    path.join(__dirname, '..', '..', '..', 'ca', 'ca.cnf'),
    path.join(dir, 'ca.cnf')
  )
  fs.mkdirSync(path.join(dir, 'data'))
  await execFile(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      'data/ca.key',
      '-out',
      'data/ca.crt',
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=RetroStar Test CA',
    ],
    { cwd: dir }
  )
  fs.writeFileSync(path.join(dir, 'data', 'ta.key'), 'test ta key\n')
  fs.writeFileSync(path.join(dir, 'data', 'index.txt'), '')
  fs.writeFileSync(path.join(dir, 'data', 'serial'), '000004AA\n')
  fs.writeFileSync(path.join(dir, 'data', 'crlnumber'), '1000\n')
  return dir
}

module.exports = { makeCa }
