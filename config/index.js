import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Descobre o primeiro IPv4 privado (192.168.x / 10.x / 172.16-31.x) das
 * interfaces de rede. É o endereço que os outros computadores da LAN usam
 * para acessar o servidor e para o mediasoup anunciar as portas RTP.
 */
function detectLanIp() {
  const preferPrefixes = ['192.168.', '10.', '172.'];
  const candidates = [];

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push(addr.address);
      }
    }
  }

  for (const prefix of preferPrefixes) {
    const match = candidates.find((ip) => ip.startsWith(prefix));
    if (match) return match;
  }

  return candidates[0] || '127.0.0.1';
}

const LAN_IP = process.env.ANNOUNCED_IP || detectLanIp();

// --- Bitrate de vídeo (tela e webcam) --------------------------------------
// Configurável via .env em Mbps. Vale para o compartilhamento de tela e para a
// webcam; o servidor envia estes valores ao cliente no join. Em LAN dá pra ser
// generoso; reduza VIDEO_MAX_MBPS em redes mais apertadas.
const MBPS = 1_000_000;
const VIDEO_BITRATE = {
  min: (Number(process.env.VIDEO_MIN_MBPS) || 2) * MBPS,
  max: (Number(process.env.VIDEO_MAX_MBPS) || 20) * MBPS,
  start: (Number(process.env.VIDEO_START_MBPS) || 5) * MBPS,
};

// --- TLS / HTTPS -----------------------------------------------------------
// O microfone (getUserMedia) só é liberado pelo navegador em "secure context":
// https:// ou localhost. Servindo por IP de LAN em http:// a voz nunca sai.
// Se os certs existirem, subimos HTTPS automaticamente. Gere com:
//   npm run gen-cert
// Desative forçando HTTP com TLS=0.
const CERT_DIR = process.env.CERT_DIR || path.join(ROOT, 'certs');
const TLS_CERT = process.env.TLS_CERT || path.join(CERT_DIR, 'cert.pem');
const TLS_KEY = process.env.TLS_KEY || path.join(CERT_DIR, 'key.pem');
const TLS_ENABLED =
  process.env.TLS !== '0' && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);

export const config = {
  root: ROOT,

  http: {
    // 0.0.0.0 = escuta em todas as interfaces, acessível por toda a LAN.
    host: process.env.HOST || '0.0.0.0',
    // Sem TLS: porta 80 (http). Com TLS: 443 (https). Ambas são "baixas" e
    // exigem setcap no binário do Node (ou root). Override: PORT=xxxx.
    port: Number(process.env.PORT) || (TLS_ENABLED ? 443 : 80),
    lanIp: LAN_IP,
    scheme: TLS_ENABLED ? 'https' : 'http',
  },

  tls: {
    enabled: TLS_ENABLED,
    dir: CERT_DIR,
    certPath: TLS_CERT,
    keyPath: TLS_KEY,
  },

  paths: {
    public: path.join(ROOT, 'public'),
    uploads: path.join(ROOT, 'uploads'),
    database: process.env.DB_PATH || path.join(ROOT, 'data', 'voice-chat.db'),
  },

  uploads: {
    maxFileSizeBytes: Number(process.env.MAX_UPLOAD_BYTES) || 25 * 1024 * 1024, // 25MB
    allowedMimePrefixes: ['image/', 'video/', 'audio/', 'text/', 'application/pdf'],
  },

  mediasoup: {
    // Quantos workers criar. Cada worker é um subprocesso C++ isolado.
    // Um por núcleo é o padrão recomendado; limitamos para não exagerar.
    numWorkers: Math.min(Number(process.env.MEDIASOUP_WORKERS) || os.cpus().length, os.cpus().length),

    // Bitrate de vídeo (bps) enviado ao cliente no join; usado por tela e webcam.
    videoBitrate: VIDEO_BITRATE,

    worker: {
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      // Faixa de portas RTP/RTCP usada por todos os transports WebRTC.
      rtcMinPort: Number(process.env.RTC_MIN_PORT) || 40000,
      rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 49999,
    },

    // Voz (Opus) + vídeo (VP8) para compartilhamento de tela. O áudio da tela
    // reutiliza o mesmo codec Opus; o vídeo usa VP8 (suporte universal, sem
    // tuning). Sem screen share ativo, nenhum producer de vídeo é criado.
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            // Habilita DTX e FEC para robustez em redes com perda de pacotes.
            useinbandfec: 1,
            usedtx: 1,
          },
        },
        // H264 primeiro: liga o encoder de HARDWARE na maioria das GPUs, o que
        // evita o gargalo de CPU do VP8 por software (que derrubava a resolução
        // para manter o framerate). VP8 fica como fallback.
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            // Level 5.2 (0x34): sem o teto de 720p do Level 3.1 (0x1f), que
            // fazia o encoder reduzir monitores 1080p/1440p/4K para 720p e
            // borrar a imagem em tela cheia. 5.2 libera até 4K.
            'profile-level-id': '42e034',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 5000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {},
        },
      ],
    },

    webRtcTransport: {
      // 'ip' = onde o socket UDP realmente escuta.
      // 'announcedIp' = o IP que enviamos ao cliente nos candidatos ICE.
      listenIps: [{ ip: '0.0.0.0', announcedIp: LAN_IP }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      // LAN: banda não é gargalo. Alinhado ao teto de vídeo do .env (com folga)
      // para o SFU não limitar tela/webcam (o que derrubava o framerate p/ ~1fps).
      initialAvailableOutgoingBitrate: VIDEO_BITRATE.max,
      maxIncomingBitrate: Math.round(VIDEO_BITRATE.max * 1.25),
    },
  },
};

export default config;
