### Installation

Hallo <%= user.username %>,

<% if (installKeys?.length) { %>

Für den Zugang zum RetroStar benötigst Du einen [Raspberry Pi](https://www.raspberrypi.org/products/) mit
Ethernet und WLAN. Er muss über WLAN mit dem Internet verbunden sein.

Die Installation des RetroStar-Zugangs geht bequem mit folgendem Befehl:

```shell
bash -c "$(curl -fsSL https://retrostar.classic-computing.de/install.sh)"
```

Er führt ein [Shell-Skript](/install.sh) aus, das die notwendigen Installationsschritte
durchführt.  Während der Installation wirst Du auch nach Deinem Kennwort gefragt.  Es
ist notwendig, damit die Änderungen an der Systemkonfiguration durchgeführt werden können.

Weiterhin wirst Du nach Deinem Installationsschlüssel gefragt, er lautet
`<%= (installKeys.length > 1) ? installKeys.map(({ install_key, config_name }) => `${install_key} (${config_name})`).join('\n') : installKey %>`

Beachte, dass die automatisierte Installation die Netzwerkeinstellungen des Pi
verändert. Insbesondere wird IPv6 abgeschaltet. Falls Du die Konfiguration lieber 
manuell durchführen möchtest, kannst Du Dir die OpenVPN-Konfigurationsdatei auch
herunterladen:

[https://retrostar.classic-computing.de/client-config/<%= installKey %>](/client-config/<%= installKey %>)

Bei der manuellen Konfiguration können wir Dir nur begrenzt helfen.

Schau Dir den [Quellcode](https://github.com/vzekc/retrostar/tree/main/packages/retrostar-client) an,
wenn Du wissen willst, wie RetroStar funktioniert.

Bitte beachte, dass wir keine Haftung für Schäden übernehmen, die durch die Nutzung
des RetroStar entstehen. Die Nutzung erfolgt auf eigene Gefahr.

<% } else { %>

für Dich ist noch kein Zugang zum RetroStar eingerichtet.

<% } %>
