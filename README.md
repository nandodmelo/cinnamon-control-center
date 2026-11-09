# Central de Controle para Cinnamon

Applet para o painel do **Linux Mint / Cinnamon** inspirado no Control Center do macOS Big Sur.

![Central de Controle](screenshot.png)

## Recursos

- **Wi‑Fi** – liga/desliga o rádio e mostra a rede conectada
- **Bluetooth** – liga/desliga o adaptador e mostra os dispositivos conectados (BlueZ via D‑Bus)
- **Rede** – status da conexão cabeada/primária (NetworkManager)
- **Não Perturbe** – silencia as notificações do Cinnamon
- **Luz Noturna** – ativa na hora, mesmo fora do horário agendado
- **Modo Escuro** – alterna tema GTK, ícones e tema do Cinnamon entre as variantes *Dark* e *Light* (ex.: WhiteSur)
- **Tela** – brilho do monitor externo via DDC/CI (`ddcutil`); clicando no título, troca a taxa de atualização (60/120/240 Hz…) de cada monitor
- **Som** – volume da saída padrão (PulseAudio/PipeWire), com rolagem do mouse; clicando no título, escolhe a saída de áudio
- **Tocando agora** – capa, título e controles de qualquer player MPRIS (Spotify, YouTube no navegador, VLC…); clicar na música traz o player para a frente

O visual segue automaticamente o tema claro/escuro.

## Instalação

```bash
git clone https://github.com/nandodmelo/cinnamon-control-center.git \
  ~/.local/share/cinnamon/applets/controlcenter@fernando
```

Depois: clique com o botão direito no painel → **Applets** → adicione **Central de Controle**.

### Brilho do monitor (opcional)

```bash
sudo apt install ddcutil
```

Faça logout/login e ative o DDC/CI no menu do monitor, se existir.

## Requisitos

Cinnamon 6.x, NetworkManager, BlueZ, PulseAudio ou PipeWire.
