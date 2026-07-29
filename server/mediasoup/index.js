import * as mediasoup from 'mediasoup';
import { config } from '../../config/index.js';
import { Room } from './room.js';

/**
 * Gerencia o pool de workers mediasoup e os Rooms (um por canal de voz).
 * Workers são subprocessos C++; distribuímos os Routers entre eles em
 * round-robin para espalhar a carga de CPU entre os núcleos.
 */
class MediasoupServer {
  constructor() {
    this.workers = [];
    this.nextWorkerIndex = 0;
    /** @type {Map<string, Room>} channelId -> Room */
    this.rooms = new Map();
  }

  async init() {
    const { numWorkers, worker: workerConfig } = config.mediasoup;

    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: workerConfig.logLevel,
        logTags: workerConfig.logTags,
        rtcMinPort: workerConfig.rtcMinPort,
        rtcMaxPort: workerConfig.rtcMaxPort,
      });

      worker.on('died', () => {
        console.error(`[mediasoup] worker ${worker.pid} morreu. Encerrando em 2s...`);
        setTimeout(() => process.exit(1), 2000);
      });

      this.workers.push(worker);
    }

    console.log(`[mediasoup] ${this.workers.length} worker(s) iniciado(s).`);
  }

  nextWorker() {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  async getOrCreateRoom(channelId) {
    let room = this.rooms.get(channelId);
    if (room) return room;

    const worker = this.nextWorker();
    const router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
    room = new Room(channelId, router);
    this.rooms.set(channelId, room);
    console.log(`[mediasoup] room criada para canal ${channelId}`);
    return room;
  }

  getRoom(channelId) {
    return this.rooms.get(channelId);
  }

  /** Remove o peer do room; fecha o room se ficar vazio (libera CPU). */
  leaveRoom(channelId, peerId) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    room.removePeer(peerId);
    if (room.empty) {
      room.close();
      this.rooms.delete(channelId);
      console.log(`[mediasoup] room ${channelId} vazia, encerrada.`);
    }
  }
}

export const mediasoupServer = new MediasoupServer();
export default mediasoupServer;
