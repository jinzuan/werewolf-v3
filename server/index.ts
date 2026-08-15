import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { FileEventStore } from './events/fileStore';
import { FileRoomRepository } from './rooms/fileRepository';
import { RoomService } from './rooms/roomService';
import { FileInsightStore } from './review/insightStore';
import { FileReviewRepository } from './review/fileReviewRepository';
import { ReviewPipeline } from './review/reviewPipeline';
import { bindSocketTransport } from './transport/socketTransport';

const port = Number(process.env.PORT ?? 3001);
const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'werewolf-v3' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
});

const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
  },
});
const eventStore = new FileEventStore();
const reviewRepository = new FileReviewRepository();
const insightStore = new FileInsightStore();
const reviewPipeline = new ReviewPipeline(eventStore, reviewRepository, { insightStore });
const roomService = new RoomService(new FileRoomRepository(), eventStore, {
  // Mixed rooms hand computer turns back to the room service after each
  // human command. Quick computer rooms already opt into this path directly.
  autoDrive: true,
  reviewPipeline,
  insightStore,
});

await roomService.restore();
bindSocketTransport(io, roomService);

httpServer.listen(port, () => {
  console.log(`[server:v3] listening on http://127.0.0.1:${port}`);
});
