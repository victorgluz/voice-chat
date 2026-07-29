import { config } from '../../config/index.js';

/**
 * Um Room corresponde a um canal de voz. Possui exatamente um Router
 * mediasoup e mantém o estado WebRTC de cada peer (participante):
 * transports, producers (áudio que o peer envia) e consumers (áudio
 * que o peer recebe dos outros).
 */
export class Room {
  constructor(id, router) {
    this.id = id;
    this.router = router;
    /** @type {Map<string, Peer>} peerId (socket.id) -> Peer */
    this.peers = new Map();
  }

  addPeer(peerId, user) {
    const peer = {
      id: peerId,
      user, // { id, name, avatar }
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    this.peers.set(peerId, peer);
    return peer;
  }

  getPeer(peerId) {
    return this.peers.get(peerId);
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  /** IDs de todos os producers de áudio de OUTROS peers. */
  otherProducers(peerId) {
    const list = [];
    for (const peer of this.peers.values()) {
      if (peer.id === peerId) continue;
      for (const producer of peer.producers.values()) {
        list.push({ producerId: producer.id, peerId: peer.id });
      }
    }
    return list;
  }

  async createWebRtcTransport() {
    const transport = await this.router.createWebRtcTransport({
      ...config.mediasoup.webRtcTransport,
      appData: {},
    });

    const max = config.mediasoup.webRtcTransport.maxIncomingBitrate;
    if (max) {
      try {
        await transport.setMaxIncomingBitrate(max);
      } catch {
        /* nem todo transport suporta; ignorar */
      }
    }

    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const consumer of peer.consumers.values()) safeClose(consumer);
    for (const producer of peer.producers.values()) safeClose(producer);
    for (const transport of peer.transports.values()) safeClose(transport);
    this.peers.delete(peerId);
  }

  get empty() {
    return this.peers.size === 0;
  }

  close() {
    for (const peerId of this.peers.keys()) this.removePeer(peerId);
    safeClose(this.router);
  }
}

function safeClose(resource) {
  try {
    if (resource && !resource.closed) resource.close();
  } catch {
    /* já fechado */
  }
}
