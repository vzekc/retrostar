// The message that tells a user their RetroStar account is set up: user
// name, password link and where to find the installation instructions.

const SITE_URL = 'https://retrostar.classic-computing.de'

const SUBJECT = 'Dein RetroStar-Zugang'

const formatTime = (time) =>
  time.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })

// user is a row of db.getUsers with a pending password reset key.
const accountMessage = (user) => `Hallo,

Dein RetroStar-Account wurde eingerichtet.

Dein Benutzername ist ${user.name} (Kleinbuchstaben).

Besuche diesen Link, um Dein Kennwort zu setzen:
${SITE_URL}/set-password?key=${user.password_reset_key}

Der Link ist bis ${formatTime(user.password_reset_key_expires_at)} gültig.

Danach meldest Du Dich auf ${SITE_URL}/ an. Unter "Installation" findest Du die Anleitung und Deinen Installationsschlüssel.`

module.exports = { SUBJECT, accountMessage, formatTime }
